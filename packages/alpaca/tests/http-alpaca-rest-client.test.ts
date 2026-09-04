import { InvalidRequestError } from '@fleece/shared';
import { HttpAlpacaRestClient } from '../src/http-alpaca-rest-client';
import { mlegAlpacaOrder } from './mleg-alpaca-orders';

/**
 * These cover the request Fleece sends, not the response it parses. Alpaca is the
 * authority on its own replies, but the body going out is ours, and a multi-leg order
 * is the one place where a field in the wrong shape places a real trade rather than
 * failing — a sign flip on the net price is an order at a price nobody sane would take.
 */
describe('HttpAlpacaRestClient', () => {
  let sent: Array<{ url: string; method: string; body: Record<string, unknown> | undefined }>;
  let respond: () => Response;

  function client(): HttpAlpacaRestClient {
    return new HttpAlpacaRestClient({
      account: { accountId: 'PAPER001', live: false },
      credentialsProvider: { accessKey: 'key', secretKey: 'secret' },
      baseUrl: 'https://broker.test',
      // Off, so the suite does not wait on a token bucket.
      maxCallsPerMinute: -1,
    });
  }

  beforeEach(() => {
    sent = [];
    respond = () => new Response(JSON.stringify({ id: 'order-1', status: 'pending_new', symbol: '' }), { status: 200 });
    globalThis.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return respond();
    }) as unknown as typeof fetch;
  });

  describe('createMultiLegOrder', () => {
    const spread = {
      size: 1,
      legs: [
        { symbol: 'AMZN261016C00280000', ratioQty: 1, side: 'sell', positionIntent: 'sell_to_open' },
        { symbol: 'AMZN261016C00285000', ratioQty: 1, side: 'buy', positionIntent: 'buy_to_open' },
      ],
    } as const;

    it('sends the legs with their ratio, side and intent, and no symbol or side of its own', async () => {
      await client().createMultiLegOrder({ ...spread, type: 'limit', netLimitPrice: -0.85 });

      expect(sent[0].method).toBe('POST');
      expect(sent[0].url).toBe('https://broker.test/v2/orders');
      expect(sent[0].body).toEqual({
        order_class: 'mleg',
        qty: '1',
        type: 'limit',
        time_in_force: 'day',
        limit_price: '-0.85',
        legs: [
          { symbol: 'AMZN261016C00280000', ratio_qty: '1', side: 'sell', position_intent: 'sell_to_open' },
          { symbol: 'AMZN261016C00285000', ratio_qty: '1', side: 'buy', position_intent: 'buy_to_open' },
        ],
      });
    });

    it('keeps a negative net price negative, because that is what asks for a credit', async () => {
      await client().createMultiLegOrder({ ...spread, type: 'limit', netLimitPrice: -0.85 });
      expect(sent[0].body?.['limit_price']).toBe('-0.85');
    });

    it('omits extended_hours, which Alpaca rejects on an options order', async () => {
      await client().createMultiLegOrder({ ...spread, type: 'limit', netLimitPrice: 1.2 });
      expect(sent[0].body).not.toHaveProperty('extended_hours');
      expect(sent[0].body).not.toHaveProperty('symbol');
      expect(sent[0].body).not.toHaveProperty('side');
    });

    it('sends no limit price on a market spread', async () => {
      await client().createMultiLegOrder({ ...spread, type: 'market' });
      expect(sent[0].body).not.toHaveProperty('limit_price');
      expect(sent[0].body?.['type']).toBe('market');
    });

    it('carries the client order id, which is the only correlation a spread has', async () => {
      await client().createMultiLegOrder({ ...spread, type: 'market', clientOrderId: '_c@a:MOMENTUM01' });
      expect(sent[0].body?.['client_order_id']).toBe('_c@a:MOMENTUM01');
    });

    it('refuses a spread with one leg without asking the broker', async () => {
      await expect(client().createMultiLegOrder({ ...spread, legs: [spread.legs[0]], type: 'market' })).rejects.toThrow(InvalidRequestError);
      expect(sent).toHaveLength(0);
    });

    it('refuses a spread with five legs', async () => {
      const legs = [spread.legs[0], spread.legs[1], spread.legs[0], spread.legs[1], spread.legs[0]];
      await expect(client().createMultiLegOrder({ ...spread, legs, type: 'market' })).rejects.toThrow(InvalidRequestError);
    });

    it('refuses ratios that are not in lowest terms, and says what to send instead', async () => {
      const legs = [
        { ...spread.legs[0], ratioQty: 2 },
        { ...spread.legs[1], ratioQty: 4 },
      ];
      // Alpaca rejects this itself, but by then a reservation has been taken against an
      // order that was never going to be placed.
      await expect(client().createMultiLegOrder({ size: 1, legs, type: 'market' })).rejects.toThrow(/common divisor of 2.*raise size to 2/s);
      expect(sent).toHaveLength(0);
    });

    it('accepts a ratio spread whose legs are already in lowest terms', async () => {
      const legs = [
        { ...spread.legs[0], ratioQty: 1 },
        { ...spread.legs[1], ratioQty: 2 },
      ];
      await client().createMultiLegOrder({ size: 1, legs, type: 'market' });
      expect(sent).toHaveLength(1);
    });

    it('refuses a fractional number of spreads', async () => {
      await expect(client().createMultiLegOrder({ ...spread, size: 1.5, type: 'market' })).rejects.toThrow(InvalidRequestError);
    });

    it('returns the parent order Alpaca replies with, legs and all', async () => {
      respond = () => new Response(JSON.stringify(mlegAlpacaOrder()), { status: 200 });
      const { order } = await client().createMultiLegOrder({ ...spread, type: 'limit', netLimitPrice: -0.85 });
      expect(order.order_class).toBe('mleg');
      expect(order.legs).toHaveLength(2);
    });
  });

  describe('single-leg option orders', () => {
    it('sends the position intent when the caller knows it', async () => {
      await client().createLimitOrder({
        symbol: 'AMZN261016C00280000',
        size: 1,
        side: 'sell',
        limitPrice: 3.85,
        positionIntent: 'sell_to_close',
      });
      expect(sent[0].body?.['position_intent']).toBe('sell_to_close');
      expect(sent[0].body?.['limit_price']).toBe('3.85');
    });

    it('leaves the intent off when the caller has none, so Alpaca infers it', async () => {
      await client().createMarketOrder({ symbol: 'AAPL', size: 10, side: 'buy' });
      expect(sent[0].body).not.toHaveProperty('position_intent');
      expect(sent[0].body?.['time_in_force']).toBe('day');
    });

    it('honours a good-til-cancelled option order', async () => {
      await client().createMarketOrder({ symbol: 'AMZN261016C00280000', size: 1, side: 'buy', timeInForce: 'gtc' });
      expect(sent[0].body?.['time_in_force']).toBe('gtc');
    });
  });

  describe('getOrder', () => {
    it('asks for nested legs, without which a spread comes back as an empty container', () => {
      // `nested` defaults to false. A multi-leg parent holds no instrument, so a
      // response without its legs is the whole order missing — and this is the call the
      // backfill poller makes, which exists precisely so a dropped fill is not lost.
      return client()
        .getOrder({ brokerOrderId: 'order-1' })
        .then(() => {
          expect(sent[0].url).toBe('https://broker.test/v2/orders/order-1?nested=true');
        });
    });
  });

  describe('getOptionContract', () => {
    it('reads a contract from the options endpoint, which is the only place options exist', async () => {
      respond = () => new Response(JSON.stringify({ symbol: 'AMZN261016C00280000', multiplier: '100', type: 'call' }), { status: 200 });
      const { contract } = await client().getOptionContract({ symbolOrId: 'amzn261016c00280000' });

      // Upper-cased, and not on /v2/assets: that endpoint 404s on an OCC symbol.
      expect(sent[0].url).toBe('https://broker.test/v2/options/contracts/AMZN261016C00280000');
      expect(contract?.multiplier).toBe('100');
    });

    it('reports a contract Alpaca does not have as absent rather than as a failure', async () => {
      respond = () => new Response(JSON.stringify({ code: 40410000, message: 'not found' }), { status: 404 });
      await expect(client().getOptionContract({ symbolOrId: 'AMZN261016C00280000' })).resolves.toEqual({ contract: null });
    });
  });
});
