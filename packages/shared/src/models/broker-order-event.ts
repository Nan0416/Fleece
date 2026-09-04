/**
 * A broker order, normalised away from any one broker's wire format. The injector
 * converts an incoming Alpaca order into one of these before the ledger sees it, so
 * the accounting never learns Alpaca's field names.
 */

export type BrokerOrderStatus =
  | 'held'
  | 'accepted'
  | 'pending_new'
  | 'new'
  | 'partially_filled'
  | 'pending_cancel'
  | 'pending_replace'
  | 'filled'
  | 'canceled'
  | 'done_for_day'
  | 'expired'
  | 'replaced'
  | 'rejected';

export type BrokerOrderType = 'market' | 'limit' | 'stop_limit' | 'stop';
export type BrokerOrderSide = 'buy' | 'sell';
export type BrokerOrderTimeInForce = 'day' | 'gtc' | 'opg' | 'cls' | 'ioc' | 'fok';
export type BrokerOrderClass = 'regular' | 'oco' | 'oto' | 'bracket' | 'mleg';

/**
 * What an order trades. Fleece's own vocabulary rather than any broker's — Alpaca says
 * `us_equity` and `us_option`, and the converter is the one place that becomes this.
 */
export type BrokerAssetClass = 'equity' | 'option' | 'crypto';

/**
 * Whether a leg opens exposure or closes it. Options carry it; equities do not.
 *
 * Nothing accounts from it — direction comes from the signed quantity, so a
 * `buy_to_close` is a positive size exactly as a `buy_to_open` is. It is kept because
 * it is the only field separating closing a short call from opening a long one, which
 * is the difference between two strategies that otherwise read identically.
 */
export type BrokerPositionIntent = 'buy_to_open' | 'buy_to_close' | 'sell_to_open' | 'sell_to_close';

/**
 * A US equity option contract is a claim on 100 shares, and brokers quote its premium
 * per share: a contract reported filled at 3.85 moved $385 of cash.
 *
 * Sizes reach the ledger in units of the underlying deliverable, so that `size * price`
 * is dollars whatever the instrument. Without that, one virtual account holding both
 * stock and options totals a realised profit 100x light on the options side — and
 * nothing about the number looks wrong.
 *
 * Adjusted contracts — the ones a split or a merger rewrites — carry a multiplier of
 * their own that is not 100. Alpaca reports it on the option contract rather than on
 * the order, so honouring it would mean a contract lookup on the fill path; until
 * something here trades one, this constant is the whole rule.
 */
export const OPTION_CONTRACT_MULTIPLIER = 100;

/** How many units of the underlying one unit of `assetClass` delivers. */
export function contractMultiplier(assetClass: BrokerAssetClass): number {
  return assetClass === 'option' ? OPTION_CONTRACT_MULTIPLIER : 1;
}

/**
 * An order is finished when it reaches one of these: no further event will arrive,
 * so any per-order state the injector is holding can be released.
 */
export const TERMINAL_BROKER_ORDER_STATUSES: ReadonlyArray<BrokerOrderStatus> = ['filled', 'canceled', 'expired', 'replaced', 'rejected', 'done_for_day'];

export function isTerminalStatus(status: BrokerOrderStatus): boolean {
  return TERMINAL_BROKER_ORDER_STATUSES.includes(status);
}

interface BaseBrokerOrderEvent {
  /** The broker's order id. */
  readonly id: string;
  /**
   * Set on a leg, naming the composite order it belongs to. Absent on everything else.
   *
   * Events arrive flat — a spread reaches the injector as a parent event and one event
   * per contract, not as a tree — so this is the only thing left tying them together.
   * Each leg still gets its own `broker_order` row, its own fills and its own status,
   * because a leg is a real order at the broker with a real instrument.
   */
  readonly parentBrokerOrderId?: string;
  /** The broker's client-side id, which carries the encoded correlation. */
  readonly correlationId?: string;
  /** The virtual account, when it could be decoded from `correlationId`. */
  readonly accountId?: string;
  readonly groupId?: string;
  readonly reservationId?: string;

  readonly brokerAccountId: string;
  readonly broker: 'alpaca' | 'traderq';
  readonly live: boolean;

  readonly replacedBy?: string;
  readonly replaces?: string;
  readonly status: BrokerOrderStatus;

  /** Empty on a multi-leg parent, which trades no instrument of its own. Its legs do. */
  readonly symbol: string;
  readonly assetClass: BrokerAssetClass;

  readonly timeInForce: BrokerOrderTimeInForce;
  readonly orderClass: BrokerOrderClass;
  readonly orderType: BrokerOrderType;
  /**
   * Absent on a multi-leg parent. A spread has no direction of its own — each leg
   * carries one — and Alpaca is not self-consistent about what it puts here anyway:
   * the REST response says `''` and the websocket says `'buy'` for the same order.
   */
  readonly side?: BrokerOrderSide;
  /** Options only. */
  readonly positionIntent?: BrokerPositionIntent;
  /** A leg's share of its parent's quantity. Multi-leg legs only. */
  readonly ratioQty?: number;
  readonly extendedHours: boolean;

  readonly limitPrice?: number;
  readonly stopPrice?: number;
  /**
   * Signed: negative for a sell. Brokers report an absolute quantity plus a side.
   *
   * Unsigned on a multi-leg parent, where there is no side to take a sign from. The
   * parent's quantity counts spreads, and each leg's counts its own contracts.
   */
  readonly qty: number;
  /** Signed the same way as `qty`; 0 when nothing has filled. */
  readonly filledQty: number;
  /**
   * Unsigned for a single instrument. On a multi-leg parent it is the spread's net
   * price, and its sign is meaningful: positive is a debit paid, negative a credit
   * received.
   */
  readonly filledAvgPrice?: number;

  readonly createdAt: number;
  readonly updatedAt: number;
  readonly filledAt?: number;
  readonly expiredAt?: number;
  readonly canceledAt?: number;
  readonly failedAt?: number;
  readonly replacedAt?: number;
}

export interface MarketBrokerOrderEvent extends BaseBrokerOrderEvent {
  readonly orderType: 'market';
  readonly limitPrice: undefined;
  readonly stopPrice: undefined;
}

export interface LimitBrokerOrderEvent extends BaseBrokerOrderEvent {
  readonly orderType: 'limit';
  /**
   * Absent only on a multi-leg leg, which does not price itself — the spread's net
   * price sits on the parent, and a leg would have nothing truthful to put here.
   *
   * Present on every other limit order, and the converter refuses one that arrives
   * without it. That check is worth keeping: a limit order whose price went missing
   * reserves no buying power, which is how the legacy could oversubscribe an account by
   * exactly the orders it already had working.
   */
  readonly limitPrice?: number;
  readonly stopPrice: undefined;
}

export interface StopBrokerOrderEvent extends BaseBrokerOrderEvent {
  readonly orderType: 'stop';
  readonly limitPrice: undefined;
  readonly stopPrice: number;
}

export interface StopLimitBrokerOrderEvent extends BaseBrokerOrderEvent {
  readonly orderType: 'stop_limit';
  readonly limitPrice: number;
  readonly stopPrice: number;
}

export type BrokerOrderEvent = MarketBrokerOrderEvent | LimitBrokerOrderEvent | StopBrokerOrderEvent | StopLimitBrokerOrderEvent;

export function eventToString(event: BrokerOrderEvent): string {
  // A multi-leg parent has no symbol of its own, and printing the empty string leaves
  // a log line that reads as though the instrument went missing.
  const instrument = event.symbol === '' && event.orderClass === 'mleg' ? 'spread' : event.symbol;
  const parent = event.parentBrokerOrderId === undefined ? '' : ` (leg of ${event.parentBrokerOrderId})`;
  return `${event.status} ${event.orderType} order ${event.id} ${event.filledQty}/${event.qty} ${instrument}${parent}`;
}
