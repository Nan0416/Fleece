import { L2BrokerOrderClient } from '../../src/l2/l2-broker-order-client';
import { L1BrokerOrderClient } from '../../src/l1/l1-broker-order-client';
import { alpacaOrder, FakeAlpacaRestClient, RecordingOrderTrackingClient } from '../fake-alpaca';

interface Harness {
  readonly placer: L2BrokerOrderClient;
  readonly rest: FakeAlpacaRestClient;
  readonly tracking: RecordingOrderTrackingClient;
}

function harness(): Harness {
  const rest = new FakeAlpacaRestClient();
  const tracking = new RecordingOrderTrackingClient();
  return { placer: new L2BrokerOrderClient({ placer: new L1BrokerOrderClient({ restClient: rest }), trackingClient: tracking }), rest, tracking };
}

const marketOrder = { symbol: 'AAPL', size: 10, side: 'buy' as const, accountId: 'MOMENTUM01' };

describe('L2BrokerOrderClient', () => {
  it('claims the order for the account that placed it', async () => {
    const { placer, tracking } = harness();

    await placer.createMarketOrder(marketOrder);

    expect(tracking.requests).toEqual([{ brokerOrderIds: ['alpaca-order-1'], accountId: 'MOMENTUM01' }]);
  });

  it('claims the legs of a composite order as well as its parent', async () => {
    // A nested leg already inherits the parent's correlation, so this is a second
    // answer to the same question — one that also covers a leg reaching the tracking
    // service on its own.
    const { placer, rest, tracking } = harness();
    rest.nextOrder = alpacaOrder({ id: 'entry-1', legs: [alpacaOrder({ id: 'exit-1' })] });

    await placer.createOtoOrder({ ...marketOrder, limitPrice: 100, takeProfitLimitPrice: 120 });

    expect(tracking.requests[0].brokerOrderIds).toEqual(['entry-1', 'exit-1']);
  });

  it('returns the order even when the tracking service could not be told', async () => {
    // The order is placed and the shares are moving. Throwing would leave the caller
    // believing it failed, which is the worse of the two errors: a fill in the catch-all
    // account can be moved with a transfer, a caller that thinks it holds nothing cannot.
    const { placer, tracking } = harness();
    tracking.failNext = new Error('tracking service unreachable');

    const placed = await placer.createMarketOrder(marketOrder);

    expect(placed.order.id).toBe('alpaca-order-1');
  });

  it('announces nothing when the placement itself failed', async () => {
    const { placer, rest, tracking } = harness();
    rest.failNextCreate = new Error('connection reset');

    await expect(placer.createMarketOrder(marketOrder)).rejects.toThrow('connection reset');
    expect(tracking.requests).toHaveLength(0);
  });

  it('says nothing on a cancellation, whose account is already written', async () => {
    // An order's account is written once. A second chance to state it is a second chance
    // to state it wrong.
    const { placer, rest, tracking } = harness();

    await placer.cancelOrder('alpaca-order-1');

    expect(rest.cancelled).toEqual(['alpaca-order-1']);
    expect(tracking.requests).toHaveLength(0);
  });
});
