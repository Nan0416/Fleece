import { BrokerOrderEvent, InternalServiceError } from '@fleece/shared';
import { convertAlpacaOrderToBrokerOrderEvents } from '../src/order-converter';
import { AlpacaAccountIdentifier, AlpacaOrder } from '../src/models';
import { alpacaOrder } from './alpaca-orders';
import { mlegAlpacaOrder, mlegLeg } from './mleg-alpaca-orders';

const account = { accountId: 'PAPER001', live: false };

/** Anything but a composite order converts to exactly one event. Asserts that, and unwraps it. */
function convertOne(order: AlpacaOrder, identifier: AlpacaAccountIdentifier = account): BrokerOrderEvent {
  const events = convertAlpacaOrderToBrokerOrderEvents(order, identifier);
  expect(events).toHaveLength(1);
  return events[0];
}

describe('convertAlpacaOrderToBrokerOrderEvents', () => {
  describe('signing quantities', () => {
    it('leaves a buy positive', () => {
      const event = convertOne(alpacaOrder({ side: 'buy', qty: '10', filled_qty: '4' }));
      expect(event.qty).toBe(10);
      expect(event.filledQty).toBe(4);
    });

    it('makes a sell negative, because Alpaca reports magnitude and side separately', () => {
      const event = convertOne(alpacaOrder({ side: 'sell', qty: '10', filled_qty: '4' }));
      expect(event.qty).toBe(-10);
      expect(event.filledQty).toBe(-4);
    });

    it('leaves the fill price unsigned', () => {
      const event = convertOne(alpacaOrder({ side: 'sell', filled_qty: '4', filled_avg_price: '150.25' }));
      expect(event.filledAvgPrice).toBe(150.25);
    });
  });

  describe('correlation', () => {
    it('attributes the order to the account encoded in the client order id', () => {
      const event = convertOne(alpacaOrder({ client_order_id: '_c@a:MOMENTUM01;g:group-1' }));
      expect(event.accountId).toBe('MOMENTUM01');
      expect(event.groupId).toBe('group-1');
    });

    it('leaves an externally placed order unattributed rather than guessing', () => {
      const event = convertOne(alpacaOrder({ client_order_id: 'some-uuid-alpaca-made-up' }));
      expect(event.accountId).toBeUndefined();
      expect(event.groupId).toBeUndefined();
    });
  });

  describe('order types', () => {
    it('carries the limit price on a limit order', () => {
      const event = convertOne(alpacaOrder({ order_type: 'limit', limit_price: '148.50' }));
      expect(event.orderType).toBe('limit');
      expect(event.limitPrice).toBe(148.5);
      expect(event.stopPrice).toBeUndefined();
    });

    it('carries both prices on a stop-limit order', () => {
      const event = convertOne(alpacaOrder({ order_type: 'stop_limit', limit_price: '148.50', stop_price: '150.00' }));
      expect(event.limitPrice).toBe(148.5);
      expect(event.stopPrice).toBe(150);
    });

    it('rejects a limit order with no limit price rather than silently dropping it', () => {
      expect(() => convertAlpacaOrderToBrokerOrderEvents(alpacaOrder({ order_type: 'limit', limit_price: null }), account)).toThrow(InternalServiceError);
    });

    it("translates Alpaca's empty order class into a named one", () => {
      expect(convertOne(alpacaOrder({ order_class: '' })).orderClass).toBe('regular');
      expect(convertOne(alpacaOrder({ order_class: 'bracket' })).orderClass).toBe('bracket');
    });
  });

  describe('timestamps', () => {
    it('converts to epoch milliseconds', () => {
      const event = convertOne(alpacaOrder({ filled_at: '2026-09-01T14:31:00Z' }));
      expect(event.createdAt).toBe(Date.parse('2026-09-01T14:30:00Z'));
      expect(event.filledAt).toBe(Date.parse('2026-09-01T14:31:00Z'));
    });

    it('leaves an absent timestamp absent rather than turning null into 1970', () => {
      const event = convertOne(alpacaOrder({ filled_at: null, canceled_at: null }));
      expect(event.filledAt).toBeUndefined();
      expect(event.canceledAt).toBeUndefined();
    });
  });

  describe('flattening a composite order', () => {
    it('returns the parent and each leg as events of their own', () => {
      const leg = alpacaOrder({ id: 'leg-1', side: 'sell', qty: '10', order_type: 'limit', limit_price: '160' });
      const events = convertAlpacaOrderToBrokerOrderEvents(alpacaOrder({ id: 'parent-1', order_class: 'oto', legs: [leg] }), account);

      expect(events.map((event) => event.id)).toEqual(['parent-1', 'leg-1']);
      expect(events[1].qty).toBe(-10);
    });

    it('names the parent on each leg, which is all that ties them together once flat', () => {
      const leg = alpacaOrder({ id: 'leg-1', order_type: 'limit', limit_price: '160' });
      const events = convertAlpacaOrderToBrokerOrderEvents(alpacaOrder({ id: 'parent-1', order_class: 'oto', legs: [leg] }), account);

      expect(events[0].parentBrokerOrderId).toBeUndefined();
      expect(events[1].parentBrokerOrderId).toBe('parent-1');
    });

    it('gives every leg the parent correlation, the only attribution a leg has', () => {
      // Alpaca assigns each leg a client order id of its own, so there is nothing else
      // to attribute one from.
      const leg = alpacaOrder({ id: 'leg-1', client_order_id: 'alpaca-made-this-up', order_type: 'limit', limit_price: '160' });
      const events = convertAlpacaOrderToBrokerOrderEvents(alpacaOrder({ client_order_id: '_c@a:MOMENTUM01;g:group-1;r:res-1', order_class: 'oto', legs: [leg] }), account);

      expect(events[1]).toMatchObject({ accountId: 'MOMENTUM01', groupId: 'group-1', reservationId: 'res-1' });
    });

    it('keeps a plain order a single event', () => {
      expect(convertAlpacaOrderToBrokerOrderEvents(alpacaOrder({ id: 'plain-1', legs: null }), account).map((event) => event.id)).toEqual(['plain-1']);
    });
  });

  it('stamps the broker account the event arrived from', () => {
    const event = convertOne(alpacaOrder(), { accountId: 'LIVE001', live: true });
    expect(event.broker).toBe('alpaca');
    expect(event.brokerAccountId).toBe('LIVE001');
    expect(event.live).toBe(true);
  });

  it('rejects a quantity that is not a number', () => {
    expect(() => convertAlpacaOrderToBrokerOrderEvents(alpacaOrder({ qty: 'lots' }), account)).toThrow(InternalServiceError);
  });

  describe('multi-leg option orders', () => {
    it('discards the parent and returns only the contracts, which are what trade', () => {
      const events = convertAlpacaOrderToBrokerOrderEvents(mlegAlpacaOrder(), account);
      expect(events.map((event) => [event.id, event.symbol, event.parentBrokerOrderId])).toEqual([
        ['mleg-leg-short', 'AMZN261016C00280000', 'mleg-parent-1'],
        ['mleg-leg-long', 'AMZN261016C00285000', 'mleg-parent-1'],
      ]);
      // Nothing keyed on the empty string reaches the ledger.
      expect(events.some((event) => event.symbol === '')).toBe(false);
    });

    it('refuses a spread whose legs are missing rather than reporting that nothing happened', () => {
      // An empty list is indistinguishable from "this order did nothing". The usual
      // cause is a request that did not ask for nested=true, and the usual symptom
      // would be every backfilled spread disappearing without a word.
      expect(() => convertAlpacaOrderToBrokerOrderEvents(mlegAlpacaOrder({ legs: null, status: 'filled' }), account)).toThrow(InternalServiceError);
      expect(() => convertAlpacaOrderToBrokerOrderEvents(mlegAlpacaOrder({ legs: [], status: 'filled' }), account)).toThrow(/nested=true/);
    });

    it('signs each leg from its own side, which is where the direction actually lives', () => {
      const [short, long] = convertAlpacaOrderToBrokerOrderEvents(mlegAlpacaOrder(), account);
      expect(short).toMatchObject({ symbol: 'AMZN261016C00280000', qty: -1, filledQty: -1, filledAvgPrice: 3.85, side: 'sell' });
      expect(long).toMatchObject({ symbol: 'AMZN261016C00285000', qty: 1, filledQty: 1, filledAvgPrice: 2.95, side: 'buy' });
    });

    it('accepts a leg that carries no price, because the spread was priced as a package', () => {
      const [short] = convertAlpacaOrderToBrokerOrderEvents(mlegAlpacaOrder(), account);
      expect(short.orderType).toBe('limit');
      expect(short.limitPrice).toBeUndefined();
    });

    it('marks the legs as options so the ledger can scale them by the contract multiplier', () => {
      const [short] = convertAlpacaOrderToBrokerOrderEvents(mlegAlpacaOrder(), account);
      expect(short.assetClass).toBe('option');
      expect(short.orderClass).toBe('mleg');
    });

    it('carries the position intent and ratio each leg reports', () => {
      const [short] = convertAlpacaOrderToBrokerOrderEvents(mlegAlpacaOrder(), account);
      expect(short.positionIntent).toBe('sell_to_open');
      expect(short.ratioQty).toBe(1);
    });

    it('gives the legs the parent correlation, which is the only place a spread carries one', () => {
      const [short] = convertAlpacaOrderToBrokerOrderEvents(mlegAlpacaOrder({ client_order_id: '_c@a:MOMENTUM01;g:group-1' }), account);
      expect(short.accountId).toBe('MOMENTUM01');
      expect(short.groupId).toBe('group-1');
    });

    it('refuses an ordinary order with no side rather than treating it as a sell', () => {
      // The whole reason `side` is not read directly: `side === 'buy' ? 1 : -1` turns an
      // empty side into a negative position, and nothing anywhere would report it.
      expect(() => convertAlpacaOrderToBrokerOrderEvents(alpacaOrder({ side: '' }), account)).toThrow(InternalServiceError);
    });

    it('still refuses a lone option order with no limit price', () => {
      const lone = mlegLeg({ position_intent: 'buy_to_open', order_class: '', limit_price: null });
      expect(() => convertAlpacaOrderToBrokerOrderEvents(lone, account)).toThrow(InternalServiceError);
    });
  });
});
