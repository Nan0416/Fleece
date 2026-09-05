import {
  AsyncQueue,
  Broker,
  BrokerOrder,
  BrokerOrderAttribution,
  BrokerOrderEvent,
  BrokerOrderRecord,
  Decimal,
  defaultContractMultiplier,
  isTerminalStatus,
  LoggerFactory,
} from '@fleece/shared';
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

/** Which account an event belongs to, and how that was decided. */
interface Attribution {
  readonly accountId: string;
  readonly attribution: BrokerOrderAttribution;
}

type Work = { readonly type: 'event'; readonly job: BrokerOrderEventJob } | { readonly type: 'tracking'; readonly request: TrackBrokerOrdersRequest };

/**
 * Turns broker order events into ledger entries.
 *
 * The hard part is not the arithmetic — the ledger owns that — but deciding *whose*
 * fill an event is. An order's virtual account can come from four places, in
 * descending order of trust: the correlation the broker echoes back, the broker order
 * already recorded, a tracking request from the execution service, and finally a
 * default account for orders that belong to nobody. Which one answered is recorded on
 * the row as `attribution`, so a number can be traced back to how much it should be
 * trusted rather than only to what it says.
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
   * already records. It cannot move an order that is already attributed — `claimBrokerOrder`
   * guards that in the UPDATE — and a disagreement is logged with the existing
   * attribution left standing. Ordering does not matter either way; a request arriving
   * before the events is remembered, and one arriving after releases what is held.
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

    if (existing !== null && existing.accountId !== resolved.accountId) {
      // An order's account does not change. The upsert below will not move it, so this
      // says what was ignored rather than warning about something that then happens.
      logger.error(
        `Broker order ${event.id} is booked to account ${existing.accountId} by ${existing.attribution} but was just reported as belonging to ${resolved.accountId}. Leaving it where it is.`,
      );
    }

    await this.props.brokerOrderService.recordBrokerOrder(this.toRecordRequest(job, existing?.accountId ?? resolved.accountId, existing?.attribution ?? resolved.attribution));

    // An order that fell through to the catch-all account and has since acquired a real
    // attribution is moved onto it. Guarded in the UPDATE, so this cannot take an order
    // away from an attribution that already stuck.
    if (existing !== null && existing.attribution === 'default' && resolved.attribution !== 'default') {
      await this.props.brokerOrderService.claimBrokerOrder({ brokerOrderId: event.id, accountId: resolved.accountId, attribution: resolved.attribution });
    }

    await this.props.brokerOrderService.insertRecord({ record: job.originalEvent });
    await this.applyFill(event, existing?.accountId ?? resolved.accountId);

    if (isTerminalStatus(event.status)) {
      // Nothing more will arrive for this order, so stop holding what was learned
      // about it.
      this.associations.delete(event.id);
    }
  }

  /**
   * Which account this event belongs to, and how that was decided.
   *
   * The order of the branches *is* the order of trust, and each one names a different
   * kind of claim:
   *
   * - a leg carrying its parent's correlation is attributed `parent`, because that is
   *   what it is — Alpaca gives legs client order ids of its own, so an account on a leg
   *   can only have come from the composite it belongs to;
   * - anything else carrying a correlation said so itself;
   * - a broker order already recorded keeps whatever decided it the first time;
   * - a tracking request is somebody else's word for it;
   * - and a default account means nobody claimed it at all.
   */
  private resolve(job: BrokerOrderEventJob, existing: BrokerOrder | null): Attribution | undefined {
    const { event } = job;
    if (event.accountId !== undefined) {
      return { accountId: event.accountId, attribution: event.parentBrokerOrderId === undefined ? 'correlation' : 'parent' };
    }
    if (existing !== null) {
      return { accountId: existing.accountId, attribution: existing.attribution };
    }
    const association = this.associations.get(event.id);
    if (association !== undefined) {
      return { accountId: association, attribution: 'tracking' };
    }
    if (job.defaultAccountId !== undefined) {
      return { accountId: job.defaultAccountId, attribution: 'default' };
    }
    return undefined;
  }

  private toRecordRequest(job: BrokerOrderEventJob, accountId: string, attribution: BrokerOrderAttribution): RecordBrokerOrderRequest {
    const { event } = job;
    return {
      brokerOrderId: event.id,
      parentBrokerOrderId: event.parentBrokerOrderId,
      accountId,
      broker: job.broker,
      brokerAccountId: job.brokerAccountId,
      attribution,
      // A composite parent trades no instrument of its own, and the column is NULL
      // rather than an empty string for it. The converter discards spread parents, so
      // nothing writes one today.
      symbol: isMultiLegParent(event) ? undefined : event.symbol,
      assetClass: event.assetClass,
      multiplier: multiplierFor(event),
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
    // A spread's parent trades no instrument: its symbol is empty and its filled price
    // is the package's net debit or credit — `-0.9` for one that sold a contract at 3.85
    // and bought another at 2.95. Booking it would open a position keyed on the empty
    // string at a price nothing traded at. The legs carry the real instruments and
    // arrive as events of their own.
    if (isMultiLegParent(event)) {
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
    const multiplier = multiplierFor(event);
    const cumulativeFilledTotalCost = event.filledQty.mul(event.filledAvgPrice).mul(multiplier);

    if (!multiplier.eq(Decimal.ONE)) {
      logger.info(
        `Broker order ${event.id} filled ${event.filledQty.toString()} ${event.symbol} contracts at ${event.filledAvgPrice.toString()}, booked as ${cumulativeFilledTotalCost.toString()} at a multiplier of ${multiplier.toString()}.`,
      );
    }

    // The report is cumulative; the ledger works out how much of it is new, so a
    // duplicate — the websocket and the REST backfill both reporting a fill — changes
    // nothing.
    await this.props.ledgerService.applyCumulativeFill({
      referenceId: event.id,
      accountId,
      symbol: event.symbol,
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

      // Only an order nobody claimed can be moved, and the UPDATE is what enforces it.
      const { claimed } = await this.props.brokerOrderService.claimBrokerOrder({ brokerOrderId, accountId: request.accountId, attribution: 'tracking' });
      if (!claimed) {
        logger.error(
          `Broker order ${brokerOrderId} is booked to account ${existing.accountId} by ${existing.attribution} but was just claimed by ${request.accountId}. Leaving it where it is.`,
        );
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
   *
   * It is recorded as `attribution: 'default'`, which is what "orphan" now means and
   * what `broker-order orphans` lists.
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

/**
 * Units of the underlying per contract.
 *
 * The event carries one only if the broker told us; otherwise the asset class supplies
 * the default, which is 100 for an option and 1 for everything else. Whichever it is,
 * it is written onto every row the fill touches — that is what makes an adjusted
 * contract a query rather than a silent error.
 */
function multiplierFor(event: BrokerOrderEvent): Decimal {
  return event.multiplier ?? defaultContractMultiplier(event.assetClass);
}

/**
 * The container of a spread, as opposed to one of its contracts.
 *
 * Both carry `orderClass: 'mleg'`, and only the parent has no symbol. The converter
 * discards spread parents, so nothing here sees one today; the check stays because the
 * cost of being wrong is a position keyed on the empty string, which is a wrong number
 * that looks like a right one.
 */
function isMultiLegParent(event: BrokerOrderEvent): boolean {
  return event.orderClass === 'mleg' && event.symbol === '';
}
