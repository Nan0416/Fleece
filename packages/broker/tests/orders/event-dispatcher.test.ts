import { BrokerOrderEvent } from '@fleece/shared';
import { EventDispatcher, EventSink } from '../../src/orders/event-dispatcher';
import { brokerEvent } from '../broker-events';
import { d } from '../decimals';

/** Records what it was given, and settles when told to. */
class RecordingSink implements EventSink {
  readonly payloads: ReadonlyArray<BrokerOrderEvent>[] = [];
  settled = false;
  private release?: () => void;
  private pending?: Promise<void>;

  constructor(readonly brokerOrderIds: ReadonlyArray<string>) {}

  async absorb(events: ReadonlyArray<BrokerOrderEvent>): Promise<void> {
    this.payloads.push(events);
    if (this.pending !== undefined) {
      await this.pending;
    }
  }

  /** Makes absorb hang until `finish` is called, so ordering can be observed. */
  hold(): void {
    this.pending = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  finish(): void {
    this.pending = undefined;
    this.release?.();
  }
}

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
};

describe('EventDispatcher', () => {
  it('delivers a whole payload at once, so a spread is never half applied', async () => {
    const dispatcher = new EventDispatcher('PAPER001');
    const sink = new RecordingSink(['mleg-parent', 'leg-a', 'leg-b']);
    dispatcher.register(sink);

    dispatcher.dispatch([brokerEvent({ id: 'mleg-parent', symbol: undefined }), brokerEvent({ id: 'leg-a' }), brokerEvent({ id: 'leg-b' })]);
    await settle();

    expect(sink.payloads).toHaveLength(1);
    expect(sink.payloads[0].map((event) => event.id)).toEqual(['mleg-parent', 'leg-a', 'leg-b']);
  });

  it('holds events that arrive before the placement response, and releases them on register', async () => {
    // Alpaca can report a fill before its own HTTP response has been read, so the handle
    // does not exist yet.
    const dispatcher = new EventDispatcher('PAPER001');
    dispatcher.dispatch([brokerEvent({ id: 'order-1', status: 'new' })]);

    const sink = new RecordingSink(['order-1']);
    dispatcher.register(sink);
    await settle();

    expect(sink.payloads.map((payload) => payload[0].status)).toEqual(['new']);
  });

  it('routes a payload naming only a leg to the placement that owns it', async () => {
    const dispatcher = new EventDispatcher('PAPER001');
    const sink = new RecordingSink(['entry-1', 'exit-1']);
    dispatcher.register(sink);

    dispatcher.dispatch([brokerEvent({ id: 'exit-1', status: 'filled', filledQty: d(10), filledAvgPrice: d(100) })]);
    await settle();

    expect(sink.payloads).toHaveLength(1);
  });

  it('serialises the payloads of one placement, so a slow handler cannot see them out of order', async () => {
    const dispatcher = new EventDispatcher('PAPER001');
    const sink = new RecordingSink(['order-1']);
    dispatcher.register(sink);

    sink.hold();
    dispatcher.dispatch([brokerEvent({ id: 'order-1', status: 'new' })]);
    dispatcher.dispatch([brokerEvent({ id: 'order-1', status: 'partially_filled', filledQty: d(4), filledAvgPrice: d(100) })]);
    await settle();

    // The second is still queued behind the first, which has not finished.
    expect(sink.payloads).toHaveLength(1);

    sink.finish();
    await settle();
    expect(sink.payloads.map((payload) => payload[0].status)).toEqual(['new', 'partially_filled']);
  });

  it('does not let the slow handler of one placement delay another', async () => {
    const dispatcher = new EventDispatcher('PAPER001');
    const slow = new RecordingSink(['order-a']);
    const quick = new RecordingSink(['order-b']);
    dispatcher.register(slow);
    dispatcher.register(quick);

    slow.hold();
    dispatcher.dispatch([brokerEvent({ id: 'order-a', status: 'new' })]);
    dispatcher.dispatch([brokerEvent({ id: 'order-b', status: 'new' })]);
    await settle();

    expect(quick.payloads).toHaveLength(1);
    slow.finish();
  });

  it('forgets a placement once it has settled, under every id it answered for', async () => {
    const dispatcher = new EventDispatcher('PAPER001');
    const sink = new RecordingSink(['entry-1', 'exit-1']);
    dispatcher.register(sink);

    dispatcher.dispatch([brokerEvent({ id: 'entry-1', status: 'filled', filledQty: d(10), filledAvgPrice: d(100) })]);
    sink.settled = true;
    await settle();

    // A late duplicate finds nothing to deliver to, rather than a job that outlives its
    // order.
    dispatcher.dispatch([brokerEvent({ id: 'exit-1', status: 'canceled' })]);
    await settle();
    expect(sink.payloads).toHaveLength(1);
  });

  it('drops everything on shutdown, where nothing more will be delivered', async () => {
    const dispatcher = new EventDispatcher('PAPER001');
    dispatcher.dispatch([brokerEvent({ id: 'order-1', status: 'new' })]);
    dispatcher.clear();

    const sink = new RecordingSink(['order-1']);
    dispatcher.register(sink);
    await settle();

    expect(sink.payloads).toHaveLength(0);
  });

  it('ignores an empty payload', () => {
    const dispatcher = new EventDispatcher('PAPER001');
    expect(() => dispatcher.dispatch([])).not.toThrow();
  });
});
