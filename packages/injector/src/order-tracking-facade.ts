import { AsyncQueue, Broker, BrokerOrderEvent, BrokerOrderRecord, isTerminalStatus, LoggerFactory, NotFoundError } from '@fleece/shared';
import { BrokerOrderService, LedgerService } from '@fleece/core';

const logger = LoggerFactory.getLogger('OrderTrackingFacade');

/**
 * How long to hold an event whose virtual account cannot yet be determined, before
 * giving up and booking it to the default account.
 *
 * The wait exists for leg orders: the second leg of an OTO arrives from the broker
 * with no correlation of its own, and the upstream execution service names its account
 * in a tracking request that may not have arrived yet. A minute is long enough for
 * that request to turn up and short enough that a genuinely external order — one
 * placed by hand on the broker's website — is not left unrecorded for long.
 */
const DEFAULT_UNRESOLVED_TIMEOUT_MS = 60_000;

export interface BrokerOrderEventJob {
  readonly event: BrokerOrderEvent;
  /** The broker's own payload, stored verbatim so an execution can be replayed. */
  readonly originalEvent: BrokerOrderRecord;
  readonly broker: Broker;
  readonly brokerAccountId: string;
  readonly live: boolean;
  /** Set only on a redrive, once waiting for an account has been given up on. */
  readonly defaultAccountId?: string;
}

/**
 * An upstream service naming the virtual account and group for orders it has just
 * placed, for the orders it could not stamp that onto itself.
 */
export interface TrackBrokerOrdersRequest {
  readonly brokerOrderIds: ReadonlyArray<string>;
  readonly accountId: string;
  readonly groupId?: string;
}

export type DefaultAccountIdProvider = (broker: Broker, brokerAccountId: string, live: boolean) => string;

export interface OrderTrackingFacadeProps {
  readonly ledgerService: LedgerService;
  readonly brokerOrderService: BrokerOrderService;
  readonly defaultAccountIdProvider: DefaultAccountIdProvider;
  readonly unresolvedTimeoutMs?: number;
}

interface Association {
  readonly accountId: string;
  readonly groupId?: string;
}

interface HeldEvents {
  timeout?: NodeJS.Timeout;
  readonly jobs: BrokerOrderEventJob[];
}

type Work = { readonly type: 'event'; readonly job: BrokerOrderEventJob } | { readonly type: 'tracking'; readonly request: TrackBrokerOrdersRequest };

/**
 * Turns broker order events into ledger entries.
 *
 * The hard part is not the arithmetic — the ledger owns that — but deciding *whose*
 * fill an event is. An order's virtual account can come from four places, in
 * descending order of trust: the correlation the broker echoes back, the broker order
 * already recorded, a tracking request from the execution service, and finally a
 * default account for orders that belong to nobody.
 *
 * Everything runs through one queue. Two events for the same order processed
 * concurrently would each decide independently whether to create the broker order,
 * and one of the two inserts would fail on the primary key.
 */
export class OrderTrackingFacade {
  private readonly queue: AsyncQueue<Work>;
  private readonly associations = new Map<string, Association>();
  private readonly held = new Map<string, HeldEvents>();
  private readonly unresolvedTimeoutMs: number;

  constructor(private readonly props: OrderTrackingFacadeProps) {
    this.unresolvedTimeoutMs = props.unresolvedTimeoutMs ?? DEFAULT_UNRESOLVED_TIMEOUT_MS;
    this.queue = new AsyncQueue<Work>(async (work) => {
      if (work.type === 'event') {
        await this.processEvent(work.job);
      } else {
        await this.processTrackingRequest(work.request);
      }
    });
  }

  enqueue(job: BrokerOrderEventJob): void {
    this.queue.enqueue({ type: 'event', job });
  }

  /**
   * Accepts a hint from whoever placed an order about which virtual account and group
   * it belongs to.
   *
   * **Why this exists.** An order normally carries its own identity: the execution
   * service encodes the account and group into Alpaca's `client_order_id`, and Alpaca
   * echoes that back on every event. That covers any order we place directly. It does
   * not cover the *legs* of a composite order — a bracket, OTO or OCO — because Alpaca
   * creates those itself and assigns them client order ids of its own. A leg therefore
   * arrives carrying nothing that says whose it is, and only the service that asked for
   * the composite order knows.
   *
   * **What it is worth.** Without a tracking request, an unattributable event sits in
   * the holding pen until `unresolvedTimeoutMs` expires and is then booked to the
   * default account — so every bracket leg would be attributed to nobody a minute after
   * the fact. A tracking request releases the held events at once and books them to the
   * strategy that earned them.
   *
   * **What it is not.** It is a fallback, not an override: it sits last in the
   * resolution order, behind the broker's own echo and behind whatever the broker order
   * already records. It cannot move an order that is already attributed — a
   * disagreement is logged and the existing attribution stands. Ordering does not
   * matter either way; a request arriving before the events is remembered, and one
   * arriving after releases what is held.
   *
   * **Nothing calls this yet.** Its transport is unported. In the legacy system the
   * request arrived over a message stream: `TrackingProcessor` was bound to `PUT /track`
   * on a `lite-server` listening on the `OrderTracking.{STAGE}` topic, and the whole
   * `lite-server` / `message-subscriber` layer belongs to the platform this port leaves
   * behind. Its only client was `order-execution-service`, which is also unported — so
   * this is currently unreachable rather than broken, and it matters the day composite
   * orders start being placed. See `md/PORTING.md`.
   */
  track(request: TrackBrokerOrdersRequest): void {
    this.queue.enqueue({ type: 'tracking', request });
  }

  /** Resolves once every queued event has been applied. Used on shutdown. */
  async drain(): Promise<void> {
    await this.queue.drain();
  }

  /** Cancels the timers holding unresolved events, so the process can exit. */
  stop(): void {
    for (const entry of this.held.values()) {
      if (entry.timeout !== undefined) {
        clearTimeout(entry.timeout);
      }
    }
    this.held.clear();
  }

  private async processEvent(job: BrokerOrderEventJob): Promise<void> {
    const { event } = job;
    const existing = await this.props.brokerOrderService.findBrokerOrder(event.id);
    const association = this.associations.get(event.id);

    const groupId = event.groupId ?? existing?.groupId ?? association?.groupId;
    const accountId = event.accountId ?? existing?.accountId ?? association?.accountId ?? job.defaultAccountId;

    if (accountId === undefined) {
      this.hold(job);
      return;
    }

    if (existing === null) {
      logger.info(`Recording new ${job.broker} order ${event.id} for account ${accountId}${groupId === undefined ? ' with no group' : ` in group ${groupId}`}.`);
      await this.props.brokerOrderService.createBrokerOrder({
        brokerOrderId: event.id,
        symbol: event.symbol,
        broker: job.broker,
        brokerAccountId: job.brokerAccountId,
        status: event.status,
        accountId,
        groupId,
      });
    } else {
      if (existing.status !== event.status) {
        await this.props.brokerOrderService.setStatus({ brokerOrderId: event.id, status: event.status });
      }
      if (existing.groupId === undefined && groupId !== undefined) {
        await this.props.brokerOrderService.setGroupId({ brokerOrderId: event.id, groupId });
      } else if (existing.groupId !== undefined && groupId !== undefined && existing.groupId !== groupId) {
        // An order's group never changes. If this fires, something upstream is
        // reporting a different group for an order it already placed.
        logger.error(`Broker order ${event.id} is in group ${existing.groupId} but was just reported as being in ${groupId}. Leaving it where it is.`);
      }
    }

    await this.props.brokerOrderService.insertRecord({ record: job.originalEvent });
    await this.applyFill(event, accountId);

    if (isTerminalStatus(event.status)) {
      // Nothing more will arrive for this order, so stop holding what was learned
      // about it.
      this.associations.delete(event.id);
    }
  }

  private async applyFill(event: BrokerOrderEvent, accountId: string): Promise<void> {
    if (event.status !== 'filled' && event.status !== 'partially_filled') {
      return;
    }
    if (typeof event.filledAvgPrice !== 'number') {
      logger.error(`Broker order ${event.id} reports status ${event.status} with no filled price. Not recording a fill for it.`);
      return;
    }

    // The report is cumulative; the ledger works out how much of it is new, so a
    // duplicate — the websocket and the REST backfill both reporting a fill — changes
    // nothing.
    await this.props.ledgerService.applyCumulativeFill({
      referenceId: event.id,
      accountId,
      symbol: event.symbol,
      cumulativeFilledSize: event.filledQty,
      cumulativeFilledAvgPrice: event.filledAvgPrice,
      timestamp: event.filledAt ?? event.updatedAt,
    });
  }

  private async processTrackingRequest(request: TrackBrokerOrdersRequest): Promise<void> {
    logger.info(`Tracking request for broker orders ${request.brokerOrderIds.join(', ')} in account ${request.accountId}.`);

    for (const brokerOrderId of request.brokerOrderIds) {
      const existing = await this.props.brokerOrderService.findBrokerOrder(brokerOrderId);

      if (existing === null) {
        // Not seen yet; remember it for whenever the first event arrives.
        this.associations.set(brokerOrderId, { accountId: request.accountId, groupId: request.groupId });
        continue;
      }

      if (existing.accountId !== request.accountId) {
        logger.error(`Broker order ${brokerOrderId} is booked to account ${existing.accountId} but was just claimed by ${request.accountId}. Leaving it where it is.`);
      }

      if (existing.groupId === undefined && request.groupId !== undefined) {
        try {
          await this.props.brokerOrderService.setGroupId({ brokerOrderId, groupId: request.groupId });
        } catch (err) {
          if (err instanceof NotFoundError) {
            logger.error(`Cannot bind broker order ${brokerOrderId} to group ${request.groupId}: ${err.message}`);
          } else {
            throw err;
          }
        }
      } else if (existing.groupId !== undefined && request.groupId !== undefined && existing.groupId !== request.groupId) {
        logger.error(`Broker order ${brokerOrderId} is in group ${existing.groupId} but was just claimed for ${request.groupId}. Leaving it where it is.`);
      }
    }

    // Now that an account is known, anything held for these orders can be applied.
    for (const brokerOrderId of request.brokerOrderIds) {
      this.release(brokerOrderId);
    }
  }

  /** Holds an event whose account is unknown, and starts the clock on giving up. */
  private hold(job: BrokerOrderEventJob): void {
    const { event } = job;
    const existing = this.held.get(event.id);
    if (existing !== undefined) {
      existing.jobs.push(job);
      return;
    }

    logger.warn(`Broker order ${event.id} has no virtual account yet; holding its events for ${this.unresolvedTimeoutMs}ms.`);
    this.held.set(event.id, {
      jobs: [job],
      timeout: setTimeout(() => this.releaseToDefaultAccount(event.id), this.unresolvedTimeoutMs),
    });
  }

  /** Re-queues held events now that an account is known. */
  private release(brokerOrderId: string): void {
    const entry = this.held.get(brokerOrderId);
    if (entry === undefined) {
      return;
    }
    if (entry.timeout !== undefined) {
      clearTimeout(entry.timeout);
    }
    this.held.delete(brokerOrderId);

    logger.info(`Applying ${entry.jobs.length} held event(s) for broker order ${brokerOrderId}.`);
    for (const job of entry.jobs) {
      this.queue.enqueue({ type: 'event', job });
    }
  }

  /**
   * Gives up waiting and books the order to a default account.
   *
   * This is how an order placed outside the system — by hand on the broker's website,
   * most often — still lands in the ledger. It is booked to a catch-all account rather
   * than dropped, because the shares moved whether or not a strategy asked for them,
   * and a ledger that omits them will not reconcile against the brokerage statement.
   */
  private releaseToDefaultAccount(brokerOrderId: string): void {
    const entry = this.held.get(brokerOrderId);
    if (entry === undefined) {
      return;
    }
    this.held.delete(brokerOrderId);

    const first = entry.jobs[0];
    if (first === undefined) {
      return;
    }

    let defaultAccountId: string;
    try {
      defaultAccountId = this.props.defaultAccountIdProvider(first.broker, first.brokerAccountId, first.live);
    } catch (err) {
      logger.error(
        `No default account for ${first.live ? 'live' : 'paper'} ${first.broker} account ${first.brokerAccountId}; dropping ${entry.jobs.length} event(s) for order ${brokerOrderId}.`,
        err,
      );
      return;
    }

    logger.warn(`Broker order ${brokerOrderId} was never claimed; booking ${entry.jobs.length} event(s) to default account ${defaultAccountId}.`);
    for (const job of entry.jobs) {
      this.queue.enqueue({ type: 'event', job: { ...job, defaultAccountId } });
    }
  }
}
