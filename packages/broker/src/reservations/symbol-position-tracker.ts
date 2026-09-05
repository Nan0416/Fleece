import {
  BrokerOrderEvent,
  Decimal,
  defaultContractMultiplier,
  deriveUnitCost,
  eventContractMultiplier,
  isTerminalStatus,
  LoggerFactory,
  reconcilePosition,
  sumDecimals,
} from '@fleece/shared';
import { nanoid } from 'nanoid';
import { BuyingPowerLedger } from './buying-power';
import { NotReservableError } from '../models/errors';
import { PendingOrder, PositionTracker, RealisedProfit, ReservationRequest, TestResult } from '../models/trackers';
import { allSameSign, hasDifferentSign, nearerZero } from '../utils';

const logger = LoggerFactory.getLogger('SymbolPositionTracker');

/**
 * A hold taken before an order is sent, released when it fills or is cancelled.
 *
 * Exactly one of `lockedSize` and `reservedBuyingPower` is non-zero, decided by
 * direction: reducing a position holds units, increasing one holds cash.
 */
interface Reservation {
  readonly reservationId: string;
  /**
   * Units committed to an unfilled order that reduces the position, signed the same
   * way as the order. Long 20 with an open sell of 5 gives `lockedSize` of -5, and a
   * free size of 15 — those 5 cannot be sold twice.
   */
  lockedSize: Decimal;
  /** Still to fill. Falls towards zero as fills arrive. */
  pendingSize: Decimal;
  /** Cash held for an unfilled order that increases the position. Always positive. */
  reservedBuyingPower: Decimal;
}

/** What has already been applied for one broker order, so a repeat applies nothing. */
interface Session {
  readonly brokerOrderId: string;
  readonly reservationId: string;
  filledSize: Decimal;
  filledTotalCost: Decimal;
}

export interface SymbolPositionTrackerProps {
  readonly symbol: string;
  readonly brokerAccountId: string;
  readonly buyingPower: BuyingPowerLedger;
  readonly now?: () => number;
}

/**
 * One symbol's holding in one broker account, and every order in flight against it.
 *
 * `positionSize` is everything held; `freeSize` is what is not already promised to an
 * unfilled order. Keeping them apart is the whole point — it is what stops two
 * strategies selling the same shares, or two buys spending the same cash.
 *
 * **It accounts in total cost, exactly as the ledger does.** A position is a signed size
 * and the signed dollars behind it, and a fill is the same, so applying one is addition
 * and subtraction. The legacy carried a unit price here and divided a fill's cost back
 * out on every event to feed the next one, which is how a cost basis drifts. The one
 * division left is `unitCost`, which is derived on read and never fed back in.
 *
 * **What it holds and what it cannot.** A reservation is `|size| x unitPrice x
 * multiplier` — right for an equity either way, and right for an option being bought,
 * because a contract quoted at 3.85 costs $385. It is refused outright for an order that
 * opens or extends a **short** option position: that requirement is margin, and a naked
 * call's is unbounded. See `md/OPEN-ITEMS.md` item 2b.
 *
 * **Where reservations come from.** Only the first route is the happy path:
 *
 * 1. The caller reserved before placing, and the id was encoded into the order's
 *    `client_order_id`, so it comes back on every event.
 * 2. The order was already open when this process started. `setup` synthesises a
 *    reservation keyed by the broker order id.
 * 3. An event arrives with no reservation — a leg order, or one placed by hand on the
 *    broker's website. One is synthesised on the spot, again keyed by the broker order
 *    id.
 *
 * Route 2 is also why an event can carry a reservation id this tracker has never heard
 * of: the order was placed before a restart, and after the restart it is keyed by
 * broker order id instead. `track` falls back to that.
 *
 * **Against bad events.** Duplicates apply nothing, because a session records what has
 * already been applied and only the excess is acted on. Out-of-order events are
 * likewise absorbed. A dropped terminal event is the one thing this cannot survive, and
 * that is what the caller's REST backfill exists to prevent.
 */
export class SymbolPositionTracker implements PositionTracker {
  readonly symbol: string;
  private readonly profitLog: RealisedProfit[] = [];
  private readonly sessions = new Map<string, Session>();
  private readonly reservations = new Map<string, Reservation>();
  private readonly now: () => number;

  private _positionSize = Decimal.ZERO;
  private _freeSize = Decimal.ZERO;
  private _totalCost = Decimal.ZERO;
  private initialised = false;

  constructor(private readonly props: SymbolPositionTrackerProps) {
    this.symbol = props.symbol;
    this.now = props.now ?? Date.now;
  }

  get positionSize(): Decimal {
    return this._positionSize;
  }

  get freeSize(): Decimal {
    return this._freeSize;
  }

  get totalCost(): Decimal {
    return this._totalCost;
  }

  /** Derived, never stored: the one division in this class, and it is read-only. */
  get unitCost(): Decimal {
    return deriveUnitCost(this._totalCost, this._positionSize);
  }

  get profits(): ReadonlyArray<RealisedProfit> {
    return this.profitLog;
  }

  /**
   * Would this order be accepted? Returns the resulting position, or `undefined`.
   *
   * The rules are Alpaca's, confirmed against the live API rather than derived:
   *
   * - Long 10, open sell 5, then buy 20 — allowed. Opposing orders can coexist.
   * - Long 10, open buy 20, then sell 9 — allowed, for the same reason.
   * - Long 10, sell 15 — **refused**. An order may take a position to zero but not
   *   through it.
   * - Flat with an open buy 10, then short 10 — **refused**. While the position is
   *   flat, every unfilled order must point the same way.
   *
   * Partial fills are immediately tradable: 70 of a 100-share buy filled means 70
   * shares free to sell, without waiting for the rest.
   */
  test(request: ReservationRequest): TestResult | undefined {
    if (this.unreservable(request) !== undefined) {
      return undefined;
    }

    const result: TestResult = { originalSize: this._positionSize, newSize: this._positionSize.add(request.size) };
    const affordable = this.requiredBuyingPower(request).lte(this.props.buyingPower.availableBuyingPower);

    if (this._positionSize.isZero()) {
      const unfilled = [...this.reservations.values()].map((reservation) => reservation.pendingSize);
      if (!allSameSign(unfilled)) {
        // Provably impossible: while the position is non-zero the largest opposing
        // order allowed is the position itself, so by the time it reaches zero only
        // one direction can be outstanding.
        logger.error(`${this.symbol} has unfilled orders in both directions while flat.`);
      }
      const totalUnfilled = sumDecimals(unfilled);
      const agrees = totalUnfilled.isZero() || totalUnfilled.signum() === request.size.signum();
      return agrees && affordable ? result : undefined;
    }

    if (this._positionSize.isPositive()) {
      if (request.size.isPositive()) {
        return affordable ? result : undefined;
      }
      // Reducing: bounded by what is free, not by what is held.
      return request.size.add(this._freeSize).gte(Decimal.ZERO) ? result : undefined;
    }

    if (request.size.isNegative()) {
      return affordable ? result : undefined;
    }
    return request.size.add(this._freeSize).lte(Decimal.ZERO) ? result : undefined;
  }

  reserve(request: ReservationRequest): string {
    const unreservable = this.unreservable(request);
    if (unreservable !== undefined) {
      throw new NotReservableError(unreservable);
    }
    if (this.test(request) === undefined) {
      throw new NotReservableError(
        `Cannot reserve ${request.size.toString()} ${this.symbol}: the account has ${this._freeSize.toString()} free and ${this.props.buyingPower.availableBuyingPower.toString()} buying power.`,
      );
    }

    const reservationId = nanoid();
    // `hasDifferentSign` returns false against a flat position, so opening always takes
    // the buying-power branch.
    const reducing = hasDifferentSign(request.size, this._positionSize);

    if (reducing) {
      this._freeSize = this._freeSize.add(request.size);
      this.reservations.set(reservationId, { reservationId, lockedSize: request.size, pendingSize: request.size, reservedBuyingPower: Decimal.ZERO });
      logger.info(`Reserved ${request.size.abs().toString()} ${this.symbol} (${reservationId}); ${this._freeSize.toString()} now free.`);
    } else {
      // No unit price means no hold. That is a real gap rather than a decision — a
      // market buy with no estimate can oversubscribe the account — so the caller is
      // told rather than left to find out from the broker.
      const reserved = this.requiredBuyingPower(request);
      if (reserved.isZero()) {
        logger.warn(`Reserving no buying power for ${request.size.toString()} ${this.symbol}: no unit price was supplied, so nothing is held against a concurrent order.`);
      }
      this.props.buyingPower.onAvailableBuyingPowerChange(reserved.neg());
      this.reservations.set(reservationId, { reservationId, lockedSize: Decimal.ZERO, pendingSize: request.size, reservedBuyingPower: reserved });
      logger.info(`Reserved ${reserved.toString()} buying power for ${request.size.toString()} ${this.symbol} (${reservationId}).`);
    }

    return reservationId;
  }

  /**
   * Registers an order this process placed but took no hold for, so its fills are still
   * applied.
   *
   * Without it a spread — the one thing placed unheld today — is invisible to the
   * account. `track` refuses to adopt an order whose *first* event is terminal, because
   * the usual cause is a very late duplicate of something the REST backfill already
   * applied and adopting it would count the fill twice. A marketable spread fills the
   * instant it is placed, so its first event is exactly that shape, and the account
   * would never learn what it spent.
   *
   * Saying so at placement closes the hole without weakening the rule: the order is
   * known before any event arrives, so the event finds it rather than resurrecting it.
   * Nothing is held — the sizes are zero — and the session starts at zero, so every
   * contract the order fills is counted once.
   */
  expectOrder(brokerOrderId: string): void {
    if (this.reservations.has(brokerOrderId)) {
      return;
    }
    this.adoptPendingOrder({
      brokerOrderId,
      unfilledSize: Decimal.ZERO,
      partialFilledSize: Decimal.ZERO,
      partialTotalCost: Decimal.ZERO,
      multiplier: Decimal.ONE,
    });
  }

  cancel(reservationId: string): void {
    const reservation = this.reservations.get(reservationId);
    if (reservation === undefined) {
      return;
    }
    logger.info(`Releasing reservation ${reservationId}; its order never reached the broker.`);
    this.release(reservation);
  }

  /** Seeds from the broker's own view. Once only. */
  setup(positionSize: Decimal, totalCost: Decimal, pendingOrders: ReadonlyArray<PendingOrder> = []): void {
    if (this.initialised) {
      throw new Error(`The ${this.symbol} position tracker is already set up.`);
    }
    this.initialised = true;

    this._positionSize = positionSize;
    this._totalCost = totalCost;
    // Everything starts free, then each open order takes back what it has committed.
    this._freeSize = positionSize;

    for (const pendingOrder of pendingOrders) {
      this.adoptPendingOrder(pendingOrder);
    }

    logger.info(
      `${this.symbol}: ${this._positionSize.toString()} held, ${this._freeSize.toString()} free, basis ${this._totalCost.toString()}, ${pendingOrders.length} order(s) already open.`,
    );
  }

  track(event: BrokerOrderEvent): void {
    this.initialised = true;

    // By reservation id first, then by broker order id — an order placed before a
    // restart carries an id this process has never issued, and is keyed by the broker's
    // id instead.
    let reservation = typeof event.reservationId === 'string' ? this.reservations.get(event.reservationId) : undefined;
    reservation = reservation ?? this.reservations.get(event.id);

    if (reservation === undefined && !isTerminalStatus(event.status)) {
      // First sight of a leg order or an externally placed one. Terminal events are
      // excluded because a very late event for an order already reconciled by the REST
      // backfill would otherwise resurrect a reservation for a finished order.
      const multiplier = eventContractMultiplier(event);
      reservation = this.adoptPendingOrder({
        brokerOrderId: event.id,
        limitPrice: event.limitPrice,
        unfilledSize: event.qty.sub(event.filledQty),
        partialFilledSize: event.filledQty,
        partialTotalCost: event.filledAvgPrice === undefined ? Decimal.ZERO : event.filledQty.mul(event.filledAvgPrice).mul(multiplier),
        multiplier,
      });
    }

    if (reservation === undefined) {
      logger.warn(`Ignoring terminal event for ${event.id}: its reservation is already released. A late duplicate of something already applied.`);
      return;
    }

    const session = this.sessionFor(event, reservation.reservationId);
    this.apply(event, session, reservation);
  }

  /**
   * Applies whatever part of a cumulative fill report is new.
   *
   * The comparison on magnitude is what makes a duplicate a no-op: the broker reports
   * totals, and a repeat carries a total already recorded.
   *
   * **This is where the broker's units become the account's.** The broker quotes an
   * option's premium per share, so a contract filled at 3.85 moved $385 — the same
   * conversion the ledger's fill path makes, from the same helper, because a hold that
   * disagreed with the ledger about what a fill cost would drift from it on every trade.
   */
  private apply(event: BrokerOrderEvent, session: Session, reservation: Reservation): void {
    if (event.filledQty.abs().gt(session.filledSize.abs()) && event.filledAvgPrice !== undefined) {
      const filledTotalCost = event.filledQty.mul(event.filledAvgPrice).mul(eventContractMultiplier(event));

      // Both are differences of cumulative totals, so no division appears anywhere on
      // this path: the fill's size and its dollars are carried through as they are.
      this.reconcile(event.filledQty.sub(session.filledSize), filledTotalCost.sub(session.filledTotalCost), reservation);

      session.filledSize = event.filledQty;
      session.filledTotalCost = filledTotalCost;
    }

    if (isTerminalStatus(event.status)) {
      this.sessions.delete(event.id);
      this.release(reservation);
    }
  }

  /**
   * Moves the position, the cost basis and the realised profit, then settles the fill
   * against the reservation that paid for it.
   *
   * The position arithmetic is `reconcilePosition` from `@fleece/shared` — the same
   * function the ledger uses. The legacy carried a second copy of it here, which is two
   * places for a cost basis to be computed differently.
   */
  private reconcile(filledSize: Decimal, filledTotalCost: Decimal, reservation: Reservation): void {
    const reducing = hasDifferentSign(filledSize, this._positionSize);

    const result = reconcilePosition({
      positionSize: this._positionSize,
      positionTotalCost: this._totalCost,
      transactionSize: filledSize,
      transactionTotalCost: filledTotalCost,
    });

    if (result.transactionProfit !== undefined) {
      this.profitLog.push({ profit: result.transactionProfit, size: filledSize, timestamp: this.now() });
    }
    this._totalCost = result.positionTotalCost;
    this._positionSize = result.positionSize;

    this.settleBuyingPower(result.buyingPowerDelta, reducing, reservation);
    this.settleShares(filledSize, reducing, reservation);
    reservation.pendingSize = reservation.pendingSize.sub(filledSize);
  }

  /**
   * A buy draws on what it reserved before touching the account.
   *
   * Reserving 1700 and filling 4 shares at 168 consumes 672 of the reservation, not of
   * the account — the account already gave that 1700 up at reservation time. Only what
   * the reservation cannot cover reaches the account balance.
   */
  private settleBuyingPower(buyingPowerDelta: Decimal, reducing: boolean, reservation: Reservation): void {
    let delta = buyingPowerDelta;
    if (reservation.reservedBuyingPower.isPositive() && !reducing) {
      const required = delta.abs();
      const fromReservation = reservation.reservedBuyingPower.lt(required) ? reservation.reservedBuyingPower : required;
      reservation.reservedBuyingPower = reservation.reservedBuyingPower.sub(fromReservation);
      delta = delta.add(fromReservation);
    }
    this.props.buyingPower.onAvailableBuyingPowerChange(delta);
  }

  /**
   * A sell consumes the units it locked before touching the free size.
   *
   * Long 10 with a reserved sell of 5, and 3 fill: the 3 come out of the reservation's
   * locked 5, leaving 2 locked and the free size unchanged. The shares were already
   * spoken for.
   */
  private settleShares(filledSize: Decimal, reducing: boolean, reservation: Reservation): void {
    if (!reducing) {
      this._freeSize = this._freeSize.add(filledSize);
      return;
    }
    const fromLocked = nearerZero(reservation.lockedSize, filledSize);
    reservation.lockedSize = reservation.lockedSize.sub(fromLocked);
    this._freeSize = this._freeSize.add(filledSize.sub(fromLocked));
  }

  /**
   * Takes on an order that already exists at the broker, keyed by its broker order id.
   *
   * The session starts at whatever the order has *already* filled, and that is the
   * important part: those units are assumed to be in the position the broker reported
   * at setup, so applying them again would count them twice. Only fills after this
   * point move the position.
   *
   * The assumption holds for the case this exists for — an order already open when the
   * process started. It is wrong in one corner: an order placed after setup whose early
   * events were all missed, where the first event seen already shows fills. Those
   * fills are then never applied. Preserved from the legacy deliberately, because
   * double-counting a fill is the worse of the two errors and the REST backfill exists
   * to keep the corner from arising.
   */
  private adoptPendingOrder(pendingOrder: PendingOrder): Reservation {
    const freeAfter = this._freeSize.add(pendingOrder.unfilledSize);
    const reducing = freeAfter.abs().lt(this._freeSize.abs());

    const reservation: Reservation = reducing
      ? { reservationId: pendingOrder.brokerOrderId, lockedSize: pendingOrder.unfilledSize, pendingSize: pendingOrder.unfilledSize, reservedBuyingPower: Decimal.ZERO }
      : {
          reservationId: pendingOrder.brokerOrderId,
          lockedSize: Decimal.ZERO,
          pendingSize: pendingOrder.unfilledSize,
          // A market order already open has no limit price, so nothing can be held for
          // it. The multiplier is what makes an open option order hold its premium in
          // dollars rather than per share.
          reservedBuyingPower: pendingOrder.limitPrice === undefined ? Decimal.ZERO : pendingOrder.limitPrice.mul(pendingOrder.unfilledSize.abs()).mul(pendingOrder.multiplier),
        };

    if (reducing) {
      this._freeSize = freeAfter;
    } else {
      this.props.buyingPower.onAvailableBuyingPowerChange(reservation.reservedBuyingPower.neg());
    }

    this.reservations.set(reservation.reservationId, reservation);
    this.sessions.set(pendingOrder.brokerOrderId, {
      brokerOrderId: pendingOrder.brokerOrderId,
      reservationId: pendingOrder.brokerOrderId,
      filledSize: pendingOrder.partialFilledSize,
      filledTotalCost: pendingOrder.partialTotalCost,
    });
    return reservation;
  }

  private sessionFor(event: BrokerOrderEvent, reservationId: string): Session {
    const existing = this.sessions.get(event.id);
    if (existing !== undefined) {
      return existing;
    }
    const session: Session = { brokerOrderId: event.id, reservationId, filledSize: Decimal.ZERO, filledTotalCost: Decimal.ZERO };
    this.sessions.set(event.id, session);
    return session;
  }

  /**
   * The cash an order needs held against it: what it will cost, in dollars.
   *
   * The multiplier is the whole point. Without it a single contract quoted at 3.85
   * holds $3.85 against a purchase that costs $385, and a hundred of them oversubscribe
   * the account by exactly the factor nobody would notice until the broker refused
   * something.
   */
  private requiredBuyingPower(request: ReservationRequest): Decimal {
    if (request.unitPrice === undefined) {
      return Decimal.ZERO;
    }
    return request.size
      .abs()
      .mul(request.unitPrice)
      .mul(request.multiplier ?? defaultContractMultiplier(request.assetClass));
  }

  /**
   * The one requirement this tracker refuses to guess at, and why it says so rather
   * than holding something plausible.
   *
   * Everything else here is priced: a buy costs what it costs, and a reduction hands
   * back units it already holds. Writing a short option is different in kind — the
   * broker's requirement is margin against a position whose loss is unbounded for a
   * naked call, and a spread's is the width rather than the sum of its legs. Holding
   * the premium instead would be a number that looks like an answer, and the account
   * would be oversubscribed by whatever the real requirement exceeded it by.
   *
   * Refusing is not a limitation to be worked around by omitting the price: an order
   * with no `unitPrice` holds nothing at all and would sail straight through. It is
   * refused on direction and asset class alone. See `md/OPEN-ITEMS.md` item 2b.
   */
  private unreservable(request: ReservationRequest): string | undefined {
    if (request.assetClass === 'equity') {
      return undefined;
    }
    // Reducing hands units back and needs no cash, so only an order that opens or
    // extends a short is refused. Selling contracts already held is a reduction.
    const reducing = hasDifferentSign(request.size, this._positionSize);
    if (request.size.isNegative() && !reducing) {
      return `Cannot reserve ${request.size.toString()} ${this.symbol}: opening a short ${request.assetClass} position requires margin, which this tracker does not model. See md/OPEN-ITEMS.md item 2b.`;
    }
    return undefined;
  }

  /**
   * Gives back whatever the order did not use.
   *
   * A fully filled order leaves nothing; a cancelled one leaves the whole remainder,
   * and that is the case this exists for — without it, a cancelled sell would keep its
   * shares locked forever and the account would slowly become untradable.
   */
  private release(reservation: Reservation): void {
    this.reservations.delete(reservation.reservationId);

    if (!reservation.lockedSize.isZero()) {
      this._freeSize = this._freeSize.sub(reservation.lockedSize);
      reservation.lockedSize = Decimal.ZERO;
    }
    reservation.pendingSize = Decimal.ZERO;
    if (!reservation.reservedBuyingPower.isZero()) {
      this.props.buyingPower.onAvailableBuyingPowerChange(reservation.reservedBuyingPower);
      reservation.reservedBuyingPower = Decimal.ZERO;
    }

    this.props.buyingPower.onReservationComplete(reservation.reservationId);
  }
}
