import { AssetClass, BrokerOrderEvent, Decimal } from '@fleece/shared';

/**
 * Reservations: the accounting that keeps concurrent strategies from oversubscribing
 * one real broker account.
 *
 * Many strategies place orders through a single Alpaca account. Without a hold taken
 * before an order goes out, each of them reads the same available buying power, each
 * concludes it can afford its order, and the account is oversold. A reservation is a
 * two-phase claim: `reserve` before the request is sent, then either the fill consumes
 * it or `cancel` releases it.
 *
 * Two different scarce resources are being protected, and which one depends on
 * direction. Reducing a position reserves **shares** — you cannot sell the same 100
 * twice. Increasing one reserves **buying power** — you cannot spend the same $10,000
 * twice.
 *
 * **Everything here counts in ledger units and accounts in total cost**, the same way
 * the ledger does: a size is contracts for an option, and the dollars behind it are the
 * premium already multiplied out. That is what lets one account hold stock and options
 * and still have one buying-power figure that means something.
 */

/** An order already working at the broker when the tracker started up. */
export interface PendingOrder {
  readonly brokerOrderId: string;
  readonly unfilledSize: Decimal;
  readonly partialFilledSize: Decimal;
  /** Dollars, not a premium: already multiplied by `multiplier`. */
  readonly partialTotalCost: Decimal;
  /** Per share, as the broker quotes it — a premium for an option. */
  readonly limitPrice?: Decimal;
  /** Units of the underlying per contract; 1 for an equity. */
  readonly multiplier: Decimal;
}

/** A holding as the broker reports it, used to seed a tracker at startup. */
export interface BrokerPosition {
  readonly symbol: string;
  readonly positionSize: Decimal;
  /** Dollars behind the position, signed the same way as `positionSize`. */
  readonly totalCost: Decimal;
  readonly pendingOrders: ReadonlyArray<PendingOrder>;
}

export interface RealisedProfit {
  readonly profit: Decimal;
  /** Contracts for an option, shares for an equity. Signed as the fill was. */
  readonly size: Decimal;
  readonly timestamp: number;
}

export interface ReservationRequest {
  readonly symbol: string;
  /** Positive buys, negative sells. */
  readonly size: Decimal;
  /**
   * What the instrument is. Required rather than inferred from the symbol, because the
   * hold depends on it: an option's requirement is its premium times the contract
   * multiplier, and a short option's is margin this tracker cannot compute at all.
   */
  readonly assetClass: AssetClass;
  /**
   * Per share, as the broker quotes it — a **premium** for an option, not what the
   * contract costs. Needed to reserve buying power on a buy; a buy without one reserves
   * nothing.
   */
  readonly unitPrice?: Decimal;
  /** Overrides the asset class default, for an adjusted contract. */
  readonly multiplier?: Decimal;
}

/** What the position would become. `undefined` from `test` means "not possible". */
export interface TestResult {
  readonly originalSize: Decimal;
  readonly newSize: Decimal;
}

/**
 * One symbol's holding in one broker account, and the orders in flight against it.
 *
 * A reservation reaches a tracker by one of three routes, and only the first is the
 * happy path:
 *
 * 1. The caller reserved before placing, and the reservation id was encoded into the
 *    order's `client_order_id` — so an incoming event carries it back.
 * 2. The order was already open at the broker when the tracker started. A reservation
 *    is synthesised at setup, keyed by the broker order id.
 * 3. An event arrives with no reservation at all — a leg order, or one placed by hand
 *    on the broker's website. A reservation is synthesised on the spot, again keyed by
 *    the broker order id.
 */
export interface PositionTracker {
  readonly symbol: string;
  /** Dollars behind the position, signed the same way as `positionSize`; 0 when flat. */
  readonly totalCost: Decimal;
  /** Cost basis per unit, derived for display. 0 when flat. */
  readonly unitCost: Decimal;
  /** Everything held, including units committed to unfilled orders. */
  readonly positionSize: Decimal;
  /**
   * What is free to trade. Always the same sign as `positionSize` and never larger in
   * magnitude: shares promised to an unfilled sell are not free to sell again.
   */
  readonly freeSize: Decimal;
  readonly profits: ReadonlyArray<RealisedProfit>;

  /** Would this order be possible? `undefined` if not. Takes no hold. */
  test(request: ReservationRequest): TestResult | undefined;
  /** Takes the hold and returns its id. Throws `NotReservableError` if it cannot. */
  reserve(request: ReservationRequest): string;
  /** Releases a hold whose order never reached the broker. */
  cancel(reservationId: string): void;
  /** Applies a broker event, consuming the reservation it belongs to. */
  track(event: BrokerOrderEvent): void;
}

/**
 * One broker account: its buying power, and a `PositionTracker` per symbol.
 *
 * Buying power is account-wide, which is why it lives here rather than being summed
 * from the per-symbol trackers — a buy in one symbol reduces what is available for
 * every other.
 */
export interface BrokerTracker {
  readonly availableBuyingPower: Decimal;

  /** Seeds from the broker's own view of the account. Once only. */
  setup(buyingPower: Decimal, positions: ReadonlyArray<BrokerPosition>): void;

  test(request: ReservationRequest): TestResult | undefined;
  reserve(request: ReservationRequest): string;
  cancel(reservationId: string): void;
  track(event: BrokerOrderEvent): void;
}
