import { AssetClass, BrokerOrderRecord, Decimal } from '@fleece/shared';
import { Pool } from 'pg';
import { PgBrokerOrderDao } from '../../src/data/pg-broker-order-dao';
import { UpsertBrokerOrderInput } from '../../src/data/broker-order-dao';
import { createAccount, createTestPool, describeIntegration, truncateAll } from './test-database';

describeIntegration('PgBrokerOrderDao', () => {
  let pool: Pool;
  let dao: PgBrokerOrderDao;

  beforeAll(async () => {
    pool = await createTestPool('test_pg_broker_order_dao');
    dao = new PgBrokerOrderDao(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    await createAccount(pool, 'ACCOUNT001');
    await createAccount(pool, 'ACCOUNT002');
  });

  const order = (overrides: Partial<UpsertBrokerOrderInput> = {}): UpsertBrokerOrderInput => ({
    brokerOrderId: 'order-1',
    accountId: 'ACCOUNT001',
    broker: 'alpaca',
    brokerAccountId: 'PA-0001',
    attribution: 'correlation',
    symbol: 'AAPL',
    assetClass: 'equity',
    multiplier: Decimal.ONE,
    status: 'new',
    orderClass: 'regular',
    orderType: 'limit',
    side: 'buy',
    timeInForce: 'day',
    extendedHours: false,
    qty: Decimal.of(10),
    limitPrice: Decimal.of('150.25'),
    filledQty: Decimal.ZERO,
    ...overrides,
  });

  describe('recording what a broker reported', () => {
    it('creates the order the first time and advances it after', async () => {
      const first = await dao.upsertBrokerOrder(order());
      expect(first.created).toBe(true);

      const second = await dao.upsertBrokerOrder(order({ status: 'filled', filledQty: Decimal.of(10), filledAvgPrice: Decimal.of('150.25') }));
      expect(second.created).toBe(false);
      expect(second.brokerOrder.status).toBe('filled');
      expect(second.brokerOrder.filledQty.toString()).toBe('10');
    });

    it('never overwrites what an order is, however the broker reports it later', async () => {
      // An order's account does not change, and neither does how that was decided. A
      // later report that disagrees is a bug upstream, not a correction to apply — and
      // applying it would move a fill onto the wrong strategy.
      await dao.upsertBrokerOrder(order());
      const { brokerOrder } = await dao.upsertBrokerOrder(order({ accountId: 'ACCOUNT002', attribution: 'default', symbol: 'TSLA', qty: Decimal.of(999) }));

      expect(brokerOrder.accountId).toBe('ACCOUNT001');
      expect(brokerOrder.attribution).toBe('correlation');
      expect(brokerOrder.symbol).toBe('AAPL');
      expect(brokerOrder.qty.toString()).toBe('10');
    });

    it('survives two reports of the same order arriving at once', async () => {
      // One statement, so neither can decide independently that the row did not exist
      // and fail on the primary key. Both must land; exactly one must have created it.
      const results = await Promise.all([dao.upsertBrokerOrder(order()), dao.upsertBrokerOrder(order({ status: 'accepted' }))]);
      expect(results.filter((result) => result.created)).toHaveLength(1);
    });

    it('keeps a price to the precision the broker sent it, not to the precision a double has', async () => {
      const { brokerOrder } = await dao.upsertBrokerOrder(order({ limitPrice: Decimal.of('0.123456789') }));
      expect(brokerOrder.limitPrice?.toString()).toBe('0.123456789');
    });
  });

  describe('a leg of a composite order', () => {
    const leg = (overrides: Partial<UpsertBrokerOrderInput> = {}) =>
      order({
        brokerOrderId: 'leg-1',
        parentBrokerOrderId: 'parent-1',
        symbol: 'AMZN261016C00280000',
        assetClass: 'option',
        multiplier: Decimal.of(100),
        orderClass: 'mleg',
        attribution: 'parent',
        ratioQty: Decimal.ONE,
        limitPrice: undefined,
        ...overrides,
      });

    it('records against a parent this table holds nothing for', async () => {
      // This is why `parent_broker_order_id` carries an index and no foreign key. A leg
      // reaching us without its parent — for any reason at all — must land: a rejected
      // leg is a fill the ledger never learns about, which is the failure this system
      // exists to prevent. This test fails the moment somebody adds the constraint.
      const { brokerOrder } = await dao.upsertBrokerOrder(leg());
      expect(brokerOrder.parentBrokerOrderId).toBe('parent-1');

      const parent = await pool.query('SELECT 1 FROM broker_order WHERE broker_order_id = $1', ['parent-1']);
      expect(parent.rows).toHaveLength(0);
    });

    it('is found from its parent id, whether or not that parent exists', async () => {
      await dao.upsertBrokerOrder(leg());
      await dao.upsertBrokerOrder(leg({ brokerOrderId: 'leg-2', symbol: 'AMZN261016C00285000' }));

      const { brokerOrders } = await dao.listBrokerOrderLegs({ parentBrokerOrderIds: ['parent-1'] });
      expect(brokerOrders.map((entry) => entry.brokerOrderId).sort()).toEqual(['leg-1', 'leg-2']);
    });
  });

  describe('a composite parent', () => {
    const parent = () =>
      order({
        brokerOrderId: 'parent-1',
        symbol: undefined,
        assetClass: 'option',
        orderClass: 'mleg',
        side: undefined,
        qty: Decimal.ONE,
        limitPrice: Decimal.of('-0.85'),
        filledQty: Decimal.ONE,
        filledAvgPrice: Decimal.of('-0.9'),
      });

    it('is stored with no instrument and a signed net price', async () => {
      const { brokerOrder } = await dao.upsertBrokerOrder(parent());
      expect(brokerOrder.symbol).toBeUndefined();
      // Negative because the spread was sold for a credit. Every other row's price is
      // unsigned; a missing symbol is what marks the ones where it is not.
      expect(brokerOrder.filledAvgPrice?.toString()).toBe('-0.9');
      expect(brokerOrder.limitPrice?.toString()).toBe('-0.85');
    });

    it('is the only shape allowed to trade no instrument', async () => {
      // A plain order with no symbol is a bug, and the CHECK is what says so rather than
      // letting it become a position keyed on nothing.
      await expect(dao.upsertBrokerOrder(order({ symbol: undefined, orderClass: 'regular' }))).rejects.toThrow();
    });

    it('cannot be its own parent', async () => {
      await expect(dao.upsertBrokerOrder(order({ parentBrokerOrderId: 'order-1' }))).rejects.toThrow();
    });
  });

  describe('claiming an order', () => {
    it('moves one off the catch-all account', async () => {
      await dao.upsertBrokerOrder(order({ accountId: 'ACCOUNT002', attribution: 'default' }));
      const { brokerOrder } = await dao.claimBrokerOrder({ brokerOrderId: 'order-1', accountId: 'ACCOUNT001', attribution: 'tracking' });

      expect(brokerOrder?.accountId).toBe('ACCOUNT001');
      expect(brokerOrder?.attribution).toBe('tracking');
    });

    it('refuses to move one that something has already claimed', async () => {
      // Guarded in the UPDATE rather than around it, so a claim arriving concurrently
      // with the attribution cannot slip between a read and a write.
      await dao.upsertBrokerOrder(order());
      const { brokerOrder } = await dao.claimBrokerOrder({ brokerOrderId: 'order-1', accountId: 'ACCOUNT002', attribution: 'tracking' });

      expect(brokerOrder).toBeNull();
      expect((await dao.getBrokerOrder({ brokerOrderId: 'order-1' })).brokerOrder?.accountId).toBe('ACCOUNT001');
    });

    it('lets exactly one of two simultaneous claims win', async () => {
      await dao.upsertBrokerOrder(order({ attribution: 'default' }));
      const claims = await Promise.all([
        dao.claimBrokerOrder({ brokerOrderId: 'order-1', accountId: 'ACCOUNT001', attribution: 'tracking' }),
        dao.claimBrokerOrder({ brokerOrderId: 'order-1', accountId: 'ACCOUNT002', attribution: 'tracking' }),
      ]);
      expect(claims.filter((claim) => claim.brokerOrder !== null)).toHaveLength(1);
    });
  });

  describe('listing orphans', () => {
    it('returns the orders nobody claimed, and only those', async () => {
      await dao.upsertBrokerOrder(order());
      await dao.upsertBrokerOrder(order({ brokerOrderId: 'order-2', attribution: 'default' }));

      const { brokerOrders } = await dao.listOrphanBrokerOrders({});
      expect(brokerOrders.map((entry) => entry.brokerOrderId)).toEqual(['order-2']);
    });
  });

  describe('records', () => {
    // A concrete record shape, because `BrokerOrderRecord` declares only the id a
    // caller is ever expected to read back generically.
    interface StatusRecord extends BrokerOrderRecord {
      readonly status: string;
    }
    const statusRecord = (status: string): StatusRecord => ({ id: 'order-1', status });

    it('keeps every event a broker sent, verbatim and oldest first', async () => {
      await dao.upsertBrokerOrder(order());
      await dao.insertRecord({ brokerOrderId: 'order-1', record: statusRecord('new') });
      await dao.insertRecord({ brokerOrderId: 'order-1', record: statusRecord('filled') });

      const { records } = await dao.listRecords({ brokerOrderId: 'order-1' });
      expect(records).toEqual([statusRecord('new'), statusRecord('filled')]);
    });

    it('goes with the order when it is deleted', async () => {
      await dao.upsertBrokerOrder(order());
      await dao.insertRecord({ brokerOrderId: 'order-1', record: { id: 'order-1' } });
      await dao.deleteBrokerOrder({ brokerOrderId: 'order-1' });

      const remaining = await pool.query('SELECT 1 FROM broker_order_record');
      expect(remaining.rows).toHaveLength(0);
    });

    it('leaves the legs alone, which are orders in their own right', async () => {
      // Cascading into them would delete the record of executions that happened.
      await dao.upsertBrokerOrder(order({ brokerOrderId: 'parent-1', symbol: undefined, orderClass: 'mleg', side: undefined }));
      await dao.upsertBrokerOrder(order({ brokerOrderId: 'leg-1', parentBrokerOrderId: 'parent-1' }));
      await dao.deleteBrokerOrder({ brokerOrderId: 'parent-1' });

      expect((await dao.getBrokerOrder({ brokerOrderId: 'leg-1' })).brokerOrder).not.toBeNull();
    });
  });

  describe('listing by one search property', () => {
    it('finds an order by each property the endpoint accepts', async () => {
      await dao.upsertBrokerOrder(order());
      await dao.upsertBrokerOrder(order({ brokerOrderId: 'order-2', symbol: 'TSLA', status: 'filled' }));

      const page = { from: 0, limit: 10, sort: 'asc' as const };
      expect((await dao.listBrokerOrders({ ...page, symbol: 'TSLA' })).brokerOrders.map((entry) => entry.brokerOrderId)).toEqual(['order-2']);
      expect((await dao.listBrokerOrders({ ...page, status: 'filled' })).brokerOrders.map((entry) => entry.brokerOrderId)).toEqual(['order-2']);
      expect((await dao.listBrokerOrders({ ...page, accountId: 'ACCOUNT001' })).brokerOrders).toHaveLength(2);
    });

    it('separates option orders from equity ones', async () => {
      await dao.upsertBrokerOrder(order());
      await dao.upsertBrokerOrder(order({ brokerOrderId: 'order-2', symbol: 'AMZN261016C00280000', assetClass: 'option', multiplier: Decimal.of(100) }));

      const { brokerOrders } = await dao.listBrokerOrders({ from: 0, limit: 10, sort: 'asc', assetClass: 'option' as AssetClass });
      expect(brokerOrders.map((entry) => entry.brokerOrderId)).toEqual(['order-2']);
      expect(brokerOrders[0].multiplier.toString()).toBe('100');
    });
  });

  describe('the vocabulary the database enforces', () => {
    it('refuses an attribution outside the four the ledger knows', async () => {
      // The CHECK is what makes `toBrokerOrderAttribution` a backstop rather than a
      // validator: a row can only fail to narrow if the schema and the code have
      // diverged, which is a deployment problem no caller can cause or fix.
      await dao.upsertBrokerOrder(order());
      await expect(pool.query('UPDATE broker_order SET attribution = $1 WHERE broker_order_id = $2', ['guessed', 'order-1'])).rejects.toThrow(/attribution/);
    });

    it('accepts a status it has never seen, because a rejected row is a lost fill', async () => {
      // `status` deliberately carries no CHECK. A broker inventing a status must be
      // recorded, not refused — the opposite trade-off from the columns above, and for
      // the opposite reason.
      const { brokerOrder } = await dao.upsertBrokerOrder(order({ status: 'some_status_alpaca_added_last_week' }));
      expect(brokerOrder.status).toBe('some_status_alpaca_added_last_week');
    });
  });
});
