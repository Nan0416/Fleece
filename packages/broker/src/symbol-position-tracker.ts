import { BrokerOrderEvent, isTerminalStatus, LoggerFactory, reconcilePosition, roundPrice } from '@fleece/shared';
import { nanoid } from 'nanoid';
import { BuyingPowerLedger } from './buying-power';
import { NotReservableError } from './models/errors';
import { PendingOrder, PositionTracker, RealisedProfit, ReservationRequest, TestResult } from './models/trackers';
import { allSameSign, hasDifferentSign, nearerZero } from './utils';

const logger = LoggerFactory.getLogger('SymbolPositionTracker');

/**
 * A hold taken before an order is sent, released when it fills or is cancelled.
 *
 * Exactly one of `lockedSize` and `reservedBuyingPower` is non-zero, decided by
 * direction: reducing a position holds shares, increasing one holds cash.
 */
interface Reservation {
  readonly reservationId: string;
  /**
   * Shares committed to an unfilled order that reduces the position, signed the same
   * way as the order. Long 20 with an open sell of 5 gives `lockedSize` of -5, and a
   * free size of 15 — those 5 cannot be sold twice.
   */
  lockedSize: number;
  /** Still to fill. Falls towards zero as fills arrive. */
  pendingSize: number;
  /** Cash held for an unfilled order that increases the position. Always positive. */
  reservedBuyingPower: number;
}

/** What has already been applied for one broker order, so a repeat applies nothing. */
interface Session {
  readonly brokerOrderId: string;
  readonly reservationId: string;
  filledSize: number;
  filledTotalCost: number;
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

  private _positionSize = 0;
  private _freeSize = 0;
  private _unitCost = 0;
  private initialised = false;

  constructor(private readonly props: SymbolPositionTrackerProps) {
    this.symbol = props.symbol;
    this.now = props.now ?? Date.now;
  }

  get positionSize(): number {
    return this._positionSize;
  }

  get freeSize(): number {
    return this._freeSize;
  }

  get unitCost(): number {
    return this._unitCost;
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
    const result: TestResult = { originalSize: this._positionSize, newSize: this._positionSize + request.size };
    const requiredBuyingPower = typeof request.unitPrice === 'number' ? Math.abs(request.size) * request.unitPrice : 0;
    const affordable = requiredBuyingPower <= this.props.buyingPower.availableBuyingPower;

    if (this._positionSize === 0) {
      const unfilled = [...this.reservations.values()].map((reservation) => reservation.pendingSize);
      if (!allSameSign(unfilled)) {
        // Provably impossible: while the position is non-zero the largest opposing
        // order allowed is the position itself, so by the time it reaches zero only
        // one direction can be outstanding.
        logger.error(`${this.symbol} has unfilled orders in both directions while flat.`);
      }
      const totalUnfilled = unfilled.reduce((sum, size) => sum + size, 0);
      const agrees = totalUnfilled === 0 || (totalUnfilled > 0 && request.size > 0) || (totalUnfilled < 0 && request.size < 0);
      return agrees && affordable ? result : undefined;
    }

    if (this._positionSize > 0) {
      if (request.size > 0) {
        return affordable ? result : undefined;
      }
      // Reducing: bounded by what is free, not by what is held.
      return request.size + this._freeSize >= 0 ? result : undefined;
    }

    if (request.size < 0) {
      return affordable ? result : undefined;
    }
    return request.size + this._freeSize <= 0 ? result : undefined;
  }

  reserve(request: ReservationRequest): string {
    if (this.test(request) === undefined) {
      throw new NotReservableError(
        `Cannot reserve ${request.size} ${this.symbol}: the account has ${this._freeSize} free shares and ${this.props.buyingPower.availableBuyingPower} buying power.`,
      );
    }

    const reservationId = nanoid();
    // `hasDifferentSign` returns false against a flat position, so opening always takes
    // the buying-power branch.
    const reducing = hasDifferentSign(request.size, this._positionSize);

    if (reducing) {
      this._freeSize += request.size;
      this.reservations.set(reservationId, { reservationId, lockedSize: request.size, pendingSize: request.size, reservedBuyingPower: 0 });
      logger.info(`Reserved ${Math.abs(request.size)} ${this.symbol} shares (${reservationId}); ${this._freeSize} now free.`);
    } else {
      // No unit price means no hold. That is a real gap rather than a decision — a
      // market buy with no estimate can oversubscribe the account — so the caller is
      // told rather than left to find out from the broker.
      const reserved = typeof request.unitPrice === 'number' ? roundPrice(Math.abs(request.size) * request.unitPrice) : 0;
      if (reserved === 0) {
        logger.warn(`Reserving no buying power for ${request.size} ${this.symbol}: no unit price was supplied, so nothing is held against a concurrent order.`);
      }
      this.props.buyingPower.onAvailableBuyingPowerChange(-reserved);
      this.reservations.set(reservationId, { reservationId, lockedSize: 0, pendingSize: request.size, reservedBuyingPower: reserved });
      logger.info(`Reserved ${reserved} buying power for ${request.size} ${this.symbol} (${reservationId}).`);
    }

    return reservationId;
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
  setup(positionSize: number, unitCost: number, pendingOrders: ReadonlyArray<PendingOrder> = []): void {
    if (this.initialised) {
      throw new Error(`The ${this.symbol} position tracker is already set up.`);
    }
    this.initialised = true;

    this._positionSize = positionSize;
    this._unitCost = unitCost;
    // Everything starts free, then each open order takes back what it has committed.
    this._freeSize = positionSize;

    for (const pendingOrder of pendingOrders) {
      this.adoptPendingOrder(pendingOrder);
    }

    logger.info(`${this.symbol}: ${this._positionSize} held, ${this._freeSize} free, cost basis ${this._unitCost}, ${pendingOrders.length} order(s) already open.`);
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
      reservation = this.adoptPendingOrder({
        brokerOrderId: event.id,
        limitPrice: event.limitPrice,
        unfilledSize: event.qty - event.filledQty,
        partialFilledSize: event.filledQty,
        partialTotalCost: typeof event.filledAvgPrice === 'number' ? roundPrice(event.filledQty * event.filledAvgPrice) : 0,
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
   */
  private apply(event: BrokerOrderEvent, session: Session, reservation: Reservation): void {
    if (Math.abs(event.filledQty) > Math.abs(session.filledSize) && typeof event.filledAvgPrice === 'number') {
      const filledTotalCost = roundPrice(event.filledQty * event.filledAvgPrice);
      const newSize = event.filledQty - session.filledSize;
      const newCost = roundPrice(filledTotalCost - session.filledTotalCost);

      this.reconcile(newSize, roundPrice(newCost / newSize), reservation);

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
  private reconcile(filledSize: number, avgPrice: number, reservation: Reservation): void {
    const reducing = hasDifferentSign(filledSize, this._positionSize);

    const result = reconcilePosition({
      positionSize: this._positionSize,
      positionUnitCost: this._unitCost,
      transactionSize: filledSize,
      transactionUnitCost: avgPrice,
    });

    if (typeof result.transactionProfit === 'number') {
      this.profitLog.push({ profit: result.transactionProfit, shares: filledSize, timestamp: this.now() });
    }
    this._unitCost = result.positionUnitCost;
    this._positionSize = result.positionSize;

    this.settleBuyingPower(result.buyingPowerDelta, reducing, reservation);
    this.settleShares(filledSize, reducing, reservation);
    reservation.pendingSize -= filledSize;
  }

  /**
   * A buy draws on what it reserved before touching the account.
   *
   * Reserving 1700 and filling 4 shares at 168 consumes 672 of the reservation, not of
   * the account — the account already gave that 1700 up at reservation time. Only what
   * the reservation cannot cover reaches the account balance.
   */
  private settleBuyingPower(buyingPowerDelta: number, reducing: boolean, reservation: Reservation): void {
    let delta = buyingPowerDelta;
    if (reservation.reservedBuyingPower > 0 && !reducing) {
      const fromReservation = Math.min(reservation.reservedBuyingPower, Math.abs(delta));
      reservation.reservedBuyingPower = roundPrice(reservation.reservedBuyingPower - fromReservation);
      delta = roundPrice(delta + fromReservation);
    }
    this.props.buyingPower.onAvailableBuyingPowerChange(delta);
  }

  /**
   * A sell consumes the shares it locked before touching the free size.
   *
   * Long 10 with a reserved sell of 5, and 3 fill: the 3 come out of the reservation's
   * locked 5, leaving 2 locked and the free size unchanged. The shares were already
   * spoken for.
   */
  private settleShares(filledSize: number, reducing: boolean, reservation: Reservation): void {
    if (!reducing) {
      this._freeSize += filledSize;
      return;
    }
    const fromLocked = nearerZero(reservation.lockedSize, filledSize);
    reservation.lockedSize -= fromLocked;
    this._freeSize += filledSize - fromLocked;
  }

  /**
   * Takes on an order that already exists at the broker, keyed by its broker order id.
   *
   * The session starts at whatever the order has *already* filled, and that is the
   * important part: those shares are assumed to be in the position the broker reported
   * at setup, so applying them again would count them twice. Only fills after this
   * point move the position.
   *
   * The assumption holds for the case this exists for — an order already open when the
   * process started. It is wrong in one corner: an order placed after setup whose early
   * events were all missed, where the first event seen already shows fills. Those
   * shares are then never applied. Preserved from the legacy deliberately, because
   * double-counting a fill is the worse of the two errors and the REST backfill exists
   * to keep the corner from arising.
   */
  private adoptPendingOrder(pendingOrder: PendingOrder): Reservation {
    const freeAfter = this._freeSize + pendingOrder.unfilledSize;
    const reducing = Math.abs(freeAfter) < Math.abs(this._freeSize);

    const reservation: Reservation = reducing
      ? { reservationId: pendingOrder.brokerOrderId, lockedSize: pendingOrder.unfilledSize, pendingSize: pendingOrder.unfilledSize, reservedBuyingPower: 0 }
      : {
          reservationId: pendingOrder.brokerOrderId,
          lockedSize: 0,
          pendingSize: pendingOrder.unfilledSize,
          // A market order already open has no limit price, so nothing can be held for it.
          reservedBuyingPower: typeof pendingOrder.limitPrice === 'number' ? roundPrice(pendingOrder.limitPrice * Math.abs(pendingOrder.unfilledSize)) : 0,
        };

    if (reducing) {
      this._freeSize = freeAfter;
    } else {
      this.props.buyingPower.onAvailableBuyingPowerChange(-reservation.reservedBuyingPower);
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
    const session: Session = { brokerOrderId: event.id, reservationId, filledSize: 0, filledTotalCost: 0 };
    this.sessions.set(event.id, session);
    return session;
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

    if (reservation.lockedSize !== 0) {
      this._freeSize -= reservation.lockedSize;
      reservation.lockedSize = 0;
    }
    reservation.pendingSize = 0;
    if (reservation.reservedBuyingPower !== 0) {
      this.props.buyingPower.onAvailableBuyingPowerChange(reservation.reservedBuyingPower);
      reservation.reservedBuyingPower = 0;
    }

    this.props.buyingPower.onReservationComplete(reservation.reservationId);
  }
}
