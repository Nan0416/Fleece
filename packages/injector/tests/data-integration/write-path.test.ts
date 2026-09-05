import { AlpacaAccountIdentifier, AlpacaOrder, convertAlpacaOrderToBrokerOrderEvents } from '@fleece/alpaca';
import { createLedgerServices, createPool, migrate } from '@fleece/core';
import { Decimal } from '@fleece/shared';
import path from 'node:path';
import { Pool } from 'pg';
import { OrderTrackingFacade } from '../../src/order-tracking-facade';
import { alpacaOrder, mlegOrder } from '../alpaca-orders';

/**
 * The write path, end to end, against a real PostgreSQL: a recorded Alpaca payload goes
 * in and a position comes out.
 *
 * Everything between is the real thing — the converter, the tracking facade, the ledger
 * service and the DAO — because each of them is individually covered and none of that
 * says whether they agree with each other. The three pieces that could only be wrong
 * *between* components are what this is for: that the converter's `Decimal` survives to
 * the column, that the multiplier is applied exactly once on the way through, and that
 * what lands adds up.
 *
 * The websocket and REST plumbing above this is covered by `alpaca-injector.test.ts`;
 * the four lines it contributes are reproduced in `inject` below.
 *
 * Skips itself without `FLEECE_TEST_DATABASE_URL`, like every other suite that needs a
 * database. Point it at a throwaway one.
 */
const TEST_DATABASE_URL = process.env.FLEECE_TEST_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL === undefined ? describe.skip : describe;

const account: AlpacaAccountIdentifier = { accountId: 'PAPER001', live: false };

describeIntegration('the write path', () => {
  let pool: Pool;
  let facade: OrderTrackingFacade;

  beforeAll(async () => {
    if (TEST_DATABASE_URL === undefined) {
      throw new Error('FLEECE_TEST_DATABASE_URL is not set');
    }
    // Its own Postgres schema, so this suite and the ledger DAO's can run in parallel
    // workers without truncating each other's rows. See `core`'s `test-database.ts`,
    // which does the same thing for the same reason.
    const admin = createPool({ connectionString: TEST_DATABASE_URL, maxConnections: 1 });
    await admin.query('CREATE SCHEMA IF NOT EXISTS test_write_path');
    await admin.end();

    const separator = TEST_DATABASE_URL.includes('?') ? '&' : '?';
    pool = createPool({ connectionString: `${TEST_DATABASE_URL}${separator}options=-c%20search_path%3Dtest_write_path` });
    await migrate(pool, path.resolve(__dirname, '..', '..', '..', 'core', 'migrations'));
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE broker_order_record, broker_order, order_fill_progress, ledger_transaction, dividend, profit, position, account RESTART IDENTITY CASCADE');
    for (const accountId of ['MOMENTUM01', 'DEFAULTPAPR']) {
      await pool.query("INSERT INTO account (account_id, name, status, account_type) VALUES ($1, $1, 'active', 'paper')", [accountId]);
    }

    const services = createLedgerServices({ pool });
    facade = new OrderTrackingFacade({
      ledgerService: services.ledgerService,
      brokerOrderService: services.brokerOrderService,
      defaultAccountIdProvider: () => 'DEFAULTPAPR',
      unresolvedTimeoutMs: 50,
    });
  });

  afterEach(() => {
    facade.stop();
  });

  /** What `AlpacaInjector.inject` does, minus the feed it does it from. */
  function inject(order: AlpacaOrder): void {
    const rawById = new Map([order, ...(order.legs ?? [])].map((entry) => [entry.id, entry]));
    for (const event of convertAlpacaOrderToBrokerOrderEvents(order, account)) {
      facade.enqueue({ event, originalEvent: rawById.get(event.id) ?? order, broker: 'alpaca', brokerAccountId: account.accountId, live: account.live });
    }
  }

  const position = async (accountId: string, symbol: string) => {
    const result = await pool.query<{ size: string; total_cost: string; multiplier: string; asset_class: string }>(
      'SELECT size, total_cost, multiplier, asset_class FROM position WHERE account_id = $1 AND symbol = $2',
      [accountId, symbol],
    );
    return result.rows[0];
  };

  /**
   * `position.total_cost == sum(total_cost) + sum(profit)`, per account and symbol,
   * asserted against what is actually stored and exactly rather than within a tolerance.
   */
  const residuals = async (): Promise<ReadonlyArray<string>> => {
    const result = await pool.query<{ residual: string }>(
      `SELECT p.total_cost - (COALESCE(SUM(t.total_cost), 0) + COALESCE(SUM(t.profit), 0)) AS residual
         FROM position p LEFT JOIN ledger_transaction t ON t.account_id = p.account_id AND t.symbol = p.symbol
        GROUP BY p.account_id, p.symbol, p.total_cost`,
    );
    return result.rows.map((row) => Decimal.parse(row.residual, 'residual').toString());
  };

  describe('an equity fill', () => {
    it('reaches the position it belongs to, at the price the broker reported', async () => {
      inject(alpacaOrder());
      await facade.drain();

      const held = await position('MOMENTUM01', 'AAPL');
      expect(held.size).toBe('10.000000000');
      expect(held.total_cost).toBe('1500.000000000');
      expect(held.asset_class).toBe('equity');
    });

    it("records the order it came from, in the broker's own units", async () => {
      inject(alpacaOrder());
      await facade.drain();

      const order = await pool.query<{ account_id: string; filled_qty: string; filled_avg_price: string }>(
        'SELECT account_id, filled_qty, filled_avg_price FROM broker_order WHERE broker_order_id = $1',
        ['order-1'],
      );
      expect(order.rows[0].account_id).toBe('MOMENTUM01');
      // What the broker said, in the broker's units, alongside what the ledger booked.
      expect(order.rows[0].filled_qty).toBe('10.000000000');
      expect(order.rows[0].filled_avg_price).toBe('150.000000000');
    });
  });

  describe('a two-leg option spread', () => {
    it('books each contract in contracts and dollars', async () => {
      inject(mlegOrder());
      await facade.drain();

      const short = await position('MOMENTUM01', 'AMZN261016C00280000');
      const long = await position('MOMENTUM01', 'AMZN261016C00285000');

      // One contract sold at a premium of 3.85 raised $385; one bought at 2.95 cost $295.
      // The size counts contracts, so a listing reads 1 rather than 100.
      expect([short.size, short.total_cost]).toEqual(['-1.000000000', '-385.000000000']);
      expect([long.size, long.total_cost]).toEqual(['1.000000000', '295.000000000']);
      expect(short.multiplier).toBe('100.000000000');
    });

    it('books nothing for the spread itself, whose price no contract traded at', async () => {
      inject(mlegOrder());
      await facade.drain();

      // The parent's -0.9 is the package's net credit. There is no instrument to open a
      // position in and no price anything traded at.
      const rows = await pool.query("SELECT symbol FROM position WHERE symbol = '' OR symbol IS NULL");
      expect(rows.rows).toHaveLength(0);

      const transactions = await pool.query('SELECT 1 FROM ledger_transaction WHERE reference_id = $1', ['mleg-parent-1']);
      expect(transactions.rows).toHaveLength(0);
    });

    it('records the parent, with no instrument and the package net it was traded at', async () => {
      inject(mlegOrder());
      await facade.drain();

      const parent = await pool.query<{ symbol: string | null; qty: string; limit_price: string; filled_avg_price: string; order_class: string }>(
        'SELECT symbol, qty, limit_price, filled_avg_price, order_class FROM broker_order WHERE broker_order_id = $1',
        ['mleg-parent-1'],
      );
      const row = parent.rows[0];
      // NULL rather than '': the only rows the CHECK permits without a symbol are mleg.
      expect(row.symbol).toBeNull();
      expect(row.order_class).toBe('mleg');
      // Signed net — a credit received — where every other row's price is unsigned. It
      // is what the spread was actually traded at, and the legs price themselves at
      // nothing, so it exists nowhere else.
      expect(row.filled_avg_price).toBe('-0.900000000');
      expect(row.limit_price).toBe('-0.850000000');
      // And its quantity counts spreads, not contracts.
      expect(row.qty).toBe('1.000000000');
    });

    it('records each leg naming that parent, without a foreign key insisting on it', async () => {
      inject(mlegOrder());
      await facade.drain();

      const legs = await pool.query<{ broker_order_id: string; parent_broker_order_id: string | null; account_id: string }>(
        'SELECT broker_order_id, parent_broker_order_id, account_id FROM broker_order WHERE symbol IS NOT NULL ORDER BY broker_order_id',
      );
      expect(legs.rows.map((row) => row.broker_order_id)).toEqual(['mleg-leg-long', 'mleg-leg-short']);
      expect(legs.rows.every((row) => row.parent_broker_order_id === 'mleg-parent-1')).toBe(true);
      // Alpaca gives legs client order ids of its own, so their account can only have
      // come from the parent's correlation — which `parent_broker_order_id` records.
      expect(legs.rows.every((row) => row.account_id === 'MOMENTUM01')).toBe(true);
    });
  });

  describe('an account holding both stock and options', () => {
    it('totals in one currency, with nothing having to know which rows are which', async () => {
      inject(alpacaOrder());
      inject(mlegOrder());
      await facade.drain();

      const total = await pool.query<{ total: string }>('SELECT SUM(total_cost) AS total FROM position WHERE account_id = $1', ['MOMENTUM01']);
      // 1500 for the shares, -385 + 295 for the spread.
      expect(Decimal.parse(total.rows[0].total, 'total').toString()).toBe('1410');
    });
  });

  describe('the same payload delivered twice', () => {
    it('changes nothing the second time, whatever the source', async () => {
      // The websocket and the REST backfill both report a filled order. The report is
      // cumulative, so applying it again must add nothing.
      inject(alpacaOrder());
      inject(mlegOrder());
      await facade.drain();
      inject(alpacaOrder());
      inject(mlegOrder());
      await facade.drain();

      expect((await position('MOMENTUM01', 'AAPL')).size).toBe('10.000000000');
      expect((await position('MOMENTUM01', 'AMZN261016C00280000')).total_cost).toBe('-385.000000000');

      const transactions = await pool.query('SELECT 1 FROM ledger_transaction');
      expect(transactions.rows).toHaveLength(3);

      // Four orders now: the equity order, the spread's parent and its two legs. The
      // parent produced none of those transactions.
      const orders = await pool.query('SELECT 1 FROM broker_order');
      expect(orders.rows).toHaveLength(4);
    });
  });

  describe('an order Fleece never placed', () => {
    it('lands in the catch-all account rather than being dropped', async () => {
      // The shares moved whether or not a strategy asked for them, and a ledger that
      // omits them will not reconcile against the brokerage statement.
      inject(alpacaOrder({ id: 'placed-by-hand', client_order_id: '6c256995-071f-4f85-a774-a6fba2d03f5c' }));
      await facade.drain();
      await new Promise((resolve) => setTimeout(resolve, 120));
      await facade.drain();

      const held = await position('DEFAULTPAPR', 'AAPL');
      expect(held.size).toBe('10.000000000');

      // Which is all "orphan" means: an order sitting in a configured catch-all account.
      // Finding them is a search by account, not a column marking each one.
      const orphans = await pool.query('SELECT broker_order_id FROM broker_order WHERE account_id = $1', ['DEFAULTPAPR']);
      expect(orphans.rows.map((row) => row.broker_order_id)).toEqual(['placed-by-hand']);
    });
  });

  describe('what lands adds up', () => {
    it('leaves no residue on any position it wrote', async () => {
      inject(alpacaOrder());
      inject(mlegOrder());
      await facade.drain();
      // Close half the equity position, so a basis is apportioned rather than only added.
      inject(alpacaOrder({ id: 'order-2', side: 'sell', qty: '4', filled_qty: '4', filled_avg_price: '163.33' }));
      await facade.drain();

      expect(await residuals()).toEqual(['0', '0', '0']);
    });

    it('leaves the stored fill progress agreeing with the transactions it counts', async () => {
      inject(alpacaOrder());
      inject(mlegOrder());
      await facade.drain();

      // The applied total used to be summed from the log on every fill, which made
      // drift impossible. Storing it made the write path cheaper and made drift
      // possible, so the agreement has to be asked for — here it is asked.
      const services = createLedgerServices({ pool });
      for (const referenceId of ['order-1', 'mleg-leg-short', 'mleg-leg-long']) {
        const { progress, reconciled } = await services.ledgerService.getOrderFillProgress({ referenceId });
        expect(progress).toHaveLength(1);
        expect(reconciled).toBe(true);
      }
    });

    it("counts an option's progress in contracts and dollars, like everything else", async () => {
      inject(mlegOrder());
      await facade.drain();

      const services = createLedgerServices({ pool });
      const { progress } = await services.ledgerService.getOrderFillProgress({ referenceId: 'mleg-leg-short' });
      expect(progress[0].appliedSize.toString()).toBe('-1');
      expect(progress[0].appliedTotalCost.toString()).toBe('-385');
    });
  });
});
