import { decodeAlpacaOrderCorrelation } from '@fleece/alpaca';
import { InvalidRequestError } from '@fleece/shared';
import { CorrelatedOrderPlacer } from '../../src/placement/correlated-order-placer';
import { FakeAlpacaRestClient } from '../fake-alpaca';

function harness(): { placer: CorrelatedOrderPlacer; rest: FakeAlpacaRestClient } {
  const rest = new FakeAlpacaRestClient();
  return { placer: new CorrelatedOrderPlacer({ restClient: rest }), rest };
}

describe('CorrelatedOrderPlacer', () => {
  it('carries the virtual account in the one field the broker echoes back', async () => {
    // `client_order_id` comes back on every event about an order, which is what makes it
    // the only place an order can say whose it is that survives a restart.
    const { placer, rest } = harness();

    const placed = await placer.placeLimitOrder({ symbol: 'AAPL', size: 10, side: 'buy', limitPrice: 100, accountId: 'MOMENTUM01' });

    expect(decodeAlpacaOrderCorrelation(placed.clientOrderId)).toEqual({ virtualAccountId: 'MOMENTUM01', reservationId: undefined });
    expect(rest.createdSingle[0].clientOrderId).toBe(placed.clientOrderId);
  });

  it('carries a reservation id when it is given one, and manages without', async () => {
    // The layer takes no hold of its own: the id is an input, and an order placed
    // without one is a supported case rather than a degraded one.
    const { placer } = harness();

    const withHold = await placer.placeMarketOrder({ symbol: 'AAPL', size: 10, side: 'buy', accountId: 'MOMENTUM01', reservationId: 'res-1' });
    const without = await placer.placeMarketOrder({ symbol: 'AAPL', size: 10, side: 'buy', accountId: 'MOMENTUM01' });

    expect(decodeAlpacaOrderCorrelation(withHold.clientOrderId).reservationId).toBe('res-1');
    expect(decodeAlpacaOrderCorrelation(without.clientOrderId).reservationId).toBeUndefined();
  });

  it('refuses an order that names no virtual account, before sending it', async () => {
    // An order without one is attributed to nothing, and the injector books it to the
    // catch-all account — a misattribution that only shows up later as a strategy's P&L
    // being wrong.
    const { placer, rest } = harness();

    await expect(placer.placeMarketOrder({ symbol: 'AAPL', size: 10, side: 'buy', accountId: '' })).rejects.toThrow(InvalidRequestError);
    expect(rest.created).toHaveLength(0);
  });

  it('passes the broker its own vocabulary unchanged', async () => {
    // Near one to one with the layer below is the point of this one: the only thing it
    // adds is the identity.
    const { placer, rest } = harness();

    await placer.placeOtoOrder({
      symbol: 'AAPL',
      size: 10,
      side: 'buy',
      limitPrice: 100,
      takeProfitLimitPrice: 120,
      timeInForce: 'gtc',
      positionIntent: 'buy_to_open',
      accountId: 'MOMENTUM01',
    });

    expect(rest.createdSingle[0]).toMatchObject({ symbol: 'AAPL', size: 10, side: 'buy', limitPrice: 100, timeInForce: 'gtc', positionIntent: 'buy_to_open' });
  });

  it('places a spread with a net price, and one without as a market order', async () => {
    const { placer, rest } = harness();
    const legs = [
      { symbol: 'AMZN261016C00280000', ratioQty: 1, side: 'sell' as const, positionIntent: 'sell_to_open' as const },
      { symbol: 'AMZN261016C00285000', ratioQty: 1, side: 'buy' as const, positionIntent: 'buy_to_open' as const },
    ];

    await placer.placeMultiLegOrder({ size: 1, legs, netLimitPrice: -0.85, accountId: 'MOMENTUM01' });
    await placer.placeMultiLegOrder({ size: 1, legs, accountId: 'MOMENTUM01' });

    expect(rest.created[0]).toMatchObject({ type: 'limit', netLimitPrice: -0.85 });
    expect(rest.created[1]).toMatchObject({ type: 'market' });
  });

  it('cancels by the broker id', async () => {
    const { placer, rest } = harness();
    await placer.cancelOrder('alpaca-order-1');
    expect(rest.cancelled).toEqual(['alpaca-order-1']);
  });
});
