import { AlpacaOrder, AlpacaPositionIntent, CreateMultiLegOrderLeg } from '@fleece/alpaca';

/**
 * **L1: placing an order that says whose it is.**
 *
 * One layer above `@fleece/alpaca`, and only one thing wider than it. Every input here
 * is the broker's own — an unsigned size and a `side`, prices as numbers, `symbol` an
 * OCC contract or a ticker — with the one field we control swapped: instead of handing
 * over a `client_order_id`, the caller names the **virtual account**, and the correlation
 * codec turns that into the id. Nothing else about the order changes on the way through.
 *
 * That swap is the layer's entire reason to exist. Alpaca echoes `client_order_id` back
 * on every event about an order, so it is the only place an order can carry a statement
 * about itself that survives a restart, a websocket drop and a REST backfill. An order
 * placed without one is an order the injector cannot attribute, and it lands in the
 * catch-all account — which is why `accountId` is required rather than optional.
 *
 * **`reservationId` is an input, not a decision.** Nothing at this layer takes a hold or
 * knows what one would cost; it encodes whatever it is given so the placing process can
 * recognise its own order in an event that arrives before the placement response does.
 * Omitting it is a supported case, not a degraded one — it is what lets an order be
 * placed for an instrument whose requirement nothing here can price. See
 * `md/OPEN-ITEMS.md` item 2b.
 *
 * **The names mirror L0's on purpose.** `createLimitOrder` here takes the same fields as
 * `AlpacaRestClient.createLimitOrder`, minus `clientOrderId` and plus `accountId`, so the
 * one-to-one-ness is visible at the call site rather than asserted in a comment. The
 * input types share their names too: within this package `CreateLimitOrderInput` is this
 * one, and the broker's own is reached through `@fleece/alpaca`.
 *
 * `L2BrokerOrderClient` (L2) implements this same interface, which is what makes
 * telling the tracking service a layer you can leave out rather than a step inside one.
 */
export interface BrokerOrderClient {
  createMarketOrder(input: CreateMarketOrderInput): Promise<CreatedOrder>;
  createLimitOrder(input: CreateLimitOrderInput): Promise<CreatedOrder>;
  createOtoOrder(input: CreateOtoOrderInput): Promise<CreatedOrder>;
  /** A spread, placed as one order so that its legs fill together or not at all. */
  createMultiLegOrder(input: CreateMultiLegOrderInput): Promise<CreatedOrder>;
  /** Takes the **broker's** id. A leg of a spread cannot be cancelled alone. */
  cancelOrder(brokerOrderId: string): Promise<void>;
}

/** The identity every placement carries, in place of a raw client order id. */
export interface CorrelatedOrderInput {
  /** The virtual account this order trades for. */
  readonly accountId: string;
  /**
   * The placing process's own bookkeeping id, when it took a hold.
   *
   * It is the only identifier that exists *before* the order does, and so the only one
   * covering the window between reserving and being told the broker's id — a window
   * Alpaca can and does deliver events in.
   */
  readonly reservationId?: string;
}

interface BaseCreateOrderInput extends CorrelatedOrderInput {
  readonly symbol: string;
  /** Always positive; the direction is `side`, which is Alpaca's own convention. */
  readonly size: number;
  readonly side: 'buy' | 'sell';
  /** Options only. Send it when known: inference cannot tell a closing sell from an opening short. */
  readonly positionIntent?: AlpacaPositionIntent;
  readonly timeInForce?: 'day' | 'gtc';
}

export interface CreateMarketOrderInput extends BaseCreateOrderInput {}

export interface CreateLimitOrderInput extends BaseCreateOrderInput {
  readonly limitPrice: number;
}

export interface CreateOtoOrderInput extends BaseCreateOrderInput {
  readonly limitPrice: number;
  readonly takeProfitLimitPrice: number;
}

export interface CreateMultiLegOrderInput extends CorrelatedOrderInput {
  /** How many spreads. Always positive: direction lives on each leg. */
  readonly size: number;
  /** Two to four contracts. */
  readonly legs: ReadonlyArray<CreateMultiLegOrderLeg>;
  /**
   * The whole spread's net price, and the one price here that is **signed**: positive is
   * a debit you are willing to pay, negative a credit you require. Omit for a market
   * order — and think twice before doing so, since a spread has no NBBO to protect it.
   */
  readonly netLimitPrice?: number;
  readonly timeInForce?: 'day' | 'gtc';
}

/** What a placement produced, and the identity it went out carrying. */
export interface CreatedOrder {
  /** Alpaca's own response, unchanged. A composite order carries its legs nested in it. */
  readonly order: AlpacaOrder;
  /** The encoded correlation, returned so a caller can prove what went out. */
  readonly clientOrderId: string;
}
