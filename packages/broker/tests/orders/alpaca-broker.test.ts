import { AlpacaActiveSynchronization, decodeAlpacaOrderCorrelation } from '@fleece/alpaca';
import { BrokerOrderEvent } from '@fleece/shared';
import { createAlpacaBroker } from '../../src/create-alpaca-broker';
import { NotReservableError } from '../../src/models/errors';
import { MultiLegOrderRequest, MultiLegOrderRequestLeg } from '../../src/models/requests';
import { AlpacaBroker } from '../../src/orders/alpaca-broker';
import { AnnouncingOrderPlacer } from '../../src/placement/announcing-order-placer';
import { CorrelatedOrderPlacer } from '../../src/placement/correlated-order-placer';
import { AccountReservations } from '../../src/reservations/account-reservations';
import { d, shows } from '../decimals';
import { alpacaOrder, FakeAlpacaRestClient, FakeAlpacaWsClient, filledMultiLegOrder, LONG_LEG_SYMBOL, RecordingOrderTrackingClient, SHORT_LEG_SYMBOL } from '../fake-alpaca';

const account = { accountId: 'PAPER001', live: false };
const noEvents = async (): Promise<void> => {};
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
};

interface Harness {
  readonly broker: AlpacaBroker;
  readonly rest: FakeAlpacaRestClient;
  readonly ws: FakeAlpacaWsClient;
  readonly tracking: RecordingOrderTrackingClient;
  readonly reservations?: AccountReservations;
}

/**
 * Every broker built here is torn down afterwards. `init` starts a polling interval, and
 * an interval left running holds the process open — which surfaces as the whole suite
 * hanging rather than as a failing test.
 */
const built: AlpacaBroker[] = [];

/** The stack assembled by hand, so a test can reach the layer it is about. */
function harness(options: { readonly withReservations?: boolean } = {}): Harness {
  const rest = new FakeAlpacaRestClient();
  const ws = new FakeAlpacaWsClient();
  const tracking = new RecordingOrderTrackingClient();
  const activeSync = new AlpacaActiveSynchronization({ account, restClient: rest, tickMs: 60_000 });
  const placer = new AnnouncingOrderPlacer({ placer: new CorrelatedOrderPlacer({ restClient: rest }), trackingClient: tracking });
  const reservations = options.withReservations === false ? undefined : new AccountReservations({ account, reader: rest, now: () => 1_000 });

  const broker = new AlpacaBroker({ account, placer, assets: rest, wsClient: ws, activeSync, reservations, now: () => 1_000 });
  built.push(broker);
  return { broker, rest, ws, tracking, reservations };
}

const spreadLegs: ReadonlyArray<MultiLegOrderRequestLeg> = [
  { symbol: SHORT_LEG_SYMBOL, ratioQty: d(1), side: 'sell', positionIntent: 'sell_to_open' },
  { symbol: LONG_LEG_SYMBOL, ratioQty: d(1), side: 'buy', positionIntent: 'buy_to_open' },
];

function spread(overrides: Partial<MultiLegOrderRequest> = {}): MultiLegOrderRequest {
  return { type: 'mleg', size: d(1), legs: spreadLegs, netLimitPrice: d('-0.85'), accountId: 'MOMENTUM01', onEvent: async () => {}, ...overrides };
}

afterEach(async () => {
  for (const broker of built.splice(0)) {
    await broker.terminate();
  }
});

describe('AlpacaBroker', () => {
  describe('placing an order', () => {
    it('holds what the order needs before sending it', async () => {
      const { broker, rest, reservations } = harness();
      await broker.init();

      await broker.order({ type: 'limit', symbol: 'AAPL', size: d(10), assetClass: 'equity', limitPrice: d(100), accountId: 'MOMENTUM01', onEvent: noEvents });

      expect(rest.created).toHaveLength(1);
      expect(shows(reservations?.availableBuyingPower)).toBe('99000');
    });

    it('encodes the virtual account into the client order id', async () => {
      const { broker, rest } = harness();
      await broker.init();

      await broker.order({ type: 'market', symbol: 'AAPL', size: d(10), assetClass: 'equity', unitPrice: d(100), accountId: 'MOMENTUM01', onEvent: noEvents });

      const correlation = decodeAlpacaOrderCorrelation(rest.created[0].clientOrderId ?? '');
      expect(correlation.virtualAccountId).toBe('MOMENTUM01');
      expect(correlation.reservationId).toEqual(expect.any(String));
    });

    it('refuses an order the account cannot support, without sending anything', async () => {
      const { broker, rest } = harness();
      rest.buyingPower = '500';
      await broker.init();

      await expect(
        broker.order({ type: 'limit', symbol: 'AAPL', size: d(10), assetClass: 'equity', limitPrice: d(100), accountId: 'MOMENTUM01', onEvent: noEvents }),
      ).rejects.toThrow(NotReservableError);
      expect(rest.created).toHaveLength(0);
    });

    it('releases the hold when the request never reaches the broker', async () => {
      // Otherwise a run of failed placements would silently exhaust the account.
      const { broker, rest, reservations } = harness();
      await broker.init();
      const before = shows(reservations?.availableBuyingPower);
      rest.failNextCreate = new Error('connection reset');

      await expect(
        broker.order({ type: 'limit', symbol: 'AAPL', size: d(10), assetClass: 'equity', limitPrice: d(100), accountId: 'MOMENTUM01', onEvent: noEvents }),
      ).rejects.toThrow('connection reset');
      expect(shows(reservations?.availableBuyingPower)).toBe(before);
    });

    it('tells the tracking service which account the order belongs to', async () => {
      const { broker, tracking } = harness();
      await broker.init();

      await broker.order({ type: 'market', symbol: 'AAPL', size: d(10), assetClass: 'equity', unitPrice: d(100), accountId: 'MOMENTUM01', onEvent: noEvents });

      expect(tracking.requests).toEqual([{ brokerOrderIds: ['alpaca-order-1'], accountId: 'MOMENTUM01' }]);
    });

    it('still returns the order when the tracking service could not be told', async () => {
      // The order is placed and the shares are moving; throwing here would leave the
      // caller believing it failed.
      const { broker, tracking } = harness();
      await broker.init();
      tracking.failNext = new Error('no transport configured');

      const handle = await broker.order({ type: 'market', symbol: 'AAPL', size: d(10), assetClass: 'equity', unitPrice: d(100), accountId: 'MOMENTUM01', onEvent: noEvents });
      expect(handle.brokerOrderId).toBe('alpaca-order-1');
    });

    it('rejects a size of zero before holding anything', async () => {
      const { broker, rest } = harness();
      await broker.init();
      await expect(
        broker.order({ type: 'market', symbol: 'AAPL', size: d(0), assetClass: 'equity', unitPrice: d(100), accountId: 'MOMENTUM01', onEvent: noEvents }),
      ).rejects.toThrow(/non-zero/);
      expect(rest.created).toHaveLength(0);
    });

    it('places a fractional size, which Alpaca fills and the legacy refused', async () => {
      const { broker, rest } = harness();
      await broker.init();

      await broker.order({ type: 'limit', symbol: 'AAPL', size: d('1.5'), assetClass: 'equity', limitPrice: d(100), accountId: 'MOMENTUM01', onEvent: noEvents });

      expect(rest.createdSingle[0].size).toBe(1.5);
    });

    it('sends a sell as an absolute quantity with a sell side', async () => {
      const { broker, rest } = harness();
      rest.positions = [{ symbol: 'AAPL', asset_id: 'a', asset_class: 'us_equity', qty: '10', avg_entry_price: '100', side: 'long', market_value: '1000', cost_basis: '1000' }];
      await broker.init();

      await broker.order({ type: 'limit', symbol: 'AAPL', size: d(-4), assetClass: 'equity', limitPrice: d(150), accountId: 'MOMENTUM01', onEvent: noEvents });

      expect(rest.createdSingle[0].size).toBe(4);
      expect(rest.createdSingle[0].side).toBe('sell');
    });

    it('places without holding anything when no reservations are installed', async () => {
      // Which is what makes an instrument nothing here can price placeable at all.
      const { broker, rest } = harness({ withReservations: false });
      await broker.init();

      await broker.order({ type: 'limit', symbol: 'AAPL', size: d(10), assetClass: 'equity', limitPrice: d(1_000_000), accountId: 'MOMENTUM01', onEvent: noEvents });

      expect(rest.created).toHaveLength(1);
      expect(broker.tracker).toBeUndefined();
    });
  });

  describe('placing a spread', () => {
    it('returns one handle for the spread, carrying a view of each contract', async () => {
      const { broker } = harness();
      await broker.init();

      const handle = await broker.order(spread());

      expect(handle.kind).toBe('multi-leg');
      expect(handle.brokerOrderId).toBe('mleg-parent');
      expect(handle.legs.map((leg) => leg.symbol)).toEqual([SHORT_LEG_SYMBOL, LONG_LEG_SYMBOL]);
      expect(handle.legs.map((leg) => leg.brokerOrderId)).toEqual(['mleg-leg-short', 'mleg-leg-long']);
      expect(handle.legs.every((leg) => leg.parentBrokerOrderId === 'mleg-parent')).toBe(true);
    });

    it('sends the net price signed, and the legs with their ratios and intents', async () => {
      const { broker, rest } = harness();
      await broker.init();

      await broker.order(spread());

      expect(rest.created[0]).toMatchObject({
        type: 'limit',
        size: 1,
        netLimitPrice: -0.85,
        legs: [
          { symbol: SHORT_LEG_SYMBOL, ratioQty: 1, side: 'sell', positionIntent: 'sell_to_open' },
          { symbol: LONG_LEG_SYMBOL, ratioQty: 1, side: 'buy', positionIntent: 'buy_to_open' },
        ],
      });
    });

    it('places a spread with no net price as a market order', async () => {
      const { broker, rest } = harness();
      await broker.init();

      await broker.order(spread({ netLimitPrice: undefined }));

      expect(rest.created[0]).toMatchObject({ type: 'market' });
    });

    it('cancels the spread, which is the only cancellation the broker offers', async () => {
      const { broker, rest } = harness();
      await broker.init();

      const handle = await broker.order(spread());
      await handle.cancel();

      expect(rest.cancelled).toEqual(['mleg-parent']);
    });

    it('holds nothing against it, and places it anyway', async () => {
      const { broker, rest, reservations } = harness();
      await broker.init();

      await broker.order(spread());

      expect(rest.created).toHaveLength(1);
      expect(shows(reservations?.availableBuyingPower)).toBe('100000');
    });

    it('pairs the legs on symbol rather than on position, since Alpaca does not promise an order', async () => {
      const { broker, rest } = harness();
      await broker.init();
      // The same spread, returned long leg first.
      const returned = rest.nextMultiLegOrder;
      rest.nextMultiLegOrder = { ...returned, legs: [...(returned.legs ?? [])].reverse() };

      const handle = await broker.order(spread());

      expect(handle.legs.map((leg) => leg.symbol)).toEqual([SHORT_LEG_SYMBOL, LONG_LEG_SYMBOL]);
      expect(handle.legs.map((leg) => leg.brokerOrderId)).toEqual(['mleg-leg-short', 'mleg-leg-long']);
    });

    it('refuses a spread whose contracts came back different from the ones asked for', async () => {
      const { broker, rest } = harness();
      await broker.init();
      const returned = rest.nextMultiLegOrder;
      rest.nextMultiLegOrder = { ...returned, legs: [{ ...(returned.legs ?? [])[0], symbol: 'AMZN261016C00999000' }] };

      await expect(broker.order(spread())).rejects.toThrow(/cannot be tracked|was asked to trade/);
    });

    it.each([
      ['a size that is not a count of spreads', { size: d(-1) }, /always positive/],
      ['fewer than two legs', { legs: [spreadLegs[0]] }, /two to four legs/],
      ['a leg with no ratio', { legs: [{ ...spreadLegs[0], ratioQty: d(0) }, spreadLegs[1]] }, /always positive/],
    ])('refuses %s', async (_name, overrides, message) => {
      const { broker, rest } = harness();
      await broker.init();

      await expect(broker.order(spread(overrides))).rejects.toThrow(message);
      expect(rest.created).toHaveLength(0);
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
        size: d(10),
        assetClass: 'equity',
        unitPrice: d(100),
        accountId: 'MOMENTUM01',
        onEvent: async (event) => {
          received.push(event);
        },
      });

      ws.emit(alpacaOrder({ status: 'filled', filled_qty: '10', filled_avg_price: '100' }));
      await settle();

      expect(received.map((event) => event.status)).toEqual(['filled']);
    });

    it('tells a spread once per message, with every contract already updated', async () => {
      // The property worth having: a caller asked "what happened?" never sees a parent
      // that has filled beside a contract that has not heard.
      const { broker, ws } = harness();
      await broker.init();
      const notifications: ReadonlyArray<BrokerOrderEvent>[] = [];
      let legsAtFirstCall: ReadonlyArray<string> = [];

      const handle = await broker.order(
        spread({
          onEvent: async (events, orderObj) => {
            notifications.push(events);
            legsAtFirstCall = orderObj.legs.map((leg) => leg.latestEvent?.status ?? 'none');
          },
        }),
      );

      ws.emit(filledMultiLegOrder());
      await settle();

      expect(notifications).toHaveLength(1);
      expect(notifications[0].map((event) => event.id)).toEqual(['mleg-parent', 'mleg-leg-short', 'mleg-leg-long']);
      expect(legsAtFirstCall).toEqual(['filled', 'filled']);
      expect(handle.legs.map((leg) => shows(leg.latestEvent?.filledAvgPrice))).toEqual(['3.85', '2.95']);
    });

    it('books a spread against its contracts, and the parent against nothing', async () => {
      const { broker, ws, reservations } = harness();
      await broker.init();
      await broker.order(spread());

      ws.emit(filledMultiLegOrder());
      await settle();

      expect(shows(reservations?.tracker.positionTracker(SHORT_LEG_SYMBOL)?.totalCost)).toBe('-385');
      expect(shows(reservations?.tracker.positionTracker(LONG_LEG_SYMBOL)?.totalCost)).toBe('295');
      expect(reservations?.tracker.positionTracker('')).toBeUndefined();
    });

    it('moves the position as fills arrive', async () => {
      const { broker, rest, ws, reservations } = harness();
      await broker.init();
      await broker.order({ type: 'market', symbol: 'AAPL', size: d(10), assetClass: 'equity', unitPrice: d(100), accountId: 'MOMENTUM01', onEvent: noEvents });

      // Alpaca echoes the client order id back on every event, which is how the
      // reservation reaches the tracker. An event without it is a different case.
      ws.emit(alpacaOrder({ client_order_id: rest.created[0].clientOrderId, status: 'filled', filled_qty: '10', filled_avg_price: '100' }));
      await settle();

      expect(shows(reservations?.tracker.positionTracker('AAPL')?.positionSize)).toBe('10');
      expect(shows(reservations?.tracker.positionTracker('AAPL')?.unitCost)).toBe('100');
    });

    it('ignores a terminal event whose reservation is already gone', async () => {
      // A very late duplicate of something the poller already applied. Applying it again
      // would double the position, which is the worse of the two errors.
      const { broker, ws, reservations } = harness();
      await broker.init();
      await broker.order({ type: 'market', symbol: 'AAPL', size: d(10), assetClass: 'equity', unitPrice: d(100), accountId: 'MOMENTUM01', onEvent: noEvents });

      ws.emit(alpacaOrder({ status: 'filled', filled_qty: '10', filled_avg_price: '100' }));
      await settle();

      expect(shows(reservations?.tracker.positionTracker('AAPL')?.positionSize)).toBe('0');
    });

    it('gives the handler back the order it belongs to', async () => {
      const { broker, ws } = harness();
      await broker.init();
      const seen: unknown[] = [];

      const handle = await broker.order({
        type: 'market',
        symbol: 'AAPL',
        size: d(10),
        assetClass: 'equity',
        unitPrice: d(100),
        accountId: 'MOMENTUM01',
        onEvent: async (_event, orderObj) => {
          seen.push(orderObj);
        },
      });

      ws.emit(alpacaOrder({ status: 'filled', filled_qty: '10', filled_avg_price: '100' }));
      await settle();

      expect(seen[0]).toBe(handle);
      expect(handle.events).toHaveLength(1);
    });

    it('keeps delivering to other orders when one handler throws', async () => {
      const { broker, rest, ws } = harness();
      await broker.init();
      const delivered: string[] = [];

      rest.nextOrder = alpacaOrder({ id: 'order-a' });
      await broker.order({
        type: 'market',
        symbol: 'AAPL',
        size: d(10),
        assetClass: 'equity',
        unitPrice: d(100),
        accountId: 'MOMENTUM01',
        onEvent: async () => {
          throw new Error('handler exploded');
        },
      });
      rest.nextOrder = alpacaOrder({ id: 'order-b' });
      await broker.order({
        type: 'market',
        symbol: 'MSFT',
        size: d(10),
        assetClass: 'equity',
        unitPrice: d(100),
        accountId: 'MOMENTUM01',
        onEvent: async () => {
          delivered.push('order-b');
        },
      });

      ws.emit(alpacaOrder({ id: 'order-a', status: 'filled', filled_qty: '10', filled_avg_price: '100' }));
      ws.emit(alpacaOrder({ id: 'order-b', symbol: 'MSFT', status: 'filled', filled_qty: '10', filled_avg_price: '100' }));
      await settle();

      expect(delivered).toEqual(['order-b']);
    });
  });

  describe('an OTO pair', () => {
    it('hands back two handles, each cancellable on its own', async () => {
      const { broker, rest } = harness();
      await broker.init();
      rest.nextOrder = alpacaOrder({ id: 'entry-1', legs: [alpacaOrder({ id: 'exit-1' })] });

      const pair = await broker.order({
        type: 'oto',
        symbol: 'AAPL',
        size: d(10),
        assetClass: 'equity',
        limitPrice: d(100),
        takeProfitLimitPrice: d(120),
        accountId: 'MOMENTUM01',
        onEvent: noEvents,
        onTakeProfitEvent: noEvents,
      });

      expect([pair.entryOrder.brokerOrderId, pair.exitOrder.brokerOrderId]).toEqual(['entry-1', 'exit-1']);
      await pair.exitOrder.cancel();
      expect(rest.cancelled).toEqual(['exit-1']);
    });

    it('delivers one payload to both handles', async () => {
      // Alpaca returns the exit nested inside the entry and sends no separate websocket
      // event for it, so one message has to feed both.
      const { broker, rest, ws } = harness();
      await broker.init();
      rest.nextOrder = alpacaOrder({ id: 'entry-1', legs: [alpacaOrder({ id: 'exit-1' })] });
      const entrySeen: string[] = [];
      const exitSeen: string[] = [];

      await broker.order({
        type: 'oto',
        symbol: 'AAPL',
        size: d(10),
        assetClass: 'equity',
        limitPrice: d(100),
        takeProfitLimitPrice: d(120),
        accountId: 'MOMENTUM01',
        onEvent: async (event) => {
          entrySeen.push(event.status);
        },
        onTakeProfitEvent: async (event) => {
          exitSeen.push(event.status);
        },
      });

      ws.emit(alpacaOrder({ id: 'entry-1', status: 'filled', filled_qty: '10', filled_avg_price: '100', legs: [alpacaOrder({ id: 'exit-1', status: 'new' })] }));
      await settle();

      expect(entrySeen).toEqual(['filled']);
      expect(exitSeen).toEqual(['new']);
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

  describe('createAlpacaBroker', () => {
    it('assembles a stack that holds, correlates and announces', async () => {
      const rest = new FakeAlpacaRestClient();
      const ws = new FakeAlpacaWsClient();
      const tracking = new RecordingOrderTrackingClient();
      const activeSync = new AlpacaActiveSynchronization({ account, restClient: rest, tickMs: 60_000 });

      const broker = createAlpacaBroker({ account, restClient: rest, wsClient: ws, activeSync, trackingClient: tracking, now: () => 1_000 });
      built.push(broker);
      await broker.init();

      await broker.order({ type: 'limit', symbol: 'AAPL', size: d(10), assetClass: 'equity', limitPrice: d(100), accountId: 'MOMENTUM01', onEvent: noEvents });

      expect(shows(broker.tracker?.availableBuyingPower)).toBe('99000');
      expect(decodeAlpacaOrderCorrelation(rest.created[0].clientOrderId ?? '').virtualAccountId).toBe('MOMENTUM01');
      expect(tracking.requests).toHaveLength(1);
    });
  });
});
