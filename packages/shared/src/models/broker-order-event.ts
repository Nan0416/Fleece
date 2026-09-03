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
export type BrokerOrderClass = 'regular' | 'oco' | 'oto' | 'bracket';

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

  readonly symbol: string;

  readonly timeInForce: BrokerOrderTimeInForce;
  readonly orderClass: BrokerOrderClass;
  readonly orderType: BrokerOrderType;
  readonly side: BrokerOrderSide;
  readonly extendedHours: boolean;

  readonly limitPrice?: number;
  readonly stopPrice?: number;
  /** Signed: negative for a sell. Brokers report an absolute quantity plus a side. */
  readonly qty: number;
  /** Signed the same way as `qty`; 0 when nothing has filled. */
  readonly filledQty: number;
  readonly filledAvgPrice?: number;

  readonly createdAt: number;
  readonly updatedAt: number;
  readonly filledAt?: number;
  readonly expiredAt?: number;
  readonly canceledAt?: number;
  readonly failedAt?: number;
  readonly replacedAt?: number;
  readonly legs?: ReadonlyArray<BrokerOrderEvent>;
}

export interface MarketBrokerOrderEvent extends BaseBrokerOrderEvent {
  readonly orderType: 'market';
  readonly limitPrice: undefined;
  readonly stopPrice: undefined;
}

export interface LimitBrokerOrderEvent extends BaseBrokerOrderEvent {
  readonly orderType: 'limit';
  readonly limitPrice: number;
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
  return `${event.status} ${event.orderType} order ${event.id} ${event.filledQty}/${event.qty} ${event.symbol}`;
}
