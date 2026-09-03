import { BrokerOrderEvent } from '@fleece/shared';
import { OrderObj } from './order-obj';

/** Called for every event the broker reports about the order this handler was attached to. */
export type OrderEventHandler = (event: BrokerOrderEvent, orderObj: OrderObj) => Promise<void>;

interface BaseOrderRequest {
  readonly symbol: string;
  /** Positive buys, negative sells. Signed throughout, as everywhere else in Fleece. */
  readonly size: number;
  /** The virtual account this order trades for. */
  readonly accountId: string;
  /** Omit for an order deliberately belonging to no group. */
  readonly groupId?: string;
  readonly onEvent: OrderEventHandler;
}

export interface MarketOrderRequest extends BaseOrderRequest {
  readonly type: 'market';
  /**
   * An estimate, used only to reserve buying power. Without it a buy reserves nothing
   * and can oversubscribe the account — so supply it whenever a price is known.
   */
  readonly unitPrice?: number;
}

export interface LimitOrderRequest extends BaseOrderRequest {
  readonly type: 'limit';
  readonly limitPrice: number;
}

/**
 * One-triggers-other: an entry order that, once filled, releases a take-profit order.
 * The broker creates the second leg itself, which is why leg attribution needs the
 * tracking request rather than the correlation.
 */
export interface OtoRequest extends BaseOrderRequest {
  readonly type: 'oto';
  readonly limitPrice: number;
  readonly takeProfitLimitPrice: number;
  readonly onTakeProfitEvent: OrderEventHandler;
}

export type OrderRequest = MarketOrderRequest | LimitOrderRequest | OtoRequest;
