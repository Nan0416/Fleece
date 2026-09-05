import { BrokerOrderEvent } from '@fleece/shared';
import { MultiLegOrderHandle, OrderLegHandle } from '../../src/orders/multi-leg-order-handle';
import { OrderCanceller } from '../../src/orders/order-handle';
import { brokerEvent } from '../broker-events';
import { d, shows } from '../decimals';

const SHORT_LEG = 'AMZN261016C00280000';
const LONG_LEG = 'AMZN261016C00285000';

class RecordingCanceller implements OrderCanceller {
  readonly cancelled: string[] = [];
  async cancelOrder(brokerOrderId: string): Promise<void> {
    this.cancelled.push(brokerOrderId);
  }
}

interface Harness {
  readonly handle: MultiLegOrderHandle;
  readonly canceller: RecordingCanceller;
  readonly notifications: ReadonlyArray<BrokerOrderEvent>[];
}

function harness(onEvent?: () => Promise<void>): Harness {
  const canceller = new RecordingCanceller();
  const notifications: ReadonlyArray<BrokerOrderEvent>[] = [];
  const legs = [
    new OrderLegHandle({ brokerOrderId: 'leg-short', parentBrokerOrderId: 'spread-1', accountId: 'MOMENTUM01', symbol: SHORT_LEG, ratioQty: d(1) }),
    new OrderLegHandle({ brokerOrderId: 'leg-long', parentBrokerOrderId: 'spread-1', accountId: 'MOMENTUM01', symbol: LONG_LEG, ratioQty: d(2) }),
  ];

  const handle = new MultiLegOrderHandle({
    brokerOrderId: 'spread-1',
    accountId: 'MOMENTUM01',
    legs,
    canceller,
    onEvent: async (events) => {
      notifications.push(events);
      if (onEvent !== undefined) {
        await onEvent();
      }
    },
  });

  return { handle, canceller, notifications };
}

/** The parent and its two contracts, as one message describes them. */
function filledSpread(): ReadonlyArray<BrokerOrderEvent> {
  return [
    brokerEvent({
      id: 'spread-1',
      symbol: undefined,
      assetClass: 'option',
      orderClass: 'mleg',
      side: undefined,
      status: 'filled',
      qty: d(1),
      filledQty: d(1),
      filledAvgPrice: d('-0.9'),
    }),
    brokerEvent({
      id: 'leg-short',
      parentBrokerOrderId: 'spread-1',
      symbol: SHORT_LEG,
      assetClass: 'option',
      orderClass: 'mleg',
      side: 'sell',
      status: 'filled',
      qty: d(-1),
      filledQty: d(-1),
      filledAvgPrice: d('3.85'),
    }),
    brokerEvent({
      id: 'leg-long',
      parentBrokerOrderId: 'spread-1',
      symbol: LONG_LEG,
      assetClass: 'option',
      orderClass: 'mleg',
      side: 'buy',
      status: 'filled',
      qty: d(1),
      filledQty: d(1),
      filledAvgPrice: d('2.95'),
    }),
  ];
}

describe('MultiLegOrderHandle', () => {
  it('keeps the parent events on itself and each contract on its own leg', async () => {
    const { handle } = harness();

    await handle.absorb(filledSpread());

    // The parent's price is the package's signed net; the legs carry what traded.
    expect(shows(handle.latestEvent?.filledAvgPrice)).toBe('-0.9');
    expect(handle.latestEvent?.symbol).toBeUndefined();
    expect(handle.legs.map((leg) => shows(leg.latestEvent?.filledAvgPrice))).toEqual(['3.85', '2.95']);
    expect(handle.legs.map((leg) => leg.symbol)).toEqual([SHORT_LEG, LONG_LEG]);
  });

  it('notifies once per message, after every contract has been updated', async () => {
    // Delivering the events one at a time would show a caller a parent that has filled
    // beside a contract that has not heard — a state that never existed at the broker.
    let legsWhenCalled: ReadonlyArray<string> = [];
    const canceller = new RecordingCanceller();
    const legs = [
      new OrderLegHandle({ brokerOrderId: 'leg-short', parentBrokerOrderId: 'spread-1', accountId: 'MOMENTUM01', symbol: SHORT_LEG, ratioQty: d(1) }),
      new OrderLegHandle({ brokerOrderId: 'leg-long', parentBrokerOrderId: 'spread-1', accountId: 'MOMENTUM01', symbol: LONG_LEG, ratioQty: d(1) }),
    ];
    let calls = 0;
    const handle = new MultiLegOrderHandle({
      brokerOrderId: 'spread-1',
      accountId: 'MOMENTUM01',
      legs,
      canceller,
      onEvent: async (_events, orderObj) => {
        calls += 1;
        legsWhenCalled = orderObj.legs.map((leg) => leg.latestEvent?.status ?? 'none');
      },
    });

    await handle.absorb(filledSpread());

    expect(calls).toBe(1);
    expect(legsWhenCalled).toEqual(['filled', 'filled']);
  });

  it('carries the ratio each contract was requested at', async () => {
    const { handle } = harness();
    expect(handle.legs.map((leg) => shows(leg.ratioQty))).toEqual(['1', '2']);
  });

  it('answers for the parent and every contract, so a payload naming any of them lands', () => {
    const { handle } = harness();
    expect(handle.brokerOrderIds).toEqual(['spread-1', 'leg-short', 'leg-long']);
  });

  it('cancels the spread, which is the only cancellation the broker offers', async () => {
    const { handle, canceller } = harness();
    await handle.cancel();
    expect(canceller.cancelled).toEqual(['spread-1']);
  });

  it('settles on the parent, whose contracts fill together or not at all', async () => {
    const { handle } = harness();
    expect(handle.settled).toBe(false);

    await handle.absorb(filledSpread());
    expect(handle.settled).toBe(true);
  });

  it('ignores a payload that names nothing it owns', async () => {
    const { handle, notifications } = harness();

    await handle.absorb([brokerEvent({ id: 'somebody-elses-order' })]);

    expect(notifications).toHaveLength(0);
    expect(handle.events).toHaveLength(0);
  });

  it('swallows a handler that throws, which belongs to the caller and not to the loop', async () => {
    // Letting it escape would abort the dispatch loop and stop every other order's
    // events being delivered too.
    const { handle } = harness(async () => {
      throw new Error('handler exploded');
    });

    await expect(handle.absorb(filledSpread())).resolves.toBeUndefined();
    expect(handle.legs.every((leg) => leg.events.length === 1)).toBe(true);
  });
});
