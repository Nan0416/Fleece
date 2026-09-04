import { BrokerOrderStatus, MarketBrokerOrderEvent } from '@fleece/shared';
import { LedgerService, BrokerOrderService } from '@fleece/core';
import { BrokerOrderEventJob, OrderTrackingFacade } from '../src/order-tracking-facade';
import { FakeBrokerOrderService, FakeLedgerService } from './fake-ledger';

// Market orders throughout: the facade never branches on order type, so a union of
// them would add noise without adding a case.
function event(overrides: Partial<MarketBrokerOrderEvent> = {}): MarketBrokerOrderEvent {
  return {
    orderType: 'market',
    broker: 'alpaca',
    brokerAccountId: 'PAPER001',
    live: false,
    id: 'order-1',
    status: 'new',
    symbol: 'AAPL',
    assetClass: 'equity',
    timeInForce: 'day',
    orderClass: 'regular',
    side: 'buy',
    extendedHours: false,
    limitPrice: undefined,
    stopPrice: undefined,
    qty: 10,
    filledQty: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function job(overrides: Partial<MarketBrokerOrderEvent> = {}, jobOverrides: Partial<BrokerOrderEventJob> = {}): BrokerOrderEventJob {
  const built = event(overrides);
  return { event: built, originalEvent: { id: built.id }, broker: 'alpaca', brokerAccountId: 'PAPER001', live: false, ...jobOverrides };
}

describe('OrderTrackingFacade', () => {
  let ledger: FakeLedgerService;
  let brokerOrders: FakeBrokerOrderService;
  let facade: OrderTrackingFacade;

  beforeEach(() => {
    ledger = new FakeLedgerService();
    brokerOrders = new FakeBrokerOrderService();
    facade = new OrderTrackingFacade({
      ledgerService: ledger as unknown as LedgerService,
      brokerOrderService: brokerOrders as unknown as BrokerOrderService,
      defaultAccountIdProvider: (_broker, _brokerAccountId, live) => (live ? 'DEFAULTLIVE' : 'DEFAULTPAPR'),
      unresolvedTimeoutMs: 50,
    });
  });

  afterEach(() => {
    facade.stop();
  });

  describe('attributing an event to a virtual account', () => {
    it('trusts the correlation the broker echoed back', async () => {
      facade.enqueue(job({ accountId: 'MOMENTUM01', groupId: 'group-1', status: 'filled', filledQty: 10, filledAvgPrice: 100 }));
      await facade.drain();

      expect(brokerOrders.orders.get('order-1')?.accountId).toBe('MOMENTUM01');
      expect(ledger.fills[0].accountId).toBe('MOMENTUM01');
    });

    it('falls back to the account the order was already recorded under', async () => {
      facade.enqueue(job({ accountId: 'MOMENTUM01' }));
      await facade.drain();
      // A later event with no correlation — a leg, or a replaced order.
      facade.enqueue(job({ accountId: undefined, status: 'filled', filledQty: 10, filledAvgPrice: 100 }));
      await facade.drain();

      expect(ledger.fills[0].accountId).toBe('MOMENTUM01');
    });

    it('uses a tracking request for an order the broker could not attribute', async () => {
      facade.track({ brokerOrderIds: ['order-1'], accountId: 'REVERSION1', groupId: 'group-9' });
      await facade.drain();
      facade.enqueue(job({ accountId: undefined, status: 'filled', filledQty: 10, filledAvgPrice: 100 }));
      await facade.drain();

      expect(brokerOrders.orders.get('order-1')?.accountId).toBe('REVERSION1');
      expect(brokerOrders.orders.get('order-1')?.groupId).toBe('group-9');
    });
  });

  describe('an event that cannot be attributed yet', () => {
    it('is held rather than applied, so a late tracking request can still claim it', async () => {
      facade.enqueue(job({ accountId: undefined, status: 'filled', filledQty: 10, filledAvgPrice: 100 }));
      await facade.drain();

      expect(ledger.fills).toHaveLength(0);
      expect(brokerOrders.orders.size).toBe(0);
    });

    it('is applied to the claiming account once the tracking request arrives', async () => {
      facade.enqueue(job({ accountId: undefined, status: 'filled', filledQty: 10, filledAvgPrice: 100 }));
      await facade.drain();

      facade.track({ brokerOrderIds: ['order-1'], accountId: 'REVERSION1', groupId: 'group-9' });
      await facade.drain();

      expect(ledger.fills).toHaveLength(1);
      expect(ledger.fills[0].accountId).toBe('REVERSION1');
    });

    it('falls back to the default account once waiting is given up on', async () => {
      // An order placed by hand on the broker's website: the shares moved whether or
      // not a strategy asked for them, so it has to land somewhere.
      facade.enqueue(job({ accountId: undefined, status: 'filled', filledQty: 10, filledAvgPrice: 100 }));
      await facade.drain();
      await new Promise((resolve) => setTimeout(resolve, 120));
      await facade.drain();

      expect(ledger.fills).toHaveLength(1);
      expect(ledger.fills[0].accountId).toBe('DEFAULTPAPR');
      expect(brokerOrders.orders.get('order-1')?.groupId).toBeUndefined();
    });

    it("sends a live account's orphans to the live default, never the paper one", async () => {
      facade.enqueue(job({ accountId: undefined, status: 'filled', filledQty: 10, filledAvgPrice: 100 }, { live: true }));
      await facade.drain();
      await new Promise((resolve) => setTimeout(resolve, 120));
      await facade.drain();

      expect(ledger.fills[0].accountId).toBe('DEFAULTLIVE');
    });

    it('applies held events in the order they arrived', async () => {
      facade.enqueue(job({ accountId: undefined, status: 'partially_filled', filledQty: 4, filledAvgPrice: 100 }));
      facade.enqueue(job({ accountId: undefined, status: 'filled', filledQty: 10, filledAvgPrice: 106 }));
      await facade.drain();

      facade.track({ brokerOrderIds: ['order-1'], accountId: 'MOMENTUM01' });
      await facade.drain();

      expect(ledger.fills.map((fill) => fill.cumulativeFilledSize)).toEqual([4, 10]);
    });
  });

  describe('recording fills', () => {
    it.each<BrokerOrderStatus>(['new', 'accepted', 'canceled', 'expired', 'rejected'])('records no fill for a %s event', async (status) => {
      facade.enqueue(job({ accountId: 'MOMENTUM01', status }));
      await facade.drain();
      expect(ledger.fills).toHaveLength(0);
    });

    it('passes the cumulative figures through, leaving the delta to the ledger', async () => {
      facade.enqueue(job({ accountId: 'MOMENTUM01', status: 'partially_filled', filledQty: 4, filledAvgPrice: 100 }));
      facade.enqueue(job({ accountId: 'MOMENTUM01', status: 'filled', filledQty: 10, filledAvgPrice: 106, filledAt: 5_000 }));
      await facade.drain();

      expect(ledger.fills.map((fill) => [fill.cumulativeFilledSize, fill.cumulativeFilledAvgPrice])).toEqual([
        [4, 100],
        [10, 106],
      ]);
      expect(ledger.netSize('MOMENTUM01', 'AAPL')).toBe(10);
    });

    it('dates a fill by when it filled, not by when the event was handled', async () => {
      facade.enqueue(job({ accountId: 'MOMENTUM01', status: 'filled', filledQty: 10, filledAvgPrice: 100, filledAt: 7_000, updatedAt: 9_000 }));
      await facade.drain();
      expect(ledger.fills[0].timestamp).toBe(7_000);
    });

    it('records nothing when a fill arrives with no price rather than writing a NaN', async () => {
      facade.enqueue(job({ accountId: 'MOMENTUM01', status: 'filled', filledQty: 10, filledAvgPrice: undefined }));
      await facade.drain();
      expect(ledger.fills).toHaveLength(0);
    });
  });

  describe('recording an option fill', () => {
    it('scales the size by the contract multiplier and leaves the premium alone', async () => {
      // One contract at 3.85 is $385 of cash. Booking the size in units of the
      // underlying keeps `size * price` in dollars, so this account's realised profit
      // can be added to an equity trade's without being 100x light.
      facade.enqueue(job({ accountId: 'MOMENTUM01', assetClass: 'option', symbol: 'AMZN261016C00280000', status: 'filled', filledQty: -1, filledAvgPrice: 3.85 }));
      await facade.drain();

      expect(ledger.fills[0].cumulativeFilledSize).toBe(-100);
      expect(ledger.fills[0].cumulativeFilledAvgPrice).toBe(3.85);
    });

    it('leaves an equity fill unscaled', async () => {
      facade.enqueue(job({ accountId: 'MOMENTUM01', status: 'filled', filledQty: 10, filledAvgPrice: 100 }));
      await facade.drain();
      expect(ledger.fills[0].cumulativeFilledSize).toBe(10);
    });
  });

  describe('recording a multi-leg option fill', () => {
    /**
     * The spread from `packages/playground/data/live-options-filled.json` as the
     * converter now renders it: three flat events, not one nested one. The parent has no
     * symbol and a net credit for a price; each leg names it in `parentBrokerOrderId`.
     */
    const parent = (): Partial<MarketBrokerOrderEvent> => ({
      id: 'mleg-parent-1',
      accountId: 'MOMENTUM01',
      orderClass: 'mleg',
      symbol: '',
      assetClass: 'option',
      side: undefined,
      status: 'filled',
      qty: 1,
      filledQty: 1,
      filledAvgPrice: -0.9,
    });

    const shortLeg = (): Partial<MarketBrokerOrderEvent> => ({
      id: 'mleg-leg-short',
      parentBrokerOrderId: 'mleg-parent-1',
      accountId: 'MOMENTUM01',
      orderClass: 'mleg',
      symbol: 'AMZN261016C00280000',
      assetClass: 'option',
      side: 'sell',
      status: 'filled',
      qty: -1,
      filledQty: -1,
      filledAvgPrice: 3.85,
    });

    const longLeg = (): Partial<MarketBrokerOrderEvent> => ({
      id: 'mleg-leg-long',
      parentBrokerOrderId: 'mleg-parent-1',
      accountId: 'MOMENTUM01',
      orderClass: 'mleg',
      symbol: 'AMZN261016C00285000',
      assetClass: 'option',
      side: 'buy',
      status: 'filled',
      qty: 1,
      filledQty: 1,
      filledAvgPrice: 2.95,
    });

    function enqueueSpread(): void {
      facade.enqueue(job(parent()));
      facade.enqueue(job(shortLeg()));
      facade.enqueue(job(longLeg()));
    }

    it('books the legs and never the parent, whose symbol is empty', async () => {
      enqueueSpread();
      await facade.drain();

      expect(ledger.fills.map((fill) => [fill.referenceId, fill.symbol, fill.cumulativeFilledSize, fill.cumulativeFilledAvgPrice])).toEqual([
        ['mleg-leg-short', 'AMZN261016C00280000', -100, 3.85],
        ['mleg-leg-long', 'AMZN261016C00285000', 100, 2.95],
      ]);
      // The parent's -0.9 is the spread's net credit, not a price any contract traded
      // at, and '' is not an instrument. Booking either is the bug this guards.
      expect(ledger.fills.some((fill) => fill.symbol === '')).toBe(false);
    });

    it('records a broker order for every leg, so a fill reference resolves to an order', async () => {
      // Before flattening, a leg had no row at all: an option fill wrote a transaction
      // whose referenceId named an order the ledger held nothing for.
      enqueueSpread();
      await facade.drain();

      expect(brokerOrders.orders.get('mleg-leg-short')?.symbol).toBe('AMZN261016C00280000');
      expect(brokerOrders.orders.get('mleg-leg-long')?.symbol).toBe('AMZN261016C00285000');
      // The parent is still recorded: it is the id a cancel or a tracking request names.
      expect(brokerOrders.orders.get('mleg-parent-1')?.symbol).toBe('');
    });

    it('gives each leg its own reference id, so a redelivered spread stays idempotent', async () => {
      enqueueSpread();
      enqueueSpread();
      await facade.drain();

      expect(ledger.fills).toHaveLength(4);
      expect(ledger.netSize('MOMENTUM01', 'AMZN261016C00280000')).toBe(-100);
      expect(ledger.netSize('MOMENTUM01', 'AMZN261016C00285000')).toBe(100);
    });

    it('attributes the legs to the account the parent was correlated to', async () => {
      facade.enqueue(job({ ...parent(), accountId: 'REVERSION1' }));
      facade.enqueue(job({ ...shortLeg(), accountId: 'REVERSION1' }));
      facade.enqueue(job({ ...longLeg(), accountId: 'REVERSION1' }));
      await facade.drain();

      expect(ledger.fills.every((fill) => fill.accountId === 'REVERSION1')).toBe(true);
    });

    it('books the leg that filled while the spread is only partially filled', async () => {
      // Each leg is judged on its own status now, rather than the parent's.
      facade.enqueue(job({ ...parent(), status: 'partially_filled', filledQty: 0, filledAvgPrice: undefined }));
      facade.enqueue(job(shortLeg()));
      facade.enqueue(job({ ...longLeg(), status: 'new', filledQty: 0, filledAvgPrice: undefined }));
      await facade.drain();

      expect(ledger.fills).toHaveLength(1);
      expect(ledger.fills[0].referenceId).toBe('mleg-leg-short');
    });

    it('records nothing for the parent even when it reports a filled quantity and a price', async () => {
      facade.enqueue(job(parent()));
      await facade.drain();
      expect(ledger.fills).toHaveLength(0);
    });
  });

  describe('keeping the broker order up to date', () => {
    it('creates it on the first event and updates its status after', async () => {
      facade.enqueue(job({ accountId: 'MOMENTUM01', status: 'new' }));
      await facade.drain();
      expect(brokerOrders.orders.get('order-1')?.status).toBe('new');

      facade.enqueue(job({ accountId: 'MOMENTUM01', status: 'filled', filledQty: 10, filledAvgPrice: 100 }));
      await facade.drain();
      expect(brokerOrders.orders.get('order-1')?.status).toBe('filled');
    });

    it('binds a group to an order that has none', async () => {
      facade.enqueue(job({ accountId: 'MOMENTUM01', groupId: undefined }));
      await facade.drain();
      facade.enqueue(job({ accountId: 'MOMENTUM01', groupId: 'group-1' }));
      await facade.drain();

      expect(brokerOrders.orders.get('order-1')?.groupId).toBe('group-1');
    });

    it('never moves an order to a different group', async () => {
      facade.enqueue(job({ accountId: 'MOMENTUM01', groupId: 'group-1' }));
      await facade.drain();
      facade.enqueue(job({ accountId: 'MOMENTUM01', groupId: 'group-2' }));
      await facade.drain();

      expect(brokerOrders.orders.get('order-1')?.groupId).toBe('group-1');
    });

    it('keeps every raw broker event, so an execution can be replayed', async () => {
      facade.enqueue(job({ accountId: 'MOMENTUM01', status: 'new' }));
      facade.enqueue(job({ accountId: 'MOMENTUM01', status: 'partially_filled', filledQty: 4, filledAvgPrice: 100 }));
      facade.enqueue(job({ accountId: 'MOMENTUM01', status: 'filled', filledQty: 10, filledAvgPrice: 106 }));
      await facade.drain();

      expect(brokerOrders.records).toHaveLength(3);
    });
  });

  describe('ordering', () => {
    it('handles events for one order one at a time, so the order is created once', async () => {
      // Enqueued together and never awaited individually: without the queue both would
      // find no broker order and both would try to create it.
      facade.enqueue(job({ accountId: 'MOMENTUM01', status: 'partially_filled', filledQty: 4, filledAvgPrice: 100 }));
      facade.enqueue(job({ accountId: 'MOMENTUM01', status: 'filled', filledQty: 10, filledAvgPrice: 106 }));
      await facade.drain();

      expect(brokerOrders.orders.size).toBe(1);
      expect(ledger.fills).toHaveLength(2);
    });
  });
});
