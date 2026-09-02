import { BrokerOrderEvent, isTerminalStatus, LoggerFactory } from '@fleece/shared';
import { AlpacaOrderHandle } from './alpaca-order-handle';

const logger = LoggerFactory.getLogger('EventDispatcher');

interface Job {
  readonly brokerOrderId: string;
  handle?: AlpacaOrderHandle;
  readonly queue: BrokerOrderEvent[];
  running: boolean;
}

/**
 * Delivers each order's events to its handle, in order, one at a time.
 *
 * Two problems it solves, both arising from the same fact — that an event can reach us
 * before the thing it belongs to exists:
 *
 * 1. **The event beats the placement response.** Alpaca can report a fill before its
 *    own HTTP response has been read, so the handle does not exist yet. Events are
 *    queued against the broker order id and released when `register` supplies the
 *    handle.
 * 2. **Handlers are async.** A caller's handler may await; without serialisation the
 *    next event for the same order would run concurrently with it and the handler would
 *    see its order's history out of order.
 *
 * Serialisation is per order, not global: one strategy's slow handler must not delay
 * another strategy's fills.
 */
export class EventDispatcher {
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly brokerAccountId: string) {}

  /** Forgets everything. Used on shutdown, where pending events will not be delivered. */
  clear(): void {
    this.jobs.clear();
  }

  register(handle: AlpacaOrderHandle): void {
    const existing = this.jobs.get(handle.brokerOrderId);
    if (existing === undefined) {
      this.jobs.set(handle.brokerOrderId, { brokerOrderId: handle.brokerOrderId, handle, queue: [], running: false });
      return;
    }
    // Events arrived first and have been waiting for this.
    existing.handle = handle;
    void this.drain(existing);
  }

  dispatch(event: BrokerOrderEvent): void {
    const existing = this.jobs.get(event.id);
    if (existing !== undefined) {
      existing.queue.push(event);
      void this.drain(existing);
      return;
    }

    if (event.reservationId === undefined) {
      logger.debug(`Broker order ${event.id} on account ${this.brokerAccountId} has no reservation: a leg order, or one placed outside this process.`);
    }
    this.jobs.set(event.id, { brokerOrderId: event.id, handle: undefined, queue: [event], running: false });
  }

  private async drain(job: Job): Promise<void> {
    if (job.running || job.handle === undefined || job.queue.length === 0) {
      return;
    }

    job.running = true;
    try {
      while (job.queue.length > 0) {
        const event = job.queue.shift();
        if (event === undefined) {
          continue;
        }
        await job.handle.processEvent(event);

        if (isTerminalStatus(event.status)) {
          if (job.queue.length > 0) {
            logger.error(`Broker order ${event.id} reached ${event.status} with ${job.queue.length} event(s) still queued; they will not be delivered.`);
          }
          this.jobs.delete(job.brokerOrderId);
          return;
        }
      }
    } finally {
      job.running = false;
    }
  }
}
