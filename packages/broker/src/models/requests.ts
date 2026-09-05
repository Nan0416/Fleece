import { AssetClass, BrokerOrderEvent, Decimal } from '@fleece/shared';
import { OrderObj } from './order-obj';

/** Called for every event the broker reports about the order this handler was attached to. */
export type OrderEventHandler = (event: BrokerOrderEvent, orderObj: OrderObj) => Promise<void>;

interface BaseOrderRequest {
  readonly symbol: string;
  /**
   * Positive buys, negative sells. Signed throughout, as everywhere else in Fleece, and
   * a `Decimal` because a fractional share is a real quantity Alpaca accepts.
   *
   * Contracts, not shares, for an option: the size counts what a position would hold,
   * and the contract multiplier turns it into dollars.
   */
  readonly size: Decimal;
  /** The virtual account this order trades for. */
  readonly accountId: string;
  /**
   * What the instrument is. Stated rather than inferred from the symbol, because it
   * decides how much money is held against the order — an option's premium is quoted
   * per share and a contract is a claim on a hundred of them.
   */
  readonly assetClass: AssetClass;
  /** Units of the underlying per contract, for an adjusted contract. Defaults by asset class. */
  readonly multiplier?: Decimal;
  readonly onEvent: OrderEventHandler;
}

export interface MarketOrderRequest extends BaseOrderRequest {
  readonly type: 'market';
  /**
   * An estimate, per share, used only to reserve buying power. Without it a buy reserves
   * nothing and can oversubscribe the account — so supply it whenever a price is known.
   */
  readonly unitPrice?: Decimal;
}

export interface LimitOrderRequest extends BaseOrderRequest {
  readonly type: 'limit';
  readonly limitPrice: Decimal;
}

/**
 * One-triggers-other: an entry order that, once filled, releases a take-profit order.
 * The broker creates the second leg itself, which is why leg attribution needs the
 * tracking request rather than the correlation.
 */
export interface OtoRequest extends BaseOrderRequest {
  readonly type: 'oto';
  readonly limitPrice: Decimal;
  readonly takeProfitLimitPrice: Decimal;
  readonly onTakeProfitEvent: OrderEventHandler;
}

export type OrderRequest = MarketOrderRequest | LimitOrderRequest | OtoRequest;
