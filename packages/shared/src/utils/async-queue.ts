import { LoggerFactory } from './logger';

const logger = LoggerFactory.getLogger('AsyncQueue');

/**
 * Serialises async handling of a stream of events.
 *
 * Broker order events arrive from a websocket faster than they can be applied, and
 * applying one is a read-compare-write against the position it affects: two handlers
 * running in parallel would each read the same position, compute a new cost basis
 * from it, and both write — losing one fill. Funnelling them through this queue makes
 * the sequence atomic within the process, which is what the injector relies on.
 *
 * It is not a substitute for the database transaction: other processes write the same
 * rows, so `appendTransaction` still locks. This queue is what keeps a single
 * websocket's own events in order.
 */
export class AsyncQueue<T> {
  private readonly buffer: T[] = [];
  private processing = false;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly handler: (event: T) => Promise<void>) {}

  /** Fire-and-forget. Events are handled in enqueue order. */
  enqueue(event: T): void {
    this.buffer.push(event);
    if (!this.processing) {
      void this.drainLoop();
    }
  }

  get size(): number {
    return this.buffer.length;
  }

  /** Resolves once the queue has emptied. Used on shutdown so nothing is dropped. */
  async drain(): Promise<void> {
    if (!this.processing && this.buffer.length === 0) {
      return;
    }
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private async drainLoop(): Promise<void> {
    this.processing = true;
    while (this.buffer.length > 0) {
      const event = this.buffer.shift();
      if (event === undefined) {
        continue;
      }
      try {
        await this.handler(event);
      } catch (err) {
        // A failed event must not stall the queue behind it.
        logger.error('Queued event handler threw.', err);
      }
    }
    this.processing = false;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }
}
