import { LoggerFactory } from '@fleece/shared';
import { AlpacaRestClient } from './alpaca-rest-client';

/**
 * All the poller needs. Deliberately narrower than `AlpacaRestClient`: this class
 * exists to read back what the stream missed, and giving it the client that can also
 * place and cancel orders would be handing a reconciliation job the ability to trade.
 */
export type AlpacaOrderReader = Pick<AlpacaRestClient, 'getOrder'>;
import { AlpacaAccountIdentifier, AlpacaOrder } from './models';
import { alpacaOrderToString, isBefore, isInProgressStatus, isPendingStatus, isTerminalStatus } from './order-status';

const logger = LoggerFactory.getLogger('AlpacaActiveSync');

interface Job {
  readonly brokerOrderId: string;
  /**
   * Absent only between `register` and the order's first event — the window where the
   * order has been placed but the broker has said nothing about it yet, which is
   * precisely the window worth polling.
   */
  latestEvent?: AlpacaOrder;
  latestEventReceivedAt: number;
  latestSyncDoneAt: number;
  isRunning: boolean;
}

export interface AlpacaActiveSynchronizationProps {
  readonly account: AlpacaAccountIdentifier;
  readonly restClient: AlpacaOrderReader;
  /** Injectable so the polling rules can be tested without waiting. */
  readonly now?: () => number;
  readonly tickMs?: number;
}

/**
 * Backfills order events the websocket never delivered.
 *
 * The stream is not a reliable transport. Events go missing when Alpaca drops one,
 * and when the socket disconnects a moment before an event is sent — reconnecting does
 * not replay what was missed. For a ledger, a missing fill is not a gap in a log; it
 * is a position that is silently wrong from then on.
 *
 * So every order being watched is polled over REST, but only when its silence is
 * itself suspicious:
 *
 * - nothing heard at all a second after the order was placed;
 * - an order still only pending a second after its last event;
 * - a market order still unfilled after ten seconds, when they normally fill in three;
 * - any live limit order, every five minutes.
 *
 * A rule firing does not mean an event was missed. These are cheap checks against an
 * expensive failure.
 */
export class AlpacaActiveSynchronization {
  private jobs: Job[] = [];
  private timer?: NodeJS.Timeout;
  private readonly now: () => number;

  /** Called with any event the poll found that the caller had not already seen. */
  onEvent: (order: AlpacaOrder) => void = () => {};

  constructor(private readonly props: AlpacaActiveSynchronizationProps) {
    this.now = props.now ?? Date.now;
  }

  start(): void {
    if (this.timer !== undefined) {
      logger.warn(`Active synchronization is already running for account ${this.props.account.accountId}.`);
      return;
    }
    // Jittered, so that several broker accounts in one process do not all poll Alpaca
    // on the same beat.
    const period = this.props.tickMs ?? 1_000 + Math.round(Math.random() * 300);
    logger.info(`Polling Alpaca for missed order events on account ${this.props.account.accountId} every ${period}ms.`);
    this.timer = setInterval(() => {
      void this.tick();
    }, period);
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Records an event that arrived on the websocket, so polling knows what is already known. */
  track(order: AlpacaOrder): void {
    const job = this.jobs.find((candidate) => candidate.brokerOrderId === order.id);
    if (job === undefined) {
      // First event for this order — or one so late that the terminal event already
      // retired the job, in which case this recreates it and the terminal check below
      // retires it again.
      this.jobs.push({ brokerOrderId: order.id, latestEvent: order, latestEventReceivedAt: this.now(), latestSyncDoneAt: this.now(), isRunning: false });
    } else if (job.latestEvent === undefined || isBefore(job.latestEvent, order)) {
      job.latestEvent = order;
      job.latestEventReceivedAt = this.now();
    }

    if (isTerminalStatus(order.status)) {
      this.removeJob(order.id);
    }
  }

  /**
   * Starts watching an order that has been placed but whose first event has not
   * arrived.
   *
   * Called by `@fleece/broker` immediately after the broker accepts an order. Watching
   * from placement rather than from the first event is what catches an order Alpaca
   * accepted and then never mentioned again — a failure the stream cannot report,
   * because the report is the thing that went missing.
   */
  register(brokerOrderId: string): void {
    if (this.jobs.some((job) => job.brokerOrderId === brokerOrderId)) {
      // An event beat the placement response back; `track` already created the job.
      return;
    }
    this.jobs.push({ brokerOrderId, latestEvent: undefined, latestEventReceivedAt: this.now(), latestSyncDoneAt: this.now(), isRunning: false });
  }

  /** Exposed so a test can drive a tick without a timer. */
  async tick(): Promise<void> {
    // A snapshot, because `sync` can retire jobs while this is iterating.
    for (const job of [...this.jobs]) {
      try {
        await this.sync(job);
      } catch (err) {
        // One order failing to poll must not stop the others, and must not stop the
        // loop: the next tick tries again.
        logger.error(`Could not poll Alpaca for order ${job.brokerOrderId}.`, err);
      }
    }
  }

  private async sync(job: Job): Promise<void> {
    if (job.isRunning || !this.needsSync(job)) {
      return;
    }

    job.isRunning = true;
    try {
      const { order } = await this.props.restClient.getOrder({ brokerOrderId: job.brokerOrderId });
      job.latestSyncDoneAt = this.now();

      if (order === null) {
        logger.error(`Alpaca does not know order ${job.brokerOrderId}, which it previously reported. Retiring it.`);
        this.removeJob(job.brokerOrderId);
        return;
      }

      if (isTerminalStatus(order.status)) {
        this.removeJob(order.id);
      }

      if (job.latestEvent === undefined || isBefore(job.latestEvent, order)) {
        logger.warn(`Recovered a missed ${alpacaOrderToString(order)}.`);
        // Assigned before the handler runs and with nothing awaited in between: a
        // websocket event arriving mid-handler would otherwise be overwritten by this
        // older picture.
        job.latestEvent = order;
        this.onEvent(order);
      }
    } finally {
      job.isRunning = false;
    }
  }

  private needsSync(job: Job): boolean {
    const lastHeard = Math.max(job.latestEventReceivedAt, job.latestSyncDoneAt);
    const silentFor = this.now() - lastHeard;

    // Placed but never heard about, or accepted and not yet working at the venue.
    if ((job.latestEvent === undefined || isPendingStatus(job.latestEvent.status)) && silentFor > 1_000) {
      return true;
    }

    if (job.latestEvent !== undefined && isInProgressStatus(job.latestEvent.status)) {
      if (job.latestEvent.type === 'market' && silentFor > 10_000) {
        return true;
      }
      if (job.latestEvent.type === 'limit' && silentFor > 5 * 60_000) {
        return true;
      }
    }

    return false;
  }

  private removeJob(brokerOrderId: string): void {
    this.jobs = this.jobs.filter((job) => job.brokerOrderId !== brokerOrderId);
  }
}
