import { Decimal } from '../utils/decimal';
import { AssetClass } from './asset-class';
import { BrokerOrderClass, BrokerOrderSide, BrokerOrderTimeInForce, BrokerOrderType, BrokerPositionIntent } from './order';

/**
 * A broker order, normalised away from any one broker's wire format. The injector
 * converts an incoming Alpaca order into one of these before the ledger sees it, so
 * the accounting never learns Alpaca's field names.
 *
 * Every quantity is a `Decimal`. Brokers report them as strings, and string to decimal
 * is exact where string to double is not — so this is also the point at which the
 * precision would have been lost had it been going to be lost at all.
 */

interface BaseBrokerOrderEvent {
  /** The broker's order id. */
  readonly id: string;
  /**
   * Set on a leg, naming the composite order it belongs to. Absent on everything else.
   *
   * Events arrive flat — a spread reaches the injector as one event per contract, not as
   * a tree — so this is the only thing left tying them together. Each leg still gets its
   * own `broker_order` row, its own fills and its own status, because a leg is a real
   * order at the broker with a real instrument.
   */
  readonly parentBrokerOrderId?: string;
  /** The broker's client-side id, which carries the encoded correlation. */
  readonly correlationId?: string;
  /** The virtual account, when it could be decoded from `correlationId`. */
  readonly accountId?: string;
  /**
   * The placing process's own bookkeeping id, decoded and passed through.
   *
   * The ledger has no use for it — it is how `@fleece/broker` finds the reservation an
   * event belongs to, which is the only identifier that exists before the order does and
   * therefore the only one that covers the window between reserving and being told the
   * broker's id.
   */
  readonly reservationId?: string;

  readonly brokerAccountId: string;
  readonly broker: 'alpaca' | 'traderq';
  readonly live: boolean;

  readonly replacedBy?: string;
  readonly replaces?: string;
  readonly status: string;

  /**
   * Absent on a composite parent, which trades no instrument of its own.
   *
   * `undefined` rather than the empty string Alpaca sends. The sentinel is converted
   * away at this boundary and nowhere else, because a position keyed on `''` is a wrong
   * number that looks like a right one — and an optional field makes the compiler raise
   * the parent case at every reader instead of each of them having to remember it.
   */
  readonly symbol?: string;
  readonly assetClass: AssetClass;
  /**
   * Units of the underlying per contract, when the broker has told us.
   *
   * Absent means "assume the default for the asset class". Alpaca reports the real
   * figure on the option contract rather than on the order, so honouring an adjusted
   * contract means a lookup the fill path does not do today; the field exists so that
   * adding it later does not change this shape.
   */
  readonly multiplier?: Decimal;

  readonly timeInForce: BrokerOrderTimeInForce;
  readonly orderClass: BrokerOrderClass;
  readonly orderType: BrokerOrderType;
  /**
   * Absent on a composite parent. A spread has no direction of its own — each leg
   * carries one — and Alpaca is not self-consistent about what it puts here anyway:
   * the REST response says `''` and the websocket says `'buy'` for the same order.
   */
  readonly side?: BrokerOrderSide;
  /** Options only. */
  readonly positionIntent?: BrokerPositionIntent;
  /** A leg's share of its parent's quantity. Multi-leg legs only. */
  readonly ratioQty?: Decimal;
  readonly extendedHours: boolean;

  readonly limitPrice?: Decimal;
  readonly stopPrice?: Decimal;
  /** Signed: negative for a sell. Brokers report an absolute quantity plus a side. Counts contracts for an option. */
  readonly qty: Decimal;
  /** Signed the same way as `qty`; 0 when nothing has filled. */
  readonly filledQty: Decimal;
  /**
   * The broker's own average fill price: a **premium per share** for an option, not a
   * cost per contract. Turning it into dollars is `filledQty * filledAvgPrice *
   * multiplier`, and the injector is where that happens.
   */
  readonly filledAvgPrice?: Decimal;

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
  readonly limitPrice?: Decimal;
  readonly stopPrice: undefined;
}

export interface StopBrokerOrderEvent extends BaseBrokerOrderEvent {
  readonly orderType: 'stop';
  readonly limitPrice: undefined;
  readonly stopPrice: Decimal;
}

export interface StopLimitBrokerOrderEvent extends BaseBrokerOrderEvent {
  readonly orderType: 'stop_limit';
  readonly limitPrice: Decimal;
  readonly stopPrice: Decimal;
}

export type BrokerOrderEvent = MarketBrokerOrderEvent | LimitBrokerOrderEvent | StopBrokerOrderEvent | StopLimitBrokerOrderEvent;

export function eventToString(event: BrokerOrderEvent): string {
  // A composite parent trades no instrument, and printing nothing leaves a log line
  // that reads as though the symbol went missing.
  const instrument = event.symbol ?? 'spread';
  const parent = event.parentBrokerOrderId === undefined ? '' : ` (leg of ${event.parentBrokerOrderId})`;
  return `${event.status} ${event.orderType} order ${event.id} ${event.filledQty.toString()}/${event.qty.toString()} ${instrument}${parent}`;
}
