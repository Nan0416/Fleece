import { createPool, migrate, PgLedgerDao } from '@fleece/core';
import { FleeceServer } from '@fleece/service';
import { Decimal, NotFoundError } from '@fleece/shared';
import path from 'node:path';
import { Pool } from 'pg';
import { FleeceClient } from '../../src/fleece-client';

/**
 * Every client method against a real service and a real database.
 *
 * **Why this exists.** The client and the service compile against the same Request and
 * Response types, which is what stops their *shapes* drifting — but nothing checks that
 * they agree on the URL. Rewriting this client silently moved two methods onto paths the
 * service does not serve (`/position/history` for `/historical-positions`, and POST
 * where the route is PUT), and everything still compiled. A round trip is the only thing
 * that catches that, and it catches reviver drift at the same time.
 *
 * Skips itself without `FLEECE_TEST_DATABASE_URL`, and takes its own Postgres schema so
 * it can run beside the other integration suites.
 */
const TEST_DATABASE_URL = process.env['FLEECE_TEST_DATABASE_URL'];
const describeIntegration = TEST_DATABASE_URL === undefined ? describe.skip : describe;

const d = (value: string): Decimal => Decimal.of(value);

describeIntegration('FleeceClient against a running service', () => {
  let pool: Pool;
  let server: FleeceServer;
  let client: FleeceClient;
  let accountId: string;

  beforeAll(async () => {
    if (TEST_DATABASE_URL === undefined) {
      throw new Error('FLEECE_TEST_DATABASE_URL is not set');
    }
    const admin = createPool({ connectionString: TEST_DATABASE_URL, maxConnections: 1 });
    await admin.query('CREATE SCHEMA IF NOT EXISTS test_fleece_client');
    await admin.end();

    const separator = TEST_DATABASE_URL.includes('?') ? '&' : '?';
    const databaseUrl = `${TEST_DATABASE_URL}${separator}options=-c%20search_path%3Dtest_fleece_client`;
    pool = createPool({ connectionString: databaseUrl });
    await migrate(pool, path.resolve(__dirname, '..', '..', '..', 'core', 'migrations'));

    // Port 0 would be tidier, but the config takes a fixed port and the client needs to
    // know it; 3187 is out of the way of the 3100 default.
    server = await FleeceServer.start({ stage: 'beta', port: 3187, host: '127.0.0.1', databaseUrl, corsOrigins: ['*'] }, { runMigrations: false });
    client = new FleeceClient({ baseUrl: 'http://127.0.0.1:3187' });
  });

  afterAll(async () => {
    await server.stop();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE broker_order_record, broker_order, order_fill_progress, ledger_transaction, dividend, profit, position, account RESTART IDENTITY CASCADE');
    const { account } = await client.createAccount({ name: 'Momentum', accountType: 'paper' });
    accountId = account.accountId;
  });

  /** A basis that has no exact double, so a lost precision would show. */
  const seedPosition = async (): Promise<void> => {
    const ledger = new PgLedgerDao(pool);
    const common = { accountId, symbol: 'AAPL', assetClass: 'equity' as const, multiplier: Decimal.ONE, timestamp: Date.parse('2026-09-01T14:30:00Z') };
    await ledger.applyFill({ ...common, referenceId: 'order-1', transactionSize: d('0.3'), transactionTotalCost: d('3.33') });
    await ledger.applyFill({ ...common, referenceId: 'order-2', transactionSize: d('-0.1'), transactionTotalCost: d('-1.2') });
  };

  describe('accounts', () => {
    it('creates, reads, lists, renames and deactivates', async () => {
      expect((await client.getAccount({ accountId })).account.name).toBe('Momentum');
      expect((await client.listAccounts()).accounts.map((account) => account.accountId)).toContain(accountId);

      await client.updateAccountName({ accountId, name: 'Reversion' });
      expect((await client.getAccount({ accountId })).account.name).toBe('Reversion');

      await client.deactivateAccount({ accountId });
      expect((await client.getAccount({ accountId })).account.status).toBe('inactive');
      await client.activateAccount({ accountId });
      expect((await client.getAccount({ accountId })).account.status).toBe('active');
    });

    it("rebuilds the service's typed errors on this side", async () => {
      await expect(client.getAccount({ accountId: 'NOSUCHACC1' })).rejects.toThrow(NotFoundError);
    });

    it('deletes', async () => {
      await client.deleteAccount({ accountId, force: true });
      await expect(client.getAccount({ accountId })).rejects.toThrow(NotFoundError);
    });
  });

  describe('positions', () => {
    it('reads one back with every digit intact', async () => {
      await seedPosition();
      const { position } = await client.getPosition({ accountId, symbol: 'AAPL' });
      expect(position.size.toString()).toBe('0.2');
      expect(position.totalCost.toString()).toBe('2.22');
      // A Decimal, not a string that looks like one: it has to be usable as a number.
      expect(position.size.add(d('0.1')).toString()).toBe('0.3');
    });

    it('lists, and filters by asset class', async () => {
      await seedPosition();
      expect((await client.listPositions({ accountId })).positions).toHaveLength(1);
      expect((await client.listPositions({ accountId, assetClass: 'option' })).positions).toHaveLength(0);
      expect((await client.listPositions({ accountId, assetClass: 'equity' })).positions).toHaveLength(1);
    });

    it('projects history out of the transaction log', async () => {
      await seedPosition();
      const { positions } = await client.listHistoricalPositions({ accountId, symbol: 'AAPL', from: 1, limit: 10, sort: 'asc' });
      expect(positions.map((entry) => entry.size.toString())).toEqual(['0.3', '0.2']);
    });

    it('applies a split, which scales the size and leaves the basis alone', async () => {
      await seedPosition();
      await client.stockSplit({ accountId, symbol: 'AAPL', ratio: d('1.5') });
      const { position } = await client.getPosition({ accountId, symbol: 'AAPL' });
      expect(position.size.toString()).toBe('0.3');
      expect(position.totalCost.toString()).toBe('2.22');
    });

    it('transfers to another account, moving the basis with it', async () => {
      await seedPosition();
      const { account: other } = await client.createAccount({ name: 'Carry', accountType: 'paper' });
      await client.transferPosition({
        originAccountId: accountId,
        destinationAccountId: other.accountId,
        symbol: 'AAPL',
        assetClass: 'equity',
        unitCost: d('11.1'),
        size: d('0.1'),
      });

      expect((await client.getPosition({ accountId, symbol: 'AAPL' })).position.size.toString()).toBe('0.1');
      expect((await client.getPosition({ accountId: other.accountId, symbol: 'AAPL' })).position.size.toString()).toBe('0.1');
    });
  });

  describe('profits and transactions', () => {
    it('reads realised profit', async () => {
      await seedPosition();
      expect((await client.getProfit({ accountId, symbol: 'AAPL' })).profit.profit.toString()).toBe('0.09');
      expect((await client.listProfits({ accountId })).profits).toHaveLength(1);
    });

    it('keeps a transaction that realised nothing distinct from one that realised zero', async () => {
      await seedPosition();
      const { transactions } = await client.listTransactions({ accountId, from: 1, limit: 10, sort: 'asc' });
      expect(transactions[0].profit).toBeUndefined();
      expect(transactions[1].profit?.toString()).toBe('0.09');
      expect(transactions[1].roi?.toString()).toBe('750');
    });

    it('finds every transaction one order produced', async () => {
      await seedPosition();
      const { transactions } = await client.listTransactionsByReferenceId({ referenceId: 'order-1' });
      expect(transactions.map((entry) => entry.referenceId)).toEqual(['order-1']);
    });
  });

  describe('broker orders', () => {
    const seedOrder = async (brokerOrderId: string, parentBrokerOrderId?: string): Promise<void> => {
      await pool.query(
        `INSERT INTO broker_order (broker_order_id, parent_broker_order_id, account_id, broker, broker_account_id, symbol, asset_class, multiplier,
           status, order_class, order_type, side, time_in_force, qty, limit_price, filled_qty)
         VALUES ($1, $2, $3, 'alpaca', 'PA1', 'AAPL', 'equity', 1, 'filled', 'regular', 'limit', 'buy', 'day', 10, 150.25, 10)`,
        [brokerOrderId, parentBrokerOrderId ?? null, accountId],
      );
    };

    it('reads one, and keeps its prices exact', async () => {
      await seedOrder('bo-1');
      const { brokerOrder } = await client.getBrokerOrder({ brokerOrderId: 'bo-1' });
      expect(brokerOrder.limitPrice?.toString()).toBe('150.25');
      expect(brokerOrder.qty.toString()).toBe('10');
    });

    it('lists by one search property, which is also how orphans are found', async () => {
      await seedOrder('bo-1');
      const { brokerOrders } = await client.listBrokerOrders({ accountId, from: 1, limit: 10, sort: 'asc' });
      expect(brokerOrders.map((order) => order.brokerOrderId)).toEqual(['bo-1']);
    });

    it('finds the legs of a composite order', async () => {
      await seedOrder('leg-1', 'spread-parent');
      const { brokerOrders } = await client.listBrokerOrderLegs({ parentBrokerOrderId: 'spread-parent' });
      expect(brokerOrders.map((order) => order.brokerOrderId)).toEqual(['leg-1']);
    });

    it('reports what the ledger booked, and whether the counter still agrees', async () => {
      await seedPosition();
      const { progress, reconciled } = await client.getOrderFillProgress({ referenceId: 'order-1' });
      expect(progress[0].appliedSize.toString()).toBe('0.3');
      expect(reconciled).toBe(true);
    });

    it('reads the raw broker events back', async () => {
      await seedOrder('bo-1');
      await pool.query('INSERT INTO broker_order_record (broker_order_id, record) VALUES ($1, $2)', ['bo-1', JSON.stringify({ id: 'bo-1', status: 'filled' })]);
      const { records } = await client.listBrokerOrderRecords({ brokerOrderId: 'bo-1' });
      expect(records).toEqual([{ id: 'bo-1', status: 'filled' }]);
    });

    it('deletes one', async () => {
      await seedOrder('bo-1');
      await client.deleteBrokerOrder({ brokerOrderId: 'bo-1' });
      await expect(client.getBrokerOrder({ brokerOrderId: 'bo-1' })).rejects.toThrow(NotFoundError);
    });
  });

  describe('dividends and health', () => {
    it('lists dividends', async () => {
      expect((await client.listDividends({ accountId })).dividends).toEqual([]);
    });

    it('answers a ping', async () => {
      expect((await client.ping()).status).toBe('ok');
    });
  });
});
