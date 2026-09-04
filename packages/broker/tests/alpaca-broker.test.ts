import { AlpacaActiveSynchronization, decodeAlpacaOrderCorrelation } from '@fleece/alpaca';
import { BrokerOrderEvent } from '@fleece/shared';
import { AlpacaBroker } from '../src/alpaca-broker';
import { NotReservableError } from '../src/models/errors';
import { OrderObj } from '../src/models/order-obj';
import { alpacaOrder, FakeAlpacaRestClient, FakeAlpacaWsClient, RecordingOrderTrackingClient } from './fake-alpaca';

const account = { accountId: 'PAPER001', live: false };
const noEvents = async (): Promise<void> => {};

interface Harness {
  readonly broker: AlpacaBroker;
  readonly rest: FakeAlpacaRestClient;
  readonly ws: FakeAlpacaWsClient;
  readonly tracking: RecordingOrderTrackingClient;
}

/**
 * Every broker built here is torn down afterwards. `init` starts a polling interval,
 * and an interval left running holds the process open — which surfaces as the whole
 * suite hanging rather than as a failing test.
 */
const built: AlpacaBroker[] = [];

function harness(): Harness {
  const rest = new FakeAlpacaRestClient();
  const ws = new FakeAlpacaWsClient();
  const tracking = new RecordingOrderTrackingClient();
  const activeSync = new AlpacaActiveSynchronization({ account, restClient: rest, tickMs: 60_000 });
  const broker = new AlpacaBroker({ account, restClient: rest, wsClient: ws, activeSync, orderTrackingClient: tracking, now: () => 1_000 });
  built.push(broker);
  return { broker, rest, ws, tracking };
}

afterEach(async () => {
  for (const broker of built.splice(0)) {
    await broker.terminate();
  }
});

describe('AlpacaBroker', () => {
  describe('init', () => {
    it('seeds buying power and positions from the broker', async () => {
      const { broker, rest } = harness();
      rest.buyingPower = '50000';
      rest.positions = [{ symbol: 'AAPL', asset_id: 'a', asset_class: 'us_equity', qty: '10', avg_entry_price: '170', side: 'long', market_value: '1700', cost_basis: '1700' }];

      await broker.init();

      expect(broker.tracker.availableBuyingPower).toBe(50_000);
      expect(broker.tracker.positionTracker('AAPL')?.positionSize).toBe(10);
      expect(broker.tracker.positionTracker('AAPL')?.unitCost).toBe(170);
    });

    it('locks shares already committed to an order open at the broker', async () => {
      const { broker, rest } = harness();
      rest.positions = [{ symbol: 'AAPL', asset_id: 'a', asset_class: 'us_equity', qty: '20', avg_entry_price: '170', side: 'long', market_value: '3400', cost_basis: '3400' }];
      rest.openOrders = [alpacaOrder({ id: 'open-sell', side: 'sell', qty: '5', filled_qty: '0' })];

      await broker.init();

      expect(broker.tracker.positionTracker('AAPL')?.freeSize).toBe(15);
    });

    it('holds buying power for an open limit buy, carrying its limit price through', async () => {
      // The legacy parsed and validated the limit price and then hard-coded 0 into the
      // pending order, so every open limit buy reserved nothing across a restart.
      const { broker, rest } = harness();
      rest.buyingPower = '100000';
      rest.openOrders = [alpacaOrder({ id: 'open-buy', side: 'buy', qty: '10', filled_qty: '0', order_type: 'limit', type: 'limit', limit_price: '150' })];

      await broker.init();

      expect(broker.tracker.availableBuyingPower).toBe(98_500);
    });

    it('refuses to start against an account with no buying power', async () => {
      const { broker, rest } = harness();
      rest.buyingPower = '0';
      await expect(broker.init()).rejects.toThrow(/cannot be traded against/);
    });

    it('starts listening on the stream', async () => {
      const { broker, ws } = harness();
      await broker.init();
      expect(ws.handlerCount).toBe(1);
    });
  });

  describe('placing an order', () => {
    it('reserves before sending, and holds what the order needs', async () => {
      const { broker, rest } = harness();
      await broker.init();

      await broker.order({ type: 'limit', symbol: 'AAPL', size: 10, limitPrice: 100, accountId: 'MOMENTUM01', onEvent: noEvents });

      expect(rest.created).toHaveLength(1);
      expect(broker.tracker.availableBuyingPower).toBe(99_000);
    });

    it('encodes the virtual account and group into the client order id', async () => {
      const { broker, rest } = harness();
      await broker.init();

      await broker.order({ type: 'market', symbol: 'AAPL', size: 10, unitPrice: 100, accountId: 'MOMENTUM01', groupId: 'group-1', onEvent: noEvents });

      const correlation = decodeAlpacaOrderCorrelation(rest.created[0].clientOrderId ?? '');
      expect(correlation.virtualAccountId).toBe('MOMENTUM01');
      expect(correlation.groupId).toBe('group-1');
      expect(correlation.reservationId).toEqual(expect.any(String));
    });

    it('refuses an order the account cannot support, without sending anything', async () => {
      const { broker, rest } = harness();
      rest.buyingPower = '500';
      await broker.init();

      await expect(broker.order({ type: 'limit', symbol: 'AAPL', size: 10, limitPrice: 100, accountId: 'MOMENTUM01', onEvent: noEvents })).rejects.toThrow(NotReservableError);
      expect(rest.created).toHaveLength(0);
    });

    it('releases the reservation when the request never reaches the broker', async () => {
      // Otherwise a run of failed placements would silently exhaust the account.
      const { broker, rest } = harness();
      await broker.init();
      const before = broker.tracker.availableBuyingPower;
      rest.failNextCreate = new Error('connection reset');

      await expect(broker.order({ type: 'limit', symbol: 'AAPL', size: 10, limitPrice: 100, accountId: 'MOMENTUM01', onEvent: noEvents })).rejects.toThrow('connection reset');
      expect(broker.tracker.availableBuyingPower).toBe(before);
    });

    it('tells the ledger which account and group the order belongs to', async () => {
      const { broker, tracking } = harness();
      await broker.init();

      await broker.order({ type: 'market', symbol: 'AAPL', size: 10, unitPrice: 100, accountId: 'MOMENTUM01', groupId: 'group-1', onEvent: noEvents });

      expect(tracking.requests).toEqual([{ brokerOrderIds: ['alpaca-order-1'], accountId: 'MOMENTUM01', groupId: 'group-1' }]);
    });

    it('still returns the order when the ledger could not be told', async () => {
      // The order is placed and the shares are moving; throwing here would leave the
      // caller believing it failed.
      const { broker, tracking } = harness();
      await broker.init();
      tracking.failNext = new Error('no transport configured');

      const handle = await broker.order({ type: 'market', symbol: 'AAPL', size: 10, unitPrice: 100, accountId: 'MOMENTUM01', onEvent: noEvents });
      expect(handle.brokerOrderId).toBe('alpaca-order-1');
    });

    it.each([0, 1.5, -0.5])('rejects a size of %s before reserving anything', async (size) => {
      const { broker, rest } = harness();
      await broker.init();
      await expect(broker.order({ type: 'market', symbol: 'AAPL', size, unitPrice: 100, accountId: 'MOMENTUM01', onEvent: noEvents })).rejects.toThrow(/whole number/);
      expect(rest.created).toHaveLength(0);
    });

    it('sends a sell as an absolute quantity with a sell side', async () => {
      const { broker, rest } = harness();
      rest.positions = [{ symbol: 'AAPL', asset_id: 'a', asset_class: 'us_equity', qty: '10', avg_entry_price: '100', side: 'long', market_value: '1000', cost_basis: '1000' }];
      await broker.init();

      await broker.order({ type: 'limit', symbol: 'AAPL', size: -4, limitPrice: 150, accountId: 'MOMENTUM01', onEvent: noEvents });

      expect(rest.created[0].size).toBe(4);
      expect(rest.created[0].side).toBe('sell');
    });
  });

  describe('delivering events', () => {
    it('hands each event to the handler that placed the order', async () => {
      const { broker, ws } = harness();
      await broker.init();
      const received: BrokerOrderEvent[] = [];

      await broker.order({
        type: 'market',
        symbol: 'AAPL',
        size: 10,
        unitPrice: 100,
        accountId: 'MOMENTUM01',
        onEvent: async (event) => {
          received.push(event);
        },
      });

      ws.emit(alpacaOrder({ status: 'filled', filled_qty: '10', filled_avg_price: '100' }));
      await new Promise((resolve) => setImmediate(resolve));

      expect(received.map((event) => event.status)).toEqual(['filled']);
    });

    it('moves the position as fills arrive', async () => {
      const { broker, rest, ws } = harness();
      await broker.init();
      await broker.order({ type: 'market', symbol: 'AAPL', size: 10, unitPrice: 100, accountId: 'MOMENTUM01', onEvent: noEvents });

      // Alpaca echoes the client order id back on every event, which is how the
      // reservation reaches the tracker. An event without it is a different case.
      ws.emit(alpacaOrder({ client_order_id: rest.created[0].clientOrderId, status: 'filled', filled_qty: '10', filled_avg_price: '100' }));
      await new Promise((resolve) => setImmediate(resolve));

      expect(broker.tracker.positionTracker('AAPL')?.positionSize).toBe(10);
      expect(broker.tracker.positionTracker('AAPL')?.unitCost).toBe(100);
    });

    it('ignores a terminal event whose reservation is already gone', async () => {
      // A very late duplicate of something the poller already applied. Applying it
      // again would double the position, which is the worse of the two errors.
      const { broker, ws } = harness();
      await broker.init();
      await broker.order({ type: 'market', symbol: 'AAPL', size: 10, unitPrice: 100, accountId: 'MOMENTUM01', onEvent: noEvents });

      ws.emit(alpacaOrder({ status: 'filled', filled_qty: '10', filled_avg_price: '100' }));
      await new Promise((resolve) => setImmediate(resolve));

      expect(broker.tracker.positionTracker('AAPL')?.positionSize).toBe(0);
    });

    it('gives the handler back the order it belongs to', async () => {
      const { broker, ws } = harness();
      await broker.init();
      const seen: OrderObj[] = [];

      const handle = await broker.order({
        type: 'market',
        symbol: 'AAPL',
        size: 10,
        unitPrice: 100,
        accountId: 'MOMENTUM01',
        onEvent: async (_event, orderObj) => {
          seen.push(orderObj);
        },
      });

      ws.emit(alpacaOrder({ status: 'filled', filled_qty: '10', filled_avg_price: '100' }));
      await new Promise((resolve) => setImmediate(resolve));

      expect(seen[0]).toBe(handle);
      expect(handle.events).toHaveLength(1);
    });

    it('keeps delivering to other orders when one handler throws', async () => {
      const { broker, ws } = harness();
      await broker.init();
      const delivered: string[] = [];

      rest_nextOrderId(broker, 'order-a');
      await broker.order({
        type: 'market',
        symbol: 'AAPL',
        size: 10,
        unitPrice: 100,
        accountId: 'MOMENTUM01',
        onEvent: async () => {
          throw new Error('handler exploded');
        },
      });
      rest_nextOrderId(broker, 'order-b');
      await broker.order({
        type: 'market',
        symbol: 'MSFT',
        size: 10,
        unitPrice: 100,
        accountId: 'MOMENTUM01',
        onEvent: async () => {
          delivered.push('order-b');
        },
      });

      ws.emit(alpacaOrder({ id: 'order-a', status: 'filled', filled_qty: '10', filled_avg_price: '100' }));
      ws.emit(alpacaOrder({ id: 'order-b', symbol: 'MSFT', status: 'filled', filled_qty: '10', filled_avg_price: '100' }));
      await new Promise((resolve) => setImmediate(resolve));

      expect(delivered).toEqual(['order-b']);
    });
  });

  describe('terminate', () => {
    it('stops listening', async () => {
      const { broker, ws } = harness();
      await broker.init();
      await broker.terminate();
      expect(ws.handlerCount).toBe(0);
    });
  });

  describe('asset', () => {
    it('treats a delisted asset as untradable even though Alpaca still flags it tradable', async () => {
      const { broker, rest } = harness();
      await broker.init();
      const original = rest.getAsset.bind(rest);
      rest.getAsset = async (input) => {
        const { asset } = await original(input);
        return { asset: asset === null ? null : { ...asset, status: 'inactive' } };
      };

      const asset = await broker.asset('AAPL');
      expect(asset?.tradable).toBe(false);
    });
  });
});

/** The fake returns one order shape; this points the next placement at a given id. */
function rest_nextOrderId(broker: AlpacaBroker, id: string): void {
  // Reaches the fake through the broker's own props, which is the only handle a test has.
  const rest: FakeAlpacaRestClient = Reflect.get(Reflect.get(broker, 'props'), 'restClient');
  rest.nextOrder = alpacaOrder({ id });
}
