import { AssetClass, Decimal } from '@fleece/shared';
import { Pool } from 'pg';
import { PgLedgerDao } from '../../src/data/pg-ledger-dao';
import { createAccount, createBrokerOrder, createTestPool, describeIntegration, truncateAll } from './test-database';

const d = (value: string | number): Decimal => Decimal.of(value);

describeIntegration('PgLedgerDao', () => {
  let pool: Pool;
  let dao: PgLedgerDao;

  beforeAll(async () => {
    pool = await createTestPool('test_pg_ledger_dao');
    dao = new PgLedgerDao(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    await createAccount(pool, 'ACCOUNT001');
  });

  /**
   * Most cases read more naturally as a size and a price, but the ledger accounts in
   * total cost, so the helpers multiply once here rather than everywhere below.
   */
  const fill = (size: number, unitCost: number, at = Date.parse('2026-08-31T14:30:00Z')) =>
    dao.applyFill({
      referenceId: `order-${size}-${unitCost}`,
      accountId: 'ACCOUNT001',
      symbol: 'AAPL',
      assetClass: 'equity',
      multiplier: Decimal.ONE,
      transactionSize: d(size),
      transactionTotalCost: d(size).mul(d(unitCost)),
      timestamp: at,
    });

  describe('applyFill', () => {
    it('opens a position from nothing without needing one to exist first', async () => {
      const { position, transaction } = await fill(10, 150);
      expect(position.size.toString()).toBe('10');
      expect(position.totalCost.toString()).toBe('1500');
      expect(transaction.profit).toBeUndefined();
      expect(transaction.cumulativeSize.toString()).toBe('10');
    });

    it('averages the cost basis as the position is added to, without ever storing one', async () => {
      await fill(10, 100);
      const { position } = await fill(30, 200);
      expect(position.size.toString()).toBe('40');
      expect(position.totalCost.toString()).toBe('7000');
      // Derived on read from the two columns above.
      expect(position.avgPrice.toString()).toBe('175');
    });

    it('records realised profit on the transaction and accumulates it on the profit row', async () => {
      await fill(10, 100);
      const first = await fill(-4, 150);
      expect(first.transaction.profit?.toString()).toBe('200');
      expect(first.transaction.cumulativeProfit.toString()).toBe('200');

      const second = await fill(-2, 120);
      expect(second.transaction.profit?.toString()).toBe('40');
      expect(second.transaction.cumulativeProfit.toString()).toBe('240');

      const { profit } = await dao.getProfit({ accountId: 'ACCOUNT001', symbol: 'AAPL' });
      expect(profit?.profit.toString()).toBe('240');
    });

    it('derives return on the trade in basis points rather than storing it', async () => {
      await fill(10, 100);
      const { transaction } = await fill(-4, 150);
      // 200 realised on a notional of 600.
      expect(transaction.roi?.toString()).toBe('3333.33');
    });

    it('writes no profit row until a position is first reduced', async () => {
      await fill(10, 100);
      expect((await dao.getProfit({ accountId: 'ACCOUNT001', symbol: 'AAPL' })).profit).toBeNull();
      await fill(-1, 110);
      expect((await dao.getProfit({ accountId: 'ACCOUNT001', symbol: 'AAPL' })).profit).not.toBeNull();
    });

    it('retires the whole basis when a position closes, so the next fill opens rather than averages', async () => {
      await fill(10, 100);
      const closed = await fill(-10, 130);
      expect(closed.position.size.toString()).toBe('0');
      expect(closed.position.totalCost.toString()).toBe('0');

      const reopened = await fill(5, 90);
      expect(reopened.position.totalCost.toString()).toBe('450');
      expect(reopened.position.avgPrice.toString()).toBe('90');
    });

    it('keeps a closed position out of a listing unless it is asked for', async () => {
      await fill(10, 100);
      await fill(-10, 130);
      expect((await dao.listPositions({ accountId: 'ACCOUNT001', includeClosed: false })).positions).toHaveLength(0);
      expect((await dao.listPositions({ accountId: 'ACCOUNT001', includeClosed: true })).positions).toHaveLength(1);
    });

    it('holds a fractional size and a basis that does not divide evenly', async () => {
      await dao.applyFill({
        referenceId: 'fractional',
        accountId: 'ACCOUNT001',
        symbol: 'AAPL',
        assetClass: 'equity',
        multiplier: Decimal.ONE,
        transactionSize: d('0.333333333'),
        transactionTotalCost: d('50'),
        timestamp: Date.parse('2026-08-31T14:30:00Z'),
      });
      const { position } = await dao.getPosition({ accountId: 'ACCOUNT001', symbol: 'AAPL' });
      expect(position?.size.toString()).toBe('0.333333333');
      expect(position?.totalCost.toString()).toBe('50');
    });
  });

  describe('applyCumulativeFill', () => {
    const report = (cumulativeSize: number, cumulativeAvgPrice: number, at = Date.parse('2026-08-31T14:30:00Z')) =>
      dao.applyCumulativeFill({
        referenceId: 'broker-order-1',
        accountId: 'ACCOUNT001',
        symbol: 'AAPL',
        assetClass: 'equity',
        multiplier: Decimal.ONE,
        cumulativeFilledSize: d(cumulativeSize),
        cumulativeFilledTotalCost: d(cumulativeSize).mul(d(cumulativeAvgPrice)),
        timestamp: at,
      });

    it('records only what is new as an order fills in pieces', async () => {
      const first = await report(4, 100);
      expect(first.transaction?.size.toString()).toBe('4');

      // 4 at 100 then 6 more at 110 is 10 at 106 cumulative; only the 6 is new.
      const second = await report(10, 106);
      expect(second.transaction?.size.toString()).toBe('6');
      expect(second.transaction?.avgPrice.toString()).toBe('110');

      const { position } = await dao.getPosition({ accountId: 'ACCOUNT001', symbol: 'AAPL' });
      expect(position?.size.toString()).toBe('10');
      expect(position?.avgPrice.toString()).toBe('106');
    });

    it('adds nothing when the same report arrives twice', async () => {
      await report(10, 100);
      const duplicate = await report(10, 100);
      expect(duplicate.transaction).toBeNull();

      const { position } = await dao.getPosition({ accountId: 'ACCOUNT001', symbol: 'AAPL' });
      expect(position?.size.toString()).toBe('10');
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
      expect(position?.size.toString()).toBe('10');
      expect(position?.avgPrice.toString()).toBe('105');
    });

    it('picks up mid-order where it left off, as it would after a restart', async () => {
      // Nothing is held in memory between calls: the applied total lives in
      // `order_fill_progress`, so a fresh DAO — standing in for a restarted process —
      // resumes from what the ledger already records.
      await report(4, 100);
      const restarted = new PgLedgerDao(pool);
      const { transaction } = await restarted.applyCumulativeFill({
        referenceId: 'broker-order-1',
        accountId: 'ACCOUNT001',
        symbol: 'AAPL',
        assetClass: 'equity',
        multiplier: Decimal.ONE,
        cumulativeFilledSize: d(10),
        cumulativeFilledTotalCost: d(1060),
        timestamp: Date.parse('2026-08-31T14:31:00Z'),
      });
      expect(transaction?.size.toString()).toBe('6');

      const { position } = await dao.getPosition({ accountId: 'ACCOUNT001', symbol: 'AAPL' });
      expect(position?.size.toString()).toBe('10');
    });

    it('applies a duplicate report exactly once when both arrive at the same moment', async () => {
      const [first, second] = await Promise.all([report(10, 100), report(10, 100)]);
      const recorded = [first, second].filter((result) => result.transaction !== null);
      expect(recorded).toHaveLength(1);

      const { position } = await dao.getPosition({ accountId: 'ACCOUNT001', symbol: 'AAPL' });
      expect(position?.size.toString()).toBe('10');
    });

    it('keeps a sell reported cumulatively negative throughout', async () => {
      await fill(20, 100);
      const first = await report(-5, 120);
      expect(first.transaction?.size.toString()).toBe('-5');
      const second = await report(-12, 125);
      expect(second.transaction?.size.toString()).toBe('-7');

      const { position } = await dao.getPosition({ accountId: 'ACCOUNT001', symbol: 'AAPL' });
      expect(position?.size.toString()).toBe('8');
    });
  });

  describe('order fill progress', () => {
    it('advances by exactly what each transaction records', async () => {
      await dao.applyCumulativeFill({
        referenceId: 'broker-order-1',
        accountId: 'ACCOUNT001',
        symbol: 'AAPL',
        assetClass: 'equity',
        multiplier: Decimal.ONE,
        cumulativeFilledSize: d(10),
        cumulativeFilledTotalCost: d(1060),
        timestamp: Date.parse('2026-08-31T14:30:00Z'),
      });

      const { progress } = await dao.getOrderFillProgress({ referenceId: 'broker-order-1' });
      expect(progress[0].appliedSize.toString()).toBe('10');
      expect(progress[0].appliedTotalCost.toString()).toBe('1060');
    });

    it('agrees with the transaction log it counts', async () => {
      await fill(10, 100);
      await fill(-4, 130);
      const { checked, discrepancies } = await dao.reconcileOrderFillProgress({ accountId: 'ACCOUNT001' });
      expect(checked).toBe(2);
      expect(discrepancies).toHaveLength(0);
    });

    it('reports a counter that has drifted away from the log', async () => {
      // Storing the applied total made drift *possible* where summing it made drift
      // impossible. This is the check that says so — and it has to fail when the two
      // disagree, or it is decoration.
      await fill(10, 100);
      await pool.query("UPDATE order_fill_progress SET applied_size = applied_size + 1 WHERE reference_id = 'order-10-100'");

      const { discrepancies } = await dao.reconcileOrderFillProgress({ accountId: 'ACCOUNT001' });
      expect(discrepancies).toHaveLength(1);
      expect(discrepancies[0].storedSize.toString()).toBe('11');
      expect(discrepancies[0].summedSize.toString()).toBe('10');
    });

    it('reports transactions that no counter accounts for', async () => {
      await fill(10, 100);
      await pool.query("DELETE FROM order_fill_progress WHERE reference_id = 'order-10-100'");

      const { discrepancies } = await dao.reconcileOrderFillProgress({ accountId: 'ACCOUNT001' });
      expect(discrepancies).toHaveLength(1);
      expect(discrepancies[0].storedSize.toString()).toBe('0');
      expect(discrepancies[0].summedSize.toString()).toBe('10');
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
          assetClass: 'equity',
          multiplier: Decimal.ONE,
          transactionSize: d(2),
          transactionTotalCost: d(200),
          timestamp: Date.parse('2026-08-31T14:30:00Z') + index,
        }),
      );
      await Promise.all(fills);

      const { position } = await dao.getPosition({ accountId: 'ACCOUNT001', symbol: 'AAPL' });
      expect(position?.size.toString()).toBe('50');
      expect(position?.avgPrice.toString()).toBe('100');
    });

    it('leaves the running profit total equal to the sum of what each fill realised', async () => {
      await fill(100, 100);
      const reductions = Array.from({ length: 20 }, (_unused, index) =>
        dao.applyFill({
          referenceId: `reduce-${index}`,
          accountId: 'ACCOUNT001',
          symbol: 'AAPL',
          assetClass: 'equity',
          multiplier: Decimal.ONE,
          transactionSize: d(-1),
          transactionTotalCost: d(-110),
          timestamp: Date.parse('2026-08-31T15:00:00Z') + index,
        }),
      );
      await Promise.all(reductions);

      const { profit } = await dao.getProfit({ accountId: 'ACCOUNT001', symbol: 'AAPL' });
      // Each of the 20 reductions realises 1 * (110 - 100).
      expect(profit?.profit.toString()).toBe('200');

      const { transactions } = await dao.listTransactions({ accountId: 'ACCOUNT001', symbol: 'AAPL', from: 0, limit: 100, sort: 'asc' });
      const realised = transactions.reduce((total, transaction) => total.add(transaction.profit ?? Decimal.ZERO), Decimal.ZERO);
      expect(realised.toString()).toBe('200');
    });
  });

  describe('conservation', () => {
    /**
     * `position.total_cost == sum(total_cost) + sum(profit)`, per account and symbol.
     *
     * Asserted in SQL rather than in TypeScript so that it checks what is actually
     * stored, and exactly rather than within a tolerance — which is the point of the
     * columns being NUMERIC and the accounting being in total cost.
     */
    const residuals = async (): Promise<ReadonlyArray<string>> => {
      const result = await pool.query<{ residual: string }>(
        `SELECT p.total_cost - (COALESCE(SUM(t.total_cost), 0) + COALESCE(SUM(t.profit), 0)) AS residual
           FROM position p LEFT JOIN ledger_transaction t ON t.account_id = p.account_id AND t.symbol = p.symbol
          GROUP BY p.account_id, p.symbol, p.total_cost`,
      );
      return result.rows.map((row) => Decimal.parse(row.residual, 'residual').toString());
    };

    it('holds after a basis is apportioned across partial sales that do not divide evenly', async () => {
      await fill(3, 333.33);
      await fill(-1, 340);
      await fill(-1, 330);
      expect(await residuals()).toEqual(['0']);
    });

    it('holds after a position is carried through zero', async () => {
      await fill(10, 100);
      await fill(-15, 110);
      expect(await residuals()).toEqual(['0']);
    });

    it('holds after a split, which changes the size and not the basis', async () => {
      await fill(3, 333.33);
      await fill(-1, 340);
      await dao.applyStockSplit({ accountId: 'ACCOUNT001', symbol: 'AAPL', ratio: d(3) });
      expect(await residuals()).toEqual(['0']);
    });
  });

  describe('asset classes', () => {
    const optionFill = (contracts: number, premium: number) =>
      dao.applyFill({
        referenceId: `option-${contracts}`,
        accountId: 'ACCOUNT001',
        symbol: 'AAPL251219C00150000',
        assetClass: 'option',
        multiplier: d(100),
        transactionSize: d(contracts),
        // The injector is what turns a quoted premium into dollars, because it is what
        // knows the multiplier. By the time it reaches here the conversion has happened.
        transactionTotalCost: d(contracts).mul(d(premium)).mul(d(100)),
        timestamp: Date.parse('2026-08-31T14:30:00Z'),
      });

    it('counts an option in contracts and carries its dollars in the total cost', async () => {
      const { position } = await optionFill(2, 3.85);
      expect(position.size.toString()).toBe('2');
      expect(position.totalCost.toString()).toBe('770');
    });

    it('reports both the cost per contract and the premium a broker would quote', async () => {
      const { position } = await optionFill(2, 3.85);
      expect(position.avgPrice.toString()).toBe('385');
      expect(position.premium.toString()).toBe('3.85');
    });

    it('records the multiplier it used, so a contract booked on a wrong assumption is findable', async () => {
      const { transaction } = await optionFill(2, 3.85);
      expect(transaction.multiplier.toString()).toBe('100');
    });

    it('totals an account holding both stock and options without anything having to know which is which', async () => {
      await fill(10, 100);
      await optionFill(2, 3.85);
      const { positions } = await dao.listPositions({ accountId: 'ACCOUNT001', includeClosed: false });
      const totalCost = positions.reduce((total, position) => total.add(position.totalCost), Decimal.ZERO);
      expect(totalCost.toString()).toBe('1770');
    });

    it('lists one asset class at a time', async () => {
      await fill(10, 100);
      await optionFill(2, 3.85);
      for (const [assetClass, expected] of [
        ['option', 'AAPL251219C00150000'],
        ['equity', 'AAPL'],
      ] as ReadonlyArray<readonly [AssetClass, string]>) {
        const { positions } = await dao.listPositions({ accountId: 'ACCOUNT001', includeClosed: false, assetClass });
        expect(positions.map((position) => position.symbol)).toEqual([expected]);
      }
    });
  });

  describe('listHistoricalPositions', () => {
    it('projects the position history out of the transaction log', async () => {
      const base = Date.parse('2026-08-31T14:30:00Z');
      await fill(10, 100, base);
      await fill(5, 110, base + 1000);
      await fill(-3, 120, base + 2000);

      const { positions } = await dao.listHistoricalPositions({ accountId: 'ACCOUNT001', symbol: 'AAPL', from: 0, limit: 10, sort: 'asc' });
      expect(positions.map((position) => position.size.toString())).toEqual(['10', '15', '12']);
    });

    it('pages backwards from a timestamp when sorting descending', async () => {
      const base = Date.parse('2026-08-31T14:30:00Z');
      await fill(10, 100, base);
      await fill(5, 110, base + 1000);
      await fill(-3, 120, base + 2000);

      const { positions } = await dao.listHistoricalPositions({ accountId: 'ACCOUNT001', symbol: 'AAPL', from: base + 1500, limit: 10, sort: 'desc' });
      expect(positions.map((position) => position.size.toString())).toEqual(['15', '10']);
    });
  });

  describe('applyStockSplit', () => {
    it('multiplies the unit count and leaves the basis exactly alone', async () => {
      await fill(10, 150);
      const { position } = await dao.applyStockSplit({ accountId: 'ACCOUNT001', symbol: 'AAPL', ratio: d(2) });
      expect(position?.size.toString()).toBe('20');
      // A split does not change what was paid, so the cost is untouched and the unit
      // price falls out of the new size. One multiplication, and no chance of a rounded
      // size disagreeing with a rounded price about the ratio.
      expect(position?.totalCost.toString()).toBe('1500');
      expect(position?.avgPrice.toString()).toBe('75');
    });

    it('keeps a fractional unit count rather than rounding it away', async () => {
      await fill(11, 90);
      const { position } = await dao.applyStockSplit({ accountId: 'ACCOUNT001', symbol: 'AAPL', ratio: d('1.5') });
      expect(position?.size.toString()).toBe('16.5');
      expect(position?.totalCost.toString()).toBe('990');
      expect(position?.avgPrice.toString()).toBe('60');
    });

    it('reports nothing to do for a symbol the account has never held', async () => {
      const { position } = await dao.applyStockSplit({ accountId: 'ACCOUNT001', symbol: 'TSLA', ratio: d(2) });
      expect(position).toBeNull();
    });
  });

  describe('transferPosition', () => {
    beforeEach(async () => {
      await createAccount(pool, 'ACCOUNT002');
      await fill(10, 100);
    });

    const transfer = (size: number, unitCost: number, destinationOrderId = 'transfer-in') =>
      dao.transferPosition({
        symbol: 'AAPL',
        assetClass: 'equity',
        multiplier: Decimal.ONE,
        size: d(size),
        totalCost: d(size).mul(d(unitCost)),
        timestamp: Date.parse('2026-08-31T16:00:00Z'),
        brokerAccountId: 'Q-0001',
        origin: { accountId: 'ACCOUNT001', orderId: 'transfer-out', record: { id: 'transfer-out' } },
        destination: { accountId: 'ACCOUNT002', orderId: destinationOrderId, record: { id: destinationOrderId } },
      });

    it('moves the units out of one account and into the other', async () => {
      await transfer(4, 120);
      const origin = await dao.getPosition({ accountId: 'ACCOUNT001', symbol: 'AAPL' });
      const destination = await dao.getPosition({ accountId: 'ACCOUNT002', symbol: 'AAPL' });
      expect(origin.position?.size.toString()).toBe('6');
      expect(destination.position?.size.toString()).toBe('4');
    });

    it('realises profit on the sending side and sets the cost basis on the receiving side', async () => {
      const { originTransaction, destinationTransaction } = await transfer(4, 120);
      expect(originTransaction.profit?.toString()).toBe('80');
      expect(destinationTransaction.profit).toBeUndefined();

      const destination = await dao.getPosition({ accountId: 'ACCOUNT002', symbol: 'AAPL' });
      expect(destination.position?.avgPrice.toString()).toBe('120');
    });

    it('writes a matched pair of synthetic orders and their records', async () => {
      await transfer(4, 120);
      const orders = await pool.query('SELECT broker_order_id, account_id, broker, attribution FROM broker_order ORDER BY broker_order_id');
      expect(orders.rows).toHaveLength(2);
      expect(orders.rows.every((row) => row.broker === 'traderq')).toBe(true);
      // The ledger wrote these itself; their accounts are named by construction rather
      // than inferred, which is what `internal` records.
      expect(orders.rows.every((row) => row.attribution === 'internal')).toBe(true);

      const records = await pool.query('SELECT broker_order_id FROM broker_order_record ORDER BY broker_order_id');
      expect(records.rows.map((row) => row.broker_order_id)).toEqual(['transfer-in', 'transfer-out']);
    });

    it('leaves neither side changed when the transfer cannot complete', async () => {
      // A destination order id that already exists fails the primary key, after the
      // origin side has already been written inside the transaction. Units must not go
      // missing between the two halves of one operation.
      await createBrokerOrder(pool, 'already-taken', 'ACCOUNT002');
      await expect(transfer(4, 120, 'already-taken')).rejects.toThrow();

      const origin = await dao.getPosition({ accountId: 'ACCOUNT001', symbol: 'AAPL' });
      const destination = await dao.getPosition({ accountId: 'ACCOUNT002', symbol: 'AAPL' });
      expect(origin.position?.size.toString()).toBe('10');
      expect(destination.position).toBeNull();

      const orders = await pool.query("SELECT broker_order_id FROM broker_order WHERE broker_order_id = 'transfer-out'");
      expect(orders.rows).toHaveLength(0);
    });
  });
});
