import { AsyncQueue, Broker, BrokerOrder, BrokerOrderEvent, BrokerOrderRecord, Decimal, eventContractMultiplier, isTerminalStatus, LoggerFactory } from '@fleece/shared';
import { BrokerOrderService, LedgerService, RecordBrokerOrderRequest } from '@fleece/core';

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
 * An upstream service naming the virtual account for orders it has just placed, for
 * the orders it could not stamp that onto itself.
 */
export interface TrackBrokerOrdersRequest {
  readonly brokerOrderIds: ReadonlyArray<string>;
  readonly accountId: string;
}

export type DefaultAccountIdProvider = (broker: Broker, brokerAccountId: string, live: boolean) => string;

export interface OrderTrackingFacadeProps {
  readonly ledgerService: LedgerService;
  readonly brokerOrderService: BrokerOrderService;
  readonly defaultAccountIdProvider: DefaultAccountIdProvider;
  readonly unresolvedTimeoutMs?: number;
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
 * default account for orders that belong to nobody. Whichever answers first is what the
 * order keeps — see `resolve`.
 *
 * Everything runs through one queue. Two events for the same order processed
 * concurrently would each decide independently what to record, and while the write is
 * now an upsert and would survive that, the reads that feed it would not.
 */
export class OrderTrackingFacade {
  private readonly queue: AsyncQueue<Work>;
  private readonly associations = new Map<string, string>();
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
   * Accepts a hint from whoever placed an order about which virtual account it belongs
   * to.
   *
   * **Why this exists.** An order normally carries its own identity: the execution
   * service encodes the account into Alpaca's `client_order_id`, and Alpaca echoes that
   * back on every event. That covers any order we place directly, and — since the
   * converter gives every leg its parent's correlation — the legs of anything we place
   * as a composite. What it does not cover is an order Alpaca reports standalone that
   * Fleece never placed.
   *
   * **What it is worth.** Without a tracking request, an unattributable event sits in
   * the holding pen until `unresolvedTimeoutMs` expires and is then booked to the
   * default account. A tracking request releases the held events at once and books them
   * to the strategy that earned them.
   *
   * **What it is not.** It is a fallback, not an override: it sits last in the
   * resolution order, behind the broker's own echo and behind whatever the broker order
   * already records. It cannot move an order that is already recorded, whatever it
   * claims — a disagreement is logged and the account already recorded stands. Ordering
   * does not matter either way; a request arriving before the events is remembered, and
   * one arriving after releases what is held.
   *
   * **Nothing calls this yet.** Its transport is unported; see `md/OPEN-ITEMS.md` item 1.
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
    const resolved = this.resolve(job, existing);

    if (resolved === undefined) {
      this.hold(job);
      return;
    }

    if (existing !== null && existing.accountId !== resolved) {
      // Reported, not applied. An order's account is decided once — see `resolve` — and
      // this says what was ignored rather than warning about something that then happens.
      logger.error(`Broker order ${event.id} is booked to account ${existing.accountId} but was just reported as belonging to ${resolved}. Leaving it where it is.`);
    }

    // Whatever answered first stands, which is why the existing account wins here.
    const accountId = existing?.accountId ?? resolved;

    await this.props.brokerOrderService.recordBrokerOrder(this.toRecordRequest(job, accountId));
    await this.props.brokerOrderService.insertRecord({ record: job.originalEvent });
    await this.applyFill(event, accountId);

    if (isTerminalStatus(event.status)) {
      // Nothing more will arrive for this order, so stop holding what was learned
      // about it.
      this.associations.delete(event.id);
    }
  }

  /**
   * Which account this event belongs to. Undefined means nothing knows yet, and the
   * event is held.
   *
   * **Decided once, and never revisited.** Whatever answers first is what the order
   * keeps: `recordBrokerOrder` does not overwrite an account, and nothing anywhere can
   * move one afterwards. That is not tidiness. Every `ledger_transaction`, `position`,
   * `profit` row and `order_fill_progress` counter an order produces is keyed by the
   * account it was booked to, so moving the order alone strands all of them — and the
   * next cumulative report then reads a progress counter that does not exist for the new
   * account and books the whole fill a second time. The legacy refused to move one for
   * exactly this reason, raising a fatal-error metric instead. An order genuinely in the
   * wrong account is corrected by transferring the *position*, which moves the cost
   * basis and leaves both sides an audit trail.
   *
   * The order of the branches is the order of trust, and each answers a different way:
   *
   * - the broker echoed back a correlation we set, which is the order's own statement
   *   about itself — and on a leg, its parent's, since Alpaca gives legs client order
   *   ids of its own and the converter passes the composite's correlation down;
   * - a broker order already recorded keeps whatever decided it the first time;
   * - a tracking request is somebody else's word for it;
   * - and a default account means nobody claimed it at all.
   *
   * Which of those answered is not recorded. It is recoverable where it matters — the
   * `client_order_id` is kept verbatim in `broker_order_record`, a leg's parent is on
   * its own row, and an unclaimed order is one sitting in a configured catch-all
   * account — so a column repeating it on every order would only be a second place for
   * the same fact to be wrong.
   */
  private resolve(job: BrokerOrderEventJob, existing: BrokerOrder | null): string | undefined {
    const { event } = job;
    return event.accountId ?? existing?.accountId ?? this.associations.get(event.id) ?? job.defaultAccountId;
  }

  private toRecordRequest(job: BrokerOrderEventJob, accountId: string): RecordBrokerOrderRequest {
    const { event } = job;
    return {
      brokerOrderId: event.id,
      parentBrokerOrderId: event.parentBrokerOrderId,
      accountId,
      broker: job.broker,
      brokerAccountId: job.brokerAccountId,
      // NULL on a composite parent, which trades no instrument of its own. The
      // converter has already turned Alpaca's empty string into `undefined`.
      symbol: event.symbol,
      assetClass: event.assetClass,
      multiplier: eventContractMultiplier(event),
      status: event.status,
      orderClass: event.orderClass,
      orderType: event.orderType,
      side: event.side,
      positionIntent: event.positionIntent,
      timeInForce: event.timeInForce,
      extendedHours: event.extendedHours,
      qty: event.qty,
      ratioQty: event.ratioQty,
      limitPrice: event.limitPrice,
      stopPrice: event.stopPrice,
      filledQty: event.filledQty,
      filledAvgPrice: event.filledAvgPrice,
      submittedAt: event.createdAt,
      filledAt: event.filledAt,
    };
  }

  private async applyFill(event: BrokerOrderEvent, accountId: string): Promise<void> {
    // A spread's parent trades no instrument, and its filled price is the package's
    // signed net — `-0.9` for one that sold a contract at 3.85 and bought another at
    // 2.95. There is nothing to open a position in and no price anything traded at. The
    // legs carry the real instruments and arrive as events of their own.
    //
    // Checked here rather than through a helper so the compiler narrows `symbol` for
    // everything below: a missing instrument must be unable to reach the ledger, and
    // that is a stronger guarantee than remembering to call the right predicate.
    const { symbol } = event;
    if (symbol === undefined) {
      return;
    }

    if (event.status !== 'filled' && event.status !== 'partially_filled') {
      return;
    }
    if (event.filledAvgPrice === undefined) {
      logger.error(`Broker order ${event.id} reports status ${event.status} with no filled price. Not recording a fill for it.`);
      return;
    }

    // **This is where the broker's units become the ledger's.** An option contract is a
    // claim on `multiplier` shares and the broker quotes its premium per share, so a
    // contract filled at 3.85 moved $385. The size stays in contracts — two contracts
    // read as 2, which is what anyone looking at a position means — and the multiplier
    // goes into the dollars. That keeps a total cost in dollars for every instrument,
    // which is what lets one virtual account hold stock and options and still add up.
    //
    // The multiplier is recorded alongside rather than assumed downstream, so an
    // adjusted contract booked at the default 100 is findable rather than silently
    // wrong by the ratio of its real multiplier to 100. See `md/OPEN-ITEMS.md` item 2b.
    const multiplier = eventContractMultiplier(event);
    const cumulativeFilledTotalCost = event.filledQty.mul(event.filledAvgPrice).mul(multiplier);

    if (!multiplier.eq(Decimal.ONE)) {
      logger.info(
        `Broker order ${event.id} filled ${event.filledQty.toString()} ${symbol} contracts at ${event.filledAvgPrice.toString()}, booked as ${cumulativeFilledTotalCost.toString()} at a multiplier of ${multiplier.toString()}.`,
      );
    }

    // The report is cumulative; the ledger works out how much of it is new, so a
    // duplicate — the websocket and the REST backfill both reporting a fill — changes
    // nothing.
    await this.props.ledgerService.applyCumulativeFill({
      referenceId: event.id,
      accountId,
      symbol,
      assetClass: event.assetClass,
      multiplier,
      cumulativeFilledSize: event.filledQty,
      cumulativeFilledTotalCost,
      timestamp: event.filledAt ?? event.updatedAt,
    });
  }

  private async processTrackingRequest(request: TrackBrokerOrdersRequest): Promise<void> {
    logger.info(`Tracking request for broker orders ${request.brokerOrderIds.join(', ')} in account ${request.accountId}.`);

    for (const brokerOrderId of request.brokerOrderIds) {
      const existing = await this.props.brokerOrderService.findBrokerOrder(brokerOrderId);

      if (existing === null) {
        // Not seen yet; remember it for whenever the first event arrives.
        this.associations.set(brokerOrderId, request.accountId);
        continue;
      }

      if (existing.accountId === request.accountId) {
        continue;
      }

      // Reported, not applied — the legacy raised a fatal-error metric here and left the
      // order alone, and so does this. See `resolve` for why moving it would be worse
      // than leaving it wrong.
      logger.error(
        `Broker order ${brokerOrderId} is booked to account ${existing.accountId} but was just claimed by ${request.accountId}. Leaving it where it is. If it really belongs to ${request.accountId}, move the position with a transfer rather than the order.`,
      );
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
   *
   * That is all "orphan" means: an order sitting in a configured catch-all account.
   * Finding them is a search by account, which `listBrokerOrders` already indexes —
   * there is no column marking each one, because the fact belongs to the account.
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
