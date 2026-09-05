import { BrokerOrderEvent, LoggerFactory } from '@fleece/shared';

const logger = LoggerFactory.getLogger('EventDispatcher');

/**
 * Something that accepts the events one broker payload described.
 *
 * A sink covers a whole **placement**, not a single order: an OTO's entry and exit, or a
 * spread's parent and its contracts, arrive in one message and are absorbed together.
 */
export interface EventSink {
  /** Every broker order id this sink accepts events for. */
  readonly brokerOrderIds: ReadonlyArray<string>;
  /** True once nothing more will arrive for any of them. */
  readonly settled: boolean;
  /** Applies one payload, in the order the converter emitted it. */
  absorb(events: ReadonlyArray<BrokerOrderEvent>): Promise<void>;
}

interface Job {
  sink?: EventSink;
  readonly queue: ReadonlyArray<BrokerOrderEvent>[];
  running: boolean;
}

/**
 * Delivers each placement's events to its sink, in order, one payload at a time.
 *
 * **The unit is a payload, not an event.** One Alpaca message describes a whole
 * composite order, and the converter flattens it into a parent event plus one per leg.
 * Delivering those separately would let a caller see a spread whose parent says `filled`
 * and whose second contract still says `new` — a state that never existed at the broker.
 * Keeping the payload together is also why an OTO's two handles share one job.
 *
 * Two problems it solves, both from the same fact — an event can reach us before the
 * thing it belongs to exists:
 *
 * 1. **The event beats the placement response.** Alpaca can report a fill before its own
 *    HTTP response has been read, so no handle exists yet. Payloads are queued against
 *    the broker order id they name and released when `register` supplies the sink.
 * 2. **Handlers are async.** A caller's handler may await; without serialisation the next
 *    payload for the same placement would run concurrently with it and the handler would
 *    see its order's history out of order.
 *
 * Serialisation is per placement, not global: one strategy's slow handler must not delay
 * another strategy's fills.
 */
export class EventDispatcher {
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly brokerAccountId: string) {}

  /** Forgets everything. Used on shutdown, where pending events will not be delivered. */
  clear(): void {
    this.jobs.clear();
  }

  register(sink: EventSink): void {
    // Events may have arrived first and be waiting under one of these ids.
    const existing = sink.brokerOrderIds.map((id) => this.jobs.get(id)).find((job) => job !== undefined);
    const job: Job = existing ?? { queue: [], running: false };
    job.sink = sink;
    // Indexed under every id it answers for, so a leg arriving on its own still lands.
    for (const brokerOrderId of sink.brokerOrderIds) {
      this.jobs.set(brokerOrderId, job);
    }
    void this.drain(job);
  }

  dispatch(events: ReadonlyArray<BrokerOrderEvent>): void {
    const first = events[0];
    if (first === undefined) {
      return;
    }

    let job = this.jobs.get(first.id) ?? events.map((event) => this.jobs.get(event.id)).find((entry) => entry !== undefined);
    if (job === undefined) {
      if (first.reservationId === undefined) {
        logger.debug(`Broker order ${first.id} on account ${this.brokerAccountId} has no reservation: a leg order, or one placed outside this process.`);
      }
      job = { queue: [], running: false };
      this.jobs.set(first.id, job);
    }

    job.queue.push(events);
    void this.drain(job);
  }

  private async drain(job: Job): Promise<void> {
    if (job.running || job.sink === undefined || job.queue.length === 0) {
      return;
    }

    job.running = true;
    try {
      while (job.queue.length > 0) {
        const payload = job.queue.shift();
        if (payload === undefined) {
          continue;
        }
        await job.sink.absorb(payload);

        if (job.sink.settled) {
          if (job.queue.length > 0) {
            logger.error(`Placement ${job.sink.brokerOrderIds.join(', ')} settled with ${job.queue.length} payload(s) still queued; they will not be delivered.`);
          }
          this.forget(job);
          return;
        }
      }
    } finally {
      job.running = false;
    }
  }

  /** Drops every id pointing at a finished job, not just the one that finished it. */
  private forget(job: Job): void {
    for (const [brokerOrderId, entry] of [...this.jobs.entries()]) {
      if (entry === job) {
        this.jobs.delete(brokerOrderId);
      }
    }
  }
}
