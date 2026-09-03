import { AlpacaActiveSynchronization } from '../src/active-synchronization';
import { GetOrderInput, GetOrderOutput } from '../src/alpaca-rest-client';
import { AlpacaOrderReader } from '../src/active-synchronization';
import { AlpacaOrder } from '../src/models';
import { alpacaOrder } from './alpaca-orders';

const account = { accountId: 'PAPER001', live: false };

/** Serves whatever the test last put in it, and counts what was asked for. */
class FakeRestClient implements AlpacaOrderReader {
  readonly requested: string[] = [];
  private readonly orders = new Map<string, AlpacaOrder>();

  put(order: AlpacaOrder): void {
    this.orders.set(order.id, order);
  }

  async getOrder(input: GetOrderInput): Promise<GetOrderOutput> {
    this.requested.push(input.brokerOrderId);
    return { order: this.orders.get(input.brokerOrderId) ?? null };
  }
}

describe('AlpacaActiveSynchronization', () => {
  let rest: FakeRestClient;
  let clock: number;
  let sync: AlpacaActiveSynchronization;
  let recovered: AlpacaOrder[];

  beforeEach(() => {
    rest = new FakeRestClient();
    clock = 1_000_000;
    recovered = [];
    // A fixed clock rather than real time: the interesting cases are all "has it been
    // quiet for long enough", which a real clock makes either unreachable or flaky.
    sync = new AlpacaActiveSynchronization({ account, restClient: rest, now: () => clock, tickMs: 1_000 });
    sync.onEvent = (order) => recovered.push(order);
  });

  afterEach(() => {
    sync.stop();
  });

  describe('when it polls', () => {
    it('leaves an order alone while its last event is still fresh', async () => {
      sync.track(alpacaOrder({ status: 'accepted' }));
      clock += 500;
      await sync.tick();
      expect(rest.requested).toEqual([]);
    });

    it('polls an order stuck in a pending status', async () => {
      // Accepted by Alpaca but never reported as working at the venue — the case where
      // the "new" event went missing.
      sync.track(alpacaOrder({ status: 'accepted' }));
      clock += 1_500;
      await sync.tick();
      expect(rest.requested).toEqual(['alpaca-order-1']);
    });

    it('gives a live market order ten seconds before chasing it', async () => {
      sync.track(alpacaOrder({ status: 'new', type: 'market' }));

      clock += 5_000;
      await sync.tick();
      expect(rest.requested).toEqual([]);

      clock += 6_000;
      await sync.tick();
      expect(rest.requested).toEqual(['alpaca-order-1']);
    });

    it('checks a live limit order only every five minutes', async () => {
      sync.track(alpacaOrder({ status: 'new', type: 'limit', order_type: 'limit', limit_price: '150' }));

      clock += 60_000;
      await sync.tick();
      expect(rest.requested).toEqual([]);

      clock += 5 * 60_000;
      await sync.tick();
      expect(rest.requested).toEqual(['alpaca-order-1']);
    });

    it('stops watching an order once it reaches a terminal status', async () => {
      sync.track(alpacaOrder({ status: 'new' }));
      sync.track(alpacaOrder({ status: 'filled', filled_qty: '10', filled_avg_price: '100' }));
      clock += 60_000;
      await sync.tick();
      expect(rest.requested).toEqual([]);
    });
  });

  describe('watching from placement', () => {
    it('polls an order that was placed and then never mentioned', async () => {
      // The failure the stream cannot report: Alpaca accepted the order and the "new"
      // event went missing, so there is nothing to `track` and only `register` knows
      // the order exists at all.
      sync.register('alpaca-order-1');
      clock += 1_500;
      await sync.tick();
      expect(rest.requested).toEqual(['alpaca-order-1']);
    });

    it('gives it a second before chasing, so a normal placement is not polled', async () => {
      sync.register('alpaca-order-1');
      clock += 500;
      await sync.tick();
      expect(rest.requested).toEqual([]);
    });

    it('surfaces the first event when the poll finds one', async () => {
      sync.register('alpaca-order-1');
      rest.put(alpacaOrder({ status: 'new' }));
      clock += 1_500;
      await sync.tick();
      expect(recovered.map((order) => order.status)).toEqual(['new']);
    });

    it('does nothing when an event beat the placement response back', async () => {
      sync.track(alpacaOrder({ status: 'new' }));
      sync.register('alpaca-order-1');
      rest.put(alpacaOrder({ status: 'new' }));

      clock += 1_500;
      await sync.tick();

      // Still one job holding the tracked event, so the poll found nothing newer.
      expect(recovered).toEqual([]);
    });

    it('is idempotent', async () => {
      sync.register('alpaca-order-1');
      sync.register('alpaca-order-1');
      clock += 1_500;
      await sync.tick();
      expect(rest.requested).toEqual(['alpaca-order-1']);
    });
  });

  describe('what it does with what it finds', () => {
    it('reports an event newer than the one already seen', async () => {
      sync.track(alpacaOrder({ status: 'accepted' }));
      rest.put(alpacaOrder({ status: 'filled', filled_qty: '10', filled_avg_price: '100' }));

      clock += 1_500;
      await sync.tick();

      expect(recovered.map((order) => order.status)).toEqual(['filled']);
    });

    it('stays quiet when the poll only returns what the stream already delivered', async () => {
      sync.track(alpacaOrder({ status: 'accepted' }));
      rest.put(alpacaOrder({ status: 'accepted' }));

      clock += 1_500;
      await sync.tick();

      expect(recovered).toEqual([]);
    });

    it('does not report the same recovered event twice', async () => {
      sync.track(alpacaOrder({ status: 'accepted' }));
      rest.put(alpacaOrder({ status: 'new' }));

      clock += 1_500;
      await sync.tick();
      clock += 1_500;
      await sync.tick();

      expect(recovered).toHaveLength(1);
    });

    it('retires an order the poll finds already finished', async () => {
      sync.track(alpacaOrder({ status: 'accepted' }));
      rest.put(alpacaOrder({ status: 'canceled' }));

      clock += 1_500;
      await sync.tick();
      expect(recovered.map((order) => order.status)).toEqual(['canceled']);

      rest.requested.length = 0;
      clock += 60_000;
      await sync.tick();
      expect(rest.requested).toEqual([]);
    });

    it('stops watching an order the broker no longer knows about', async () => {
      sync.track(alpacaOrder({ status: 'accepted' }));
      // Nothing put in the fake, so the poll 404s.
      clock += 1_500;
      await sync.tick();
      expect(recovered).toEqual([]);

      rest.requested.length = 0;
      clock += 60_000;
      await sync.tick();
      expect(rest.requested).toEqual([]);
    });
  });

  describe('resilience', () => {
    it('keeps polling the other orders when one lookup fails', async () => {
      sync.track(alpacaOrder({ id: 'order-a', status: 'accepted' }));
      sync.track(alpacaOrder({ id: 'order-b', status: 'accepted' }));
      rest.put(alpacaOrder({ id: 'order-b', status: 'new' }));

      const failing = jest.spyOn(rest, 'getOrder');
      failing.mockImplementationOnce(async () => {
        throw new Error('Alpaca is having a day');
      });

      clock += 1_500;
      await expect(sync.tick()).resolves.toBeUndefined();

      // The second order was still polled and its newer event still surfaced.
      expect(recovered.map((order) => order.id)).toEqual(['order-b']);
      failing.mockRestore();
    });
  });

  describe('tracking events from the stream', () => {
    it('ignores an event older than the one already held', async () => {
      sync.track(alpacaOrder({ status: 'partially_filled', filled_qty: '4', filled_avg_price: '100' }));
      // A stale "new" arriving late must not undo what is known.
      sync.track(alpacaOrder({ status: 'new' }));
      rest.put(alpacaOrder({ status: 'partially_filled', filled_qty: '4', filled_avg_price: '100' }));

      clock += 20_000;
      await sync.tick();

      expect(recovered).toEqual([]);
    });
  });
});
