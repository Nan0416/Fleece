import { AlpacaAccount, AlpacaAsset, AlpacaOrder, AlpacaPosition } from './models';

export interface GetOrderInput {
  readonly brokerOrderId: string;
}

export interface GetOrderOutput {
  /** Null when Alpaca does not know the order, which the caller treats as a fault. */
  readonly order: AlpacaOrder | null;
}

export interface ListOrdersInput {
  readonly status?: 'open' | 'closed' | 'all';
  readonly limit?: number;
  /** ISO timestamp; orders submitted after it. */
  readonly after?: string;
  readonly direction?: 'asc' | 'desc';
  readonly nested?: boolean;
}

export interface ListOrdersOutput {
  readonly orders: ReadonlyArray<AlpacaOrder>;
}

export interface GetAccountInput {}

export interface GetAccountOutput {
  readonly account: AlpacaAccount;
}

export interface ListPositionsInput {}

export interface ListPositionsOutput {
  readonly positions: ReadonlyArray<AlpacaPosition>;
}

export interface GetAssetInput {
  readonly symbol: string;
}

export interface GetAssetOutput {
  readonly asset: AlpacaAsset | null;
}

interface BaseCreateOrderInput {
  readonly symbol: string;
  /** Always positive; the direction is `side`, which is Alpaca's own convention. */
  readonly size: number;
  readonly side: 'buy' | 'sell';
  /**
   * Alpaca's `client_order_id`, carrying the encoded correlation. At most 128
   * characters, and it must be unique per order.
   *
   * Only the primary order gets one: Alpaca assigns its own to every leg it creates,
   * which is why a leg cannot be attributed from its correlation and needs a tracking
   * request instead.
   */
  readonly clientOrderId?: string;
}

export interface CreateMarketOrderInput extends BaseCreateOrderInput {}

export interface CreateLimitOrderInput extends BaseCreateOrderInput {
  readonly limitPrice: number;
}

/** One-triggers-other: a limit entry that releases a take-profit once filled. */
export interface CreateOtoOrderInput extends BaseCreateOrderInput {
  readonly limitPrice: number;
  readonly takeProfitLimitPrice: number;
}

export interface CreateOrderOutput {
  readonly order: AlpacaOrder;
}

export interface CancelOrderInput {
  readonly brokerOrderId: string;
}

export interface CancelOrderOutput {}

/**
 * Alpaca's trading API, as much of it as Fleece uses.
 *
 * The read half serves the injector, which backfills events the stream dropped. The
 * write half serves `@fleece/broker`, which places orders. Both live here because they
 * share one credential, one rate limit and one base URL — splitting them would mean two
 * clients competing for the same quota without knowing about each other.
 *
 * Market data is not here: quotes, bars and trades come from `@fleece/marketdata`.
 */
export interface AlpacaRestClient {
  getOrder(input: GetOrderInput): Promise<GetOrderOutput>;
  listOrders(input: ListOrdersInput): Promise<ListOrdersOutput>;
  getAccount(input?: GetAccountInput): Promise<GetAccountOutput>;
  listPositions(input?: ListPositionsInput): Promise<ListPositionsOutput>;
  getAsset(input: GetAssetInput): Promise<GetAssetOutput>;

  createMarketOrder(input: CreateMarketOrderInput): Promise<CreateOrderOutput>;
  createLimitOrder(input: CreateLimitOrderInput): Promise<CreateOrderOutput>;
  createOtoOrder(input: CreateOtoOrderInput): Promise<CreateOrderOutput>;
  cancelOrder(input: CancelOrderInput): Promise<CancelOrderOutput>;
}
