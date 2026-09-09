import { AsyncQueue } from '../src/async-queue';
import { sleep } from '../src/sleep';

/**
 * The queue the order injector relies on. Applying a broker event is a
 * read-compare-write against a position, so two handlers running at once would each
 * read the same position and one fill would be lost — which is what "in order, one at a
 * time" here is protecting.
 */
describe('AsyncQueue', () => {
  it('handles events in enqueue order', async () => {
    const seen: number[] = [];
    const queue = new AsyncQueue<number>(async (event) => {
      await sleep(1);
      seen.push(event);
    });

    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);
    await queue.drain();

    expect(seen).toEqual([1, 2, 3]);
  });

  it('never runs two handlers at once, however slow one is', async () => {
    let running = 0;
    let overlapped = false;
    const queue = new AsyncQueue<number>(async () => {
      running += 1;
      if (running > 1) {
        overlapped = true;
      }
      await sleep(2);
      running -= 1;
    });

    for (let i = 0; i < 5; i += 1) {
      queue.enqueue(i);
    }
    await queue.drain();

    expect(overlapped).toBe(false);
  });

  it('carries on after a handler throws, so one bad event does not stall the rest', async () => {
    const seen: number[] = [];
    const queue = new AsyncQueue<number>(async (event) => {
      if (event === 2) {
        throw new Error('deliberate');
      }
      seen.push(event);
    });

    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);
    await queue.drain();

    expect(seen).toEqual([1, 3]);
  });

  it('reports how much is still waiting', async () => {
    const queue = new AsyncQueue<number>(async () => {
      await sleep(5);
    });
    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);
    // The first is already in flight, so the buffer holds the rest.
    expect(queue.size).toBeGreaterThan(0);
    await queue.drain();
    expect(queue.size).toBe(0);
  });

  it('drains immediately when nothing was ever enqueued', async () => {
    const queue = new AsyncQueue<number>(async () => {});
    await expect(queue.drain()).resolves.toBeUndefined();
  });

  it('releases every waiter on the same drain', async () => {
    const queue = new AsyncQueue<number>(async () => {
      await sleep(5);
    });
    queue.enqueue(1);
    await Promise.all([queue.drain(), queue.drain(), queue.drain()]);
    expect(queue.size).toBe(0);
  });

  it('picks up an event enqueued after it had gone idle', async () => {
    const seen: number[] = [];
    const queue = new AsyncQueue<number>(async (event) => {
      seen.push(event);
    });

    queue.enqueue(1);
    await queue.drain();
    queue.enqueue(2);
    await queue.drain();

    expect(seen).toEqual([1, 2]);
  });

  it('handles an event enqueued by a running handler before it reports idle', async () => {
    const seen: number[] = [];
    const queue: AsyncQueue<number> = new AsyncQueue<number>(async (event) => {
      seen.push(event);
      if (event === 1) {
        queue.enqueue(2);
      }
    });

    queue.enqueue(1);
    await queue.drain();

    expect(seen).toEqual([1, 2]);
  });
});
