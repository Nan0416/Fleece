import { AlpacaAccount, AlpacaAsset, AlpacaOptionContract, AlpacaOrder, AlpacaPosition, AlpacaPositionIntent } from './models';

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

export interface GetOptionContractInput {
  /** The OCC symbol, e.g. `AMZN261016C00280000`, or the contract's id. */
  readonly symbolOrId: string;
}

export interface GetOptionContractOutput {
  /** Null when Alpaca has no such contract, the same way `getAsset` reports one it lacks. */
  readonly contract: AlpacaOptionContract | null;
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
  /**
   * Options only, and optional there: Alpaca infers it from the position when it is
   * absent. Send it when the caller knows — inference cannot tell a sell that closes a
   * long call from one that opens a short, and the two have very different margin.
   */
  readonly positionIntent?: AlpacaPositionIntent;
  /**
   * Defaults to `day`. Options accept `day` and `gtc` only, so the wider set an
   * equity order can use is not offered here.
   */
  readonly timeInForce?: 'day' | 'gtc';
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

/** One contract of a spread. */
export interface CreateMultiLegOrderLeg {
  /** The OCC contract symbol. */
  readonly symbol: string;
  /**
   * This leg's contracts per spread, so `size` spreads trade `ratioQty * size` of it.
   * A vertical is 1 and 1; a ratio spread is 1 and 2.
   *
   * Alpaca requires the greatest common divisor across the legs to be 1 — 2 and 4 is
   * rejected, and the same spread written as 1 and 2 is accepted.
   */
  readonly ratioQty: number;
  readonly side: 'buy' | 'sell';
  readonly positionIntent: AlpacaPositionIntent;
}

interface BaseCreateMultiLegOrderInput {
  /** How many spreads. Always positive: direction lives on each leg. */
  readonly size: number;
  /** Two to four legs. */
  readonly legs: ReadonlyArray<CreateMultiLegOrderLeg>;
  /** Defaults to `day`. */
  readonly timeInForce?: 'day' | 'gtc';
  /**
   * Only the parent gets one. Alpaca assigns each leg a client order id of its own, so
   * a leg cannot carry a correlation — but unlike a bracket's legs, an mleg's arrive
   * nested inside the parent on every event, and so inherit its correlation.
   */
  readonly clientOrderId?: string;
}

export interface CreateMultiLegMarketOrderInput extends BaseCreateMultiLegOrderInput {
  readonly type: 'market';
}

export interface CreateMultiLegLimitOrderInput extends BaseCreateMultiLegOrderInput {
  readonly type: 'limit';
  /**
   * The whole spread's net price, and the one price in this API that is signed:
   * positive is a debit you are willing to pay, negative a credit you require.
   *
   * Getting the sign wrong does not fail — it places a real order at a price nobody
   * would take, or worse, one far better for the other side than you meant.
   */
  readonly netLimitPrice: number;
}

export type CreateMultiLegOrderInput = CreateMultiLegMarketOrderInput | CreateMultiLegLimitOrderInput;

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
  getOptionContract(input: GetOptionContractInput): Promise<GetOptionContractOutput>;

  createMarketOrder(input: CreateMarketOrderInput): Promise<CreateOrderOutput>;
  createLimitOrder(input: CreateLimitOrderInput): Promise<CreateOrderOutput>;
  createOtoOrder(input: CreateOtoOrderInput): Promise<CreateOrderOutput>;
  /** A spread, placed as one order so that its legs fill together or not at all. */
  createMultiLegOrder(input: CreateMultiLegOrderInput): Promise<CreateOrderOutput>;
  cancelOrder(input: CancelOrderInput): Promise<CancelOrderOutput>;
}
