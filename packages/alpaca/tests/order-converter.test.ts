import { InternalServiceError } from '@fleece/shared';
import { convertAlpacaOrderToBrokerOrderEvent } from '../src/order-converter';
import { alpacaOrder } from './alpaca-orders';

const account = { accountId: 'PAPER001', live: false };

describe('convertAlpacaOrderToBrokerOrderEvent', () => {
  describe('signing quantities', () => {
    it('leaves a buy positive', () => {
      const event = convertAlpacaOrderToBrokerOrderEvent(alpacaOrder({ side: 'buy', qty: '10', filled_qty: '4' }), account);
      expect(event.qty).toBe(10);
      expect(event.filledQty).toBe(4);
    });

    it('makes a sell negative, because Alpaca reports magnitude and side separately', () => {
      const event = convertAlpacaOrderToBrokerOrderEvent(alpacaOrder({ side: 'sell', qty: '10', filled_qty: '4' }), account);
      expect(event.qty).toBe(-10);
      expect(event.filledQty).toBe(-4);
    });

    it('leaves the fill price unsigned', () => {
      const event = convertAlpacaOrderToBrokerOrderEvent(alpacaOrder({ side: 'sell', filled_qty: '4', filled_avg_price: '150.25' }), account);
      expect(event.filledAvgPrice).toBe(150.25);
    });
  });

  describe('correlation', () => {
    it('attributes the order to the account encoded in the client order id', () => {
      const event = convertAlpacaOrderToBrokerOrderEvent(alpacaOrder({ client_order_id: '_c@a:MOMENTUM01;g:group-1' }), account);
      expect(event.accountId).toBe('MOMENTUM01');
      expect(event.groupId).toBe('group-1');
    });

    it('leaves an externally placed order unattributed rather than guessing', () => {
      const event = convertAlpacaOrderToBrokerOrderEvent(alpacaOrder({ client_order_id: 'some-uuid-alpaca-made-up' }), account);
      expect(event.accountId).toBeUndefined();
      expect(event.groupId).toBeUndefined();
    });
  });

  describe('order types', () => {
    it('carries the limit price on a limit order', () => {
      const event = convertAlpacaOrderToBrokerOrderEvent(alpacaOrder({ order_type: 'limit', limit_price: '148.50' }), account);
      expect(event.orderType).toBe('limit');
      expect(event.limitPrice).toBe(148.5);
      expect(event.stopPrice).toBeUndefined();
    });

    it('carries both prices on a stop-limit order', () => {
      const event = convertAlpacaOrderToBrokerOrderEvent(alpacaOrder({ order_type: 'stop_limit', limit_price: '148.50', stop_price: '150.00' }), account);
      expect(event.limitPrice).toBe(148.5);
      expect(event.stopPrice).toBe(150);
    });

    it('rejects a limit order with no limit price rather than silently dropping it', () => {
      expect(() => convertAlpacaOrderToBrokerOrderEvent(alpacaOrder({ order_type: 'limit', limit_price: null }), account)).toThrow(InternalServiceError);
    });

    it("translates Alpaca's empty order class into a named one", () => {
      expect(convertAlpacaOrderToBrokerOrderEvent(alpacaOrder({ order_class: '' }), account).orderClass).toBe('regular');
      expect(convertAlpacaOrderToBrokerOrderEvent(alpacaOrder({ order_class: 'bracket' }), account).orderClass).toBe('bracket');
    });
  });

  describe('timestamps', () => {
    it('converts to epoch milliseconds', () => {
      const event = convertAlpacaOrderToBrokerOrderEvent(alpacaOrder({ filled_at: '2026-09-01T14:31:00Z' }), account);
      expect(event.createdAt).toBe(Date.parse('2026-09-01T14:30:00Z'));
      expect(event.filledAt).toBe(Date.parse('2026-09-01T14:31:00Z'));
    });

    it('leaves an absent timestamp absent rather than turning null into 1970', () => {
      const event = convertAlpacaOrderToBrokerOrderEvent(alpacaOrder({ filled_at: null, canceled_at: null }), account);
      expect(event.filledAt).toBeUndefined();
      expect(event.canceledAt).toBeUndefined();
    });
  });

  describe('legs', () => {
    it('converts nested legs and gives them the parent correlation', () => {
      const leg = alpacaOrder({ id: 'leg-1', side: 'sell', qty: '10', order_type: 'limit', limit_price: '160' });
      const event = convertAlpacaOrderToBrokerOrderEvent(alpacaOrder({ client_order_id: '_c@a:MOMENTUM01', order_class: 'oto', legs: [leg] }), account);
      expect(event.legs).toHaveLength(1);
      expect(event.legs?.[0].id).toBe('leg-1');
      expect(event.legs?.[0].qty).toBe(-10);
      // A leg carries no client order id of its own, so without inheriting the
      // parent's correlation it could not be attributed at all.
      expect(event.legs?.[0].accountId).toBe('MOMENTUM01');
    });
  });

  it('stamps the broker account the event arrived from', () => {
    const event = convertAlpacaOrderToBrokerOrderEvent(alpacaOrder(), { accountId: 'LIVE001', live: true });
    expect(event.broker).toBe('alpaca');
    expect(event.brokerAccountId).toBe('LIVE001');
    expect(event.live).toBe(true);
  });

  it('rejects a quantity that is not a number', () => {
    expect(() => convertAlpacaOrderToBrokerOrderEvent(alpacaOrder({ qty: 'lots' }), account)).toThrow(InternalServiceError);
  });
});
