import { AlpacaAccountIdentifier, AlpacaActiveSynchronization, AlpacaOrder, AlpacaWsClient, OrderEventHandler } from '@fleece/alpaca';
import { AlpacaInjector } from '../src/alpaca-injector';
import { BrokerOrderEventJob, OrderTrackingFacade } from '../src/order-tracking-facade';
import { alpacaOrder, mlegOrder } from './alpaca-orders';

const account: AlpacaAccountIdentifier = { accountId: 'PAPER001', live: false };

/** Lets a test deliver an order event the way the stream would. */
class FakeWsClient {
  private handlers: OrderEventHandler[] = [];

  addOrderEventHandler(handler: OrderEventHandler): string {
    this.handlers.push(handler);
    return 'handler-1';
  }

  removeOrderEventHandler(): void {
    this.handlers = [];
  }

  /** Throws if the injector lets an exception escape, exactly as `ws.on('message')` would. */
  deliver(order: AlpacaOrder): void {
    for (const handler of this.handlers) {
      handler(order);
    }
  }
}

class FakeActiveSync {
  readonly tracked: AlpacaOrder[] = [];
  onEvent: (order: AlpacaOrder) => void = () => {};

  track(order: AlpacaOrder): void {
    this.tracked.push(order);
  }

  start(): void {}
  stop(): void {}
}

class FakeOrderTracking {
  readonly jobs: BrokerOrderEventJob[] = [];

  enqueue(job: BrokerOrderEventJob): void {
    this.jobs.push(job);
  }
}

describe('AlpacaInjector', () => {
  let ws: FakeWsClient;
  let activeSync: FakeActiveSync;
  let tracking: FakeOrderTracking;

  beforeEach(() => {
    ws = new FakeWsClient();
    activeSync = new FakeActiveSync();
    tracking = new FakeOrderTracking();

    const injector = new AlpacaInjector({
      orderTracking: tracking as unknown as OrderTrackingFacade,
      feeds: [
        {
          account,
          wsClient: ws as unknown as AlpacaWsClient,
          activeSync: activeSync as unknown as AlpacaActiveSynchronization,
        },
      ],
    });
    injector.start();
  });

  it('enqueues a plain order as one job carrying its own payload', () => {
    ws.deliver(alpacaOrder({ id: 'order-1' }));

    expect(tracking.jobs).toHaveLength(1);
    expect(tracking.jobs[0].event.id).toBe('order-1');
    expect(tracking.jobs[0].originalEvent.id).toBe('order-1');
  });

  it('enqueues a job for the spread and one per contract, parent first', () => {
    // The parent books no fill, but it is the id a placement returns and a cancel names,
    // so it gets a row like any other order. First, so that row exists before the legs
    // that name it.
    ws.deliver(mlegOrder());

    expect(tracking.jobs.map((job) => job.event.id)).toEqual(['mleg-parent-1', 'mleg-leg-short', 'mleg-leg-long']);
    // No job carries the empty symbol Alpaca sends for a parent; the converter turns it
    // into no symbol at all.
    expect(tracking.jobs.every((job) => job.event.symbol !== '')).toBe(true);
    expect(tracking.jobs[0].event.symbol).toBeUndefined();
  });

  it("files each leg's record against that leg's own payload, not the spread's", () => {
    // `broker_order_record` is keyed by broker order id. Handing every leg the parent's
    // payload files, against each leg, a record whose own id is a different order — so
    // replaying a leg's history hands back the whole spread.
    ws.deliver(mlegOrder());

    for (const job of tracking.jobs) {
      expect(job.originalEvent.id).toBe(job.event.id);
    }
  });

  it('logs an unconvertible order and keeps the feed alive, rather than throwing into the stream', () => {
    // The websocket calls its handlers in a bare loop and `ws.on('message')` has no
    // catch, so an exception escaping here takes the process down with it.
    expect(() => ws.deliver(alpacaOrder({ id: 'bad-1', qty: 'lots' }))).not.toThrow();
    expect(tracking.jobs).toHaveLength(0);

    // The feed still works afterwards.
    ws.deliver(alpacaOrder({ id: 'order-2' }));
    expect(tracking.jobs.map((job) => job.event.id)).toEqual(['order-2']);
  });

  it('enqueues nothing when one leg of a spread cannot be converted', () => {
    // All or nothing: a lazily converted list would have applied the first leg before
    // discovering the second was unreadable, leaving half a spread booked.
    const broken = mlegOrder({
      legs: [mlegOrder().legs?.[0] ?? alpacaOrder(), alpacaOrder({ id: 'mleg-leg-long', side: 'buy', qty: 'lots', asset_class: 'us_option', order_class: 'mleg' })],
    });

    expect(() => ws.deliver(broken)).not.toThrow();
    expect(tracking.jobs).toHaveLength(0);
  });

  it('tells the poller about every order the stream reported', () => {
    ws.deliver(mlegOrder());
    expect(activeSync.tracked).toHaveLength(1);
  });
});
