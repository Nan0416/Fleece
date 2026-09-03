import { Pool } from 'pg';
import { PgLedgerDao } from '../../src/data/pg-ledger-dao';
import { createAccount, createOrderGroup, createTestPool, describeIntegration, truncateAll } from './test-database';

describeIntegration('PgLedgerDao', () => {
  let pool: Pool;
  let dao: PgLedgerDao;

  beforeAll(async () => {
    pool = await createTestPool();
    dao = new PgLedgerDao(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    await createAccount(pool, 'ACCOUNT001');
  });

  const fill = (size: number, unitCost: number, at = Date.parse('2026-08-31T14:30:00Z')) =>
    dao.applyFill({
      referenceId: `order-${size}-${unitCost}`,
      accountId: 'ACCOUNT001',
      symbol: 'AAPL',
      transactionSize: size,
      transactionUnitCost: unitCost,
      timestamp: at,
    });

  describe('applyFill', () => {
    it('opens a position from nothing without needing one to exist first', async () => {
      const { position, transaction } = await fill(10, 150);
      expect(position.size).toBe(10);
      expect(position.avgPrice).toBe(150);
      expect(transaction.profit).toBeUndefined();
      expect(transaction.cumulativeSize).toBe(10);
    });

    it('averages the cost basis as the position is added to', async () => {
      await fill(10, 100);
      const { position } = await fill(30, 200);
      expect(position.size).toBe(40);
      expect(position.avgPrice).toBe(175);
    });

    it('records realised profit on the transaction and accumulates it on the profit row', async () => {
      await fill(10, 100);
      const first = await fill(-4, 150);
      expect(first.transaction.profit).toBe(200);
      expect(first.transaction.cumulativeProfit).toBe(200);

      const second = await fill(-2, 120);
      expect(second.transaction.profit).toBe(40);
      expect(second.transaction.cumulativeProfit).toBe(240);

      const { profit } = await dao.getProfit({ accountId: 'ACCOUNT001', symbol: 'AAPL' });
      expect(profit?.profit).toBe(240);
    });

    it('records return on the trade in basis points', async () => {
      await fill(10, 100);
      const { transaction } = await fill(-4, 150);
      // 200 realised on a notional of 4 * 150 = 600, which is 3333.33 bps.
      expect(transaction.roi).toBe(3333.33);
    });

    it('writes no profit row until a position is first reduced', async () => {
      await fill(10, 100);
      const before = await dao.getProfit({ accountId: 'ACCOUNT001', symbol: 'AAPL' });
      expect(before.profit).toBeNull();

      await fill(-1, 110);
      const after = await dao.getProfit({ accountId: 'ACCOUNT001', symbol: 'AAPL' });
      expect(after.profit?.profit).toBe(10);
    });

    it('resets the cost basis when a position closes, so the next fill opens rather than averages', async () => {
      await fill(10, 100);
      await fill(-10, 150);
      const closed = await dao.getPosition({ accountId: 'ACCOUNT001', symbol: 'AAPL' });
      expect(closed.position?.size).toBe(0);
      expect(closed.position?.avgPrice).toBe(0);

      const { position } = await fill(5, 80);
      expect(position.avgPrice).toBe(80);
    });

    it('keeps a closed position out of a listing unless it is asked for', async () => {
      await fill(10, 100);
      await fill(-10, 150);
      const open = await dao.listPositions({ accountId: 'ACCOUNT001', includeClosed: false });
      expect(open.positions).toHaveLength(0);
      const all = await dao.listPositions({ accountId: 'ACCOUNT001', includeClosed: true });
      expect(all.positions).toHaveLength(1);
    });
  });

  describe('applyCumulativeFill', () => {
    const report = (cumulativeSize: number, cumulativeAvgPrice: number, at = Date.parse('2026-08-31T14:30:00Z')) =>
      dao.applyCumulativeFill({
        referenceId: 'broker-order-1',
        accountId: 'ACCOUNT001',
        symbol: 'AAPL',
        cumulativeFilledSize: cumulativeSize,
        cumulativeFilledAvgPrice: cumulativeAvgPrice,
        timestamp: at,
      });

    it('records only what is new as an order fills in pieces', async () => {
      const first = await report(4, 100);
      expect(first.transaction?.size).toBe(4);

      // 4 at 100 then 6 more at 110 is 10 at 106 cumulative; only the 6 is new.
      const second = await report(10, 106);
      expect(second.transaction?.size).toBe(6);
      expect(second.transaction?.avgPrice).toBe(110);

      const { position } = await dao.getPosition({ accountId: 'ACCOUNT001', symbol: 'AAPL' });
      expect(position?.size).toBe(10);
      expect(position?.avgPrice).toBe(106);
    });

    it('adds nothing when the same report arrives twice', async () => {
      await report(10, 100);
      const duplicate = await report(10, 100);
      expect(duplicate.transaction).toBeNull();

      const { position } = await dao.getPosition({ accountId: 'ACCOUNT001', symbol: 'AAPL' });
      expect(position?.size).toBe(10);
    });

    it('adds nothing when a terminal report repeats a completed fill', async () => {
      // The legacy injector dropped its in-memory tally on a terminal status, so a
      // `filled` event delivered by both the websocket and the REST backfill applied
      // the whole order a second time.
      await report(5, 100);
      await report(10, 105);
      const replay = await report(10, 105);
      expect(replay.transaction).toBeNull();

      const { position } = await dao.getPosition({ accountId: 'ACCOUNT001', symbol: 'AAPL' });
      expect(position?.size).toBe(10);
      expect(position?.avgPrice).toBe(105);
    });

    it('picks up mid-order where it left off, as it would after a restart', async () => {
      // Nothing is held in memory between calls, so a fresh DAO — standing in for a
      // restarted process — resumes from what the ledger already records.
      await report(4, 100);
      const restarted = new PgLedgerDao(pool);
      const { transaction } = await restarted.applyCumulativeFill({
        referenceId: 'broker-order-1',
        accountId: 'ACCOUNT001',
        symbol: 'AAPL',
        cumulativeFilledSize: 10,
        cumulativeFilledAvgPrice: 106,
        timestamp: Date.parse('2026-08-31T14:31:00Z'),
      });
      expect(transaction?.size).toBe(6);

      const { position } = await dao.getPosition({ accountId: 'ACCOUNT001', symbol: 'AAPL' });
      expect(position?.size).toBe(10);
    });

    it('applies a duplicate report exactly once when both arrive at the same moment', async () => {
      const [first, second] = await Promise.all([report(10, 100), report(10, 100)]);
      const recorded = [first, second].filter((result) => result.transaction !== null);
      expect(recorded).toHaveLength(1);

      const { position } = await dao.getPosition({ accountId: 'ACCOUNT001', symbol: 'AAPL' });
      expect(position?.size).toBe(10);
    });

    it('keeps a sell reported cumulatively negative throughout', async () => {
      await fill(20, 100);
      const first = await report(-5, 120);
      expect(first.transaction?.size).toBe(-5);
      const second = await report(-12, 125);
      expect(second.transaction?.size).toBe(-7);

      const { position } = await dao.getPosition({ accountId: 'ACCOUNT001', symbol: 'AAPL' });
      expect(position?.size).toBe(8);
    });
  });

  describe('concurrent fills against the same position', () => {
    it('applies every one of them, losing none', async () => {
      // The whole reason the write path takes a row lock. Each of these reads the
      // position, computes a new one from it and writes it back; without the lock the
      // reads interleave and the last write wins, silently discarding the rest.
      const fills = Array.from({ length: 25 }, (_unused, index) =>
        dao.applyFill({
          referenceId: `concurrent-${index}`,
          accountId: 'ACCOUNT001',
          symbol: 'AAPL',
          transactionSize: 2,
          transactionUnitCost: 100,
          timestamp: Date.parse('2026-08-31T14:30:00Z') + index,
        }),
      );
      await Promise.all(fills);

      const { position } = await dao.getPosition({ accountId: 'ACCOUNT001', symbol: 'AAPL' });
      expect(position?.size).toBe(50);
      expect(position?.avgPrice).toBe(100);
    });

    it('leaves the running profit total equal to the sum of what each fill realised', async () => {
      await fill(100, 100);
      const reductions = Array.from({ length: 20 }, (_unused, index) =>
        dao.applyFill({
          referenceId: `reduce-${index}`,
          accountId: 'ACCOUNT001',
          symbol: 'AAPL',
          transactionSize: -1,
          transactionUnitCost: 110,
          timestamp: Date.parse('2026-08-31T15:00:00Z') + index,
        }),
      );
      await Promise.all(reductions);

      const { profit } = await dao.getProfit({ accountId: 'ACCOUNT001', symbol: 'AAPL' });
      // Each of the 20 reductions realises 1 * (110 - 100).
      expect(profit?.profit).toBe(200);

      const { transactions } = await dao.listTransactions({ accountId: 'ACCOUNT001', symbol: 'AAPL', from: 0, limit: 100, sort: 'asc' });
      const realised = transactions.reduce((total, transaction) => total + (transaction.profit ?? 0), 0);
      expect(realised).toBe(200);
    });
  });

  describe('listHistoricalPositions', () => {
    it('projects the position history out of the transaction log', async () => {
      const base = Date.parse('2026-08-31T14:30:00Z');
      await fill(10, 100, base);
      await fill(5, 110, base + 1000);
      await fill(-3, 120, base + 2000);

      const { positions } = await dao.listHistoricalPositions({ accountId: 'ACCOUNT001', symbol: 'AAPL', from: 0, limit: 10, sort: 'asc' });
      expect(positions.map((position) => position.size)).toEqual([10, 15, 12]);
    });

    it('pages backwards from a timestamp when sorting descending', async () => {
      const base = Date.parse('2026-08-31T14:30:00Z');
      await fill(10, 100, base);
      await fill(5, 110, base + 1000);
      await fill(-3, 120, base + 2000);

      const { positions } = await dao.listHistoricalPositions({ accountId: 'ACCOUNT001', symbol: 'AAPL', from: base + 1500, limit: 10, sort: 'desc' });
      expect(positions.map((position) => position.size)).toEqual([15, 10]);
    });
  });

  describe('applyStockSplit', () => {
    it('multiplies the share count and divides the cost basis', async () => {
      await fill(10, 150);
      const { position } = await dao.applyStockSplit({ accountId: 'ACCOUNT001', symbol: 'AAPL', ratio: 2 });
      expect(position?.size).toBe(20);
      expect(position?.avgPrice).toBe(75);
    });

    it('rounds fractional share counts to whole shares', async () => {
      await fill(11, 90);
      const { position } = await dao.applyStockSplit({ accountId: 'ACCOUNT001', symbol: 'AAPL', ratio: 1.5 });
      expect(position?.size).toBe(17);
      expect(position?.avgPrice).toBe(60);
    });

    it('reports nothing to do for a symbol the account has never held', async () => {
      const { position } = await dao.applyStockSplit({ accountId: 'ACCOUNT001', symbol: 'TSLA', ratio: 2 });
      expect(position).toBeNull();
    });
  });

  describe('transferPosition', () => {
    beforeEach(async () => {
      await createAccount(pool, 'ACCOUNT002');
      await createOrderGroup(pool, 'group-origin', 'ACCOUNT001');
      await createOrderGroup(pool, 'group-destination', 'ACCOUNT002');
      await fill(10, 100);
    });

    const transfer = (shares: number, unitCost: number) =>
      dao.transferPosition({
        symbol: 'AAPL',
        unitCost,
        shares,
        timestamp: Date.parse('2026-08-31T16:00:00Z'),
        brokerAccountId: 'Q-0001',
        origin: { accountId: 'ACCOUNT001', groupId: 'group-origin', orderId: 'transfer-out', record: { id: 'transfer-out' } },
        destination: { accountId: 'ACCOUNT002', groupId: 'group-destination', orderId: 'transfer-in', record: { id: 'transfer-in' } },
      });

    it('moves the shares out of one account and into the other', async () => {
      await transfer(4, 120);
      const origin = await dao.getPosition({ accountId: 'ACCOUNT001', symbol: 'AAPL' });
      const destination = await dao.getPosition({ accountId: 'ACCOUNT002', symbol: 'AAPL' });
      expect(origin.position?.size).toBe(6);
      expect(destination.position?.size).toBe(4);
    });

    it('realises profit on the sending side and sets the cost basis on the receiving side', async () => {
      const { originTransaction, destinationTransaction } = await transfer(4, 120);
      expect(originTransaction.profit).toBe(80);
      expect(destinationTransaction.profit).toBeUndefined();

      const destination = await dao.getPosition({ accountId: 'ACCOUNT002', symbol: 'AAPL' });
      expect(destination.position?.avgPrice).toBe(120);
    });

    it('writes a matched pair of synthetic orders and their records', async () => {
      await transfer(4, 120);
      const orders = await pool.query('SELECT broker_order_id, account_id, broker, group_id FROM broker_order ORDER BY broker_order_id');
      expect(orders.rows).toHaveLength(2);
      expect(orders.rows.every((row) => row.broker === 'traderq')).toBe(true);

      const records = await pool.query('SELECT broker_order_id FROM broker_order_record ORDER BY broker_order_id');
      expect(records.rows.map((row) => row.broker_order_id)).toEqual(['transfer-in', 'transfer-out']);
    });

    it('leaves neither side changed when the transfer cannot complete', async () => {
      // A group that does not exist fails the foreign key on the destination order,
      // after the origin side has already been written inside the transaction. Shares
      // must not go missing.
      await expect(
        dao.transferPosition({
          symbol: 'AAPL',
          unitCost: 120,
          shares: 4,
          timestamp: Date.parse('2026-08-31T16:00:00Z'),
          brokerAccountId: 'Q-0001',
          origin: { accountId: 'ACCOUNT001', groupId: 'group-origin', orderId: 'transfer-out', record: { id: 'transfer-out' } },
          destination: { accountId: 'ACCOUNT002', groupId: 'no-such-group', orderId: 'transfer-in', record: { id: 'transfer-in' } },
        }),
      ).rejects.toThrow();

      const origin = await dao.getPosition({ accountId: 'ACCOUNT001', symbol: 'AAPL' });
      const destination = await dao.getPosition({ accountId: 'ACCOUNT002', symbol: 'AAPL' });
      expect(origin.position?.size).toBe(10);
      expect(destination.position).toBeNull();

      const orders = await pool.query('SELECT broker_order_id FROM broker_order');
      expect(orders.rows).toHaveLength(0);
    });
  });
});
