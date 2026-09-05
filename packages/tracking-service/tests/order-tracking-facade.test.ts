import { BrokerOrderStatus, Decimal, MarketBrokerOrderEvent } from '@fleece/shared';
import { LedgerService, BrokerOrderService } from '@fleece/core';
import { BrokerOrderEventJob, OrderTrackingFacade } from '../src/order-tracking-facade';
import { FakeBrokerOrderService, FakeLedgerService } from './fake-ledger';

/**
 * Quantities are written as plain numbers here and converted on the way in, so a case
 * still reads as "one contract at 3.85" rather than as a wall of constructors. The
 * facade sees `Decimal` throughout, which is what it is under test with.
 */
type EventOverrides = Omit<Partial<MarketBrokerOrderEvent>, 'qty' | 'filledQty' | 'filledAvgPrice' | 'multiplier'> & {
  readonly qty?: number;
  readonly filledQty?: number;
  readonly filledAvgPrice?: number;
  readonly multiplier?: number;
};

const d = (value: number): Decimal => Decimal.of(value);
const optional = (value: number | undefined): Decimal | undefined => (value === undefined ? undefined : Decimal.of(value));

// Market orders throughout: the facade never branches on order type, so a union of
// them would add noise without adding a case.
function event(overrides: EventOverrides = {}): MarketBrokerOrderEvent {
  const { qty, filledQty, filledAvgPrice, multiplier, ...rest } = overrides;
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
    createdAt: 1_000,
    updatedAt: 1_000,
    ...rest,
    qty: d(qty ?? 10),
    filledQty: d(filledQty ?? 0),
    filledAvgPrice: optional(filledAvgPrice),
    multiplier: optional(multiplier),
  };
}

function job(overrides: EventOverrides = {}, jobOverrides: Partial<BrokerOrderEventJob> = {}): BrokerOrderEventJob {
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
      facade.enqueue(job({ accountId: 'MOMENTUM01', status: 'filled', filledQty: 10, filledAvgPrice: 100 }));
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
      facade.track({ brokerOrderIds: ['order-1'], accountId: 'REVERSION1' });
      await facade.drain();
      facade.enqueue(job({ accountId: undefined, status: 'filled', filledQty: 10, filledAvgPrice: 100 }));
      await facade.drain();

      expect(brokerOrders.orders.get('order-1')?.accountId).toBe('REVERSION1');
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

      facade.track({ brokerOrderIds: ['order-1'], accountId: 'REVERSION1' });
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
      // An order nobody claimed is simply one sitting in the catch-all account, which is
      // how they are found: by account, not by a column marking them.
      expect(brokerOrders.orders.get('order-1')?.accountId).toBe('DEFAULTPAPR');
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

      expect(ledger.fills.map((fill) => fill.cumulativeFilledSize.toString())).toEqual(['4', '10']);
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

      expect(ledger.fills.map((fill) => [fill.cumulativeFilledSize.toString(), fill.cumulativeFilledTotalCost.toString()])).toEqual([
        ['4', '400'],
        ['10', '1060'],
      ]);
      expect(ledger.netSize('MOMENTUM01', 'AAPL').toString()).toBe('10');
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
    it('counts contracts and puts the multiplier into the dollars', async () => {
      // One contract at a premium of 3.85 moved $385. The size stays in contracts —
      // which is what anyone reading a position means — and the multiplier goes into the
      // cost, so this account's realised profit adds to an equity trade's without being
      // 100x light.
      facade.enqueue(job({ accountId: 'MOMENTUM01', assetClass: 'option', symbol: 'AMZN261016C00280000', status: 'filled', filledQty: -1, filledAvgPrice: 3.85 }));
      await facade.drain();

      expect(ledger.fills[0].cumulativeFilledSize.toString()).toBe('-1');
      expect(ledger.fills[0].cumulativeFilledTotalCost.toString()).toBe('-385');
    });

    it('records the multiplier it used, so a contract booked on a wrong assumption is findable', async () => {
      facade.enqueue(job({ accountId: 'MOMENTUM01', assetClass: 'option', symbol: 'AMZN261016C00280000', status: 'filled', filledQty: -1, filledAvgPrice: 3.85 }));
      await facade.drain();
      expect(ledger.fills[0].multiplier.toString()).toBe('100');
    });

    it('honours a multiplier the broker supplied over the default for the asset class', async () => {
      // An adjusted contract delivers something other than 100 shares. Nothing fetches
      // that figure yet, but when something does, this is the path it takes.
      facade.enqueue(job({ accountId: 'MOMENTUM01', assetClass: 'option', symbol: 'AMZN261016C00280000', status: 'filled', filledQty: 1, filledAvgPrice: 4, multiplier: 10 }));
      await facade.drain();
      expect(ledger.fills[0].cumulativeFilledTotalCost.toString()).toBe('40');
      expect(ledger.fills[0].multiplier.toString()).toBe('10');
    });

    it('leaves an equity fill at a multiplier of one', async () => {
      facade.enqueue(job({ accountId: 'MOMENTUM01', status: 'filled', filledQty: 10, filledAvgPrice: 100 }));
      await facade.drain();
      expect(ledger.fills[0].cumulativeFilledSize.toString()).toBe('10');
      expect(ledger.fills[0].cumulativeFilledTotalCost.toString()).toBe('1000');
      expect(ledger.fills[0].multiplier.toString()).toBe('1');
    });
  });

  describe('recording a multi-leg option fill', () => {
    /**
     * The spread from `packages/playground/data/live-options-filled.json` as the
     * converter now renders it: three flat events, not one nested one. The parent has no
     * symbol and a net credit for a price; each leg names it in `parentBrokerOrderId`.
     */
    const parent = (): EventOverrides => ({
      id: 'mleg-parent-1',
      accountId: 'MOMENTUM01',
      orderClass: 'mleg',
      symbol: undefined,
      assetClass: 'option',
      side: undefined,
      status: 'filled',
      qty: 1,
      filledQty: 1,
      filledAvgPrice: -0.9,
    });

    const shortLeg = (): EventOverrides => ({
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

    const longLeg = (): EventOverrides => ({
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

      expect(ledger.fills.map((fill) => [fill.referenceId, fill.symbol, fill.cumulativeFilledSize.toString(), fill.cumulativeFilledTotalCost.toString()])).toEqual([
        ['mleg-leg-short', 'AMZN261016C00280000', '-1', '-385'],
        ['mleg-leg-long', 'AMZN261016C00285000', '1', '295'],
      ]);
      // The parent's -0.9 is the spread's net credit, not a price any contract traded
      // at, and it has no instrument at all. Booking it is the bug this guards.
      expect(ledger.fills.map((fill) => fill.referenceId)).not.toContain('mleg-parent-1');
    });

    it('records a broker order for every leg, so a fill reference resolves to an order', async () => {
      // Before flattening, a leg had no row at all: an option fill wrote a transaction
      // whose referenceId named an order the ledger held nothing for.
      enqueueSpread();
      await facade.drain();

      expect(brokerOrders.orders.get('mleg-leg-short')?.symbol).toBe('AMZN261016C00280000');
      expect(brokerOrders.orders.get('mleg-leg-long')?.symbol).toBe('AMZN261016C00285000');
      // The parent is recorded too — it is the id a cancel or a tracking request names
      // — but with no symbol at all rather than an empty string, which is what the
      // column allows and what stops the old sentinel coming back.
      expect(brokerOrders.orders.get('mleg-parent-1')?.symbol).toBeUndefined();
      // And it keeps the package's signed net, which the legs cannot supply.
      expect(brokerOrders.orders.get('mleg-parent-1')?.filledAvgPrice?.toString()).toBe('-0.9');
    });

    it('gives each leg its own reference id, so a redelivered spread stays idempotent', async () => {
      enqueueSpread();
      enqueueSpread();
      await facade.drain();

      expect(ledger.fills).toHaveLength(4);
      expect(ledger.netSize('MOMENTUM01', 'AMZN261016C00280000').toString()).toBe('-1');
      expect(ledger.netSize('MOMENTUM01', 'AMZN261016C00285000').toString()).toBe('1');
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

    it('leaves an order on the catch-all account even once a real attribution turns up', async () => {
      // The tempting fix is to move it. It would strand every transaction, position and
      // progress counter already written under the old account, and the next cumulative
      // report would find no progress for the new one and book the whole fill again.
      facade.enqueue(job({ accountId: undefined, status: 'partially_filled', filledQty: 4, filledAvgPrice: 100 }, { defaultAccountId: 'DEFAULTPAPR' }));
      await facade.drain();
      expect(brokerOrders.orders.get('order-1')?.accountId).toBe('DEFAULTPAPR');

      facade.enqueue(job({ accountId: 'MOMENTUM01', status: 'filled', filledQty: 10, filledAvgPrice: 106 }));
      await facade.drain();

      expect(brokerOrders.orders.get('order-1')?.accountId).toBe('DEFAULTPAPR');
      // And every fill stayed with it, so nothing was counted twice.
      expect(ledger.fills.every((fill) => fill.accountId === 'DEFAULTPAPR')).toBe(true);
      expect(ledger.netSize('DEFAULTPAPR', 'AAPL').toString()).toBe('10');
      expect(ledger.netSize('MOMENTUM01', 'AAPL').toString()).toBe('0');
    });

    it('never moves an order that is already attributed, whatever a later report says', async () => {
      // An order's account is decided once. A later report that disagrees is a bug
      // upstream, not a correction to apply.
      facade.enqueue(job({ accountId: 'MOMENTUM01' }));
      await facade.drain();
      facade.enqueue(job({ accountId: 'REVERSION1', status: 'filled', filledQty: 10, filledAvgPrice: 100 }));
      await facade.drain();

      expect(brokerOrders.orders.get('order-1')?.accountId).toBe('MOMENTUM01');
      expect(ledger.fills[0].accountId).toBe('MOMENTUM01');
    });

    it('leaves an order where it is when a tracking request claims it for somebody else', async () => {
      facade.enqueue(job({ accountId: 'MOMENTUM01' }));
      await facade.drain();

      facade.track({ brokerOrderIds: ['order-1'], accountId: 'REVERSION1' });
      await facade.drain();

      expect(brokerOrders.orders.get('order-1')?.accountId).toBe('MOMENTUM01');
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
