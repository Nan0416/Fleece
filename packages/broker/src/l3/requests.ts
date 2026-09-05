import { AssetClass, BrokerOrderEvent, BrokerOrderSide, BrokerPositionIntent, Decimal } from '@fleece/shared';
import { MultiLegOrderObj, SingleOrderObj } from './order-obj';

/** Called for every event the broker reports about the order this handler was attached to. */
export type SingleOrderEventHandler = (event: BrokerOrderEvent, orderObj: SingleOrderObj) => Promise<void>;

/**
 * Called once per payload the broker sends about a spread, with every event in it.
 *
 * A different shape from the single-order handler, and for a reason rather than for
 * variety: a spread's parent and contracts arrive **together**, in one message, and the
 * handle is updated from all of them before the handler runs. Delivering them one at a
 * time would hand the caller a half-applied spread — the parent filled, one leg still
 * showing nothing — which is a state that never existed at the broker.
 */
export type MultiLegOrderEventHandler = (events: ReadonlyArray<BrokerOrderEvent>, orderObj: MultiLegOrderObj) => Promise<void>;

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
  /** Options only, and worth sending: inference cannot tell a closing sell from an opening short. */
  readonly positionIntent?: BrokerPositionIntent;
  readonly onEvent: SingleOrderEventHandler;
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
 *
 * The broker creates the second leg itself and gives it a client order id of its own, so
 * the exit is attributed from the parent's correlation rather than from one of its own.
 */
export interface OtoRequest extends BaseOrderRequest {
  readonly type: 'oto';
  readonly limitPrice: Decimal;
  readonly takeProfitLimitPrice: Decimal;
  readonly onTakeProfitEvent: SingleOrderEventHandler;
}

/** One contract of a spread. */
export interface MultiLegOrderRequestLeg {
  /** The OCC contract symbol. */
  readonly symbol: string;
  /**
   * This leg's contracts per spread, so `size` spreads trade `ratioQty * size` of it.
   * Alpaca requires the greatest common divisor across the legs to be 1 — 2 and 4 is
   * rejected, and the same spread written as 1 and 2 is accepted.
   */
  readonly ratioQty: Decimal;
  readonly side: BrokerOrderSide;
  /** Required here, unlike on a single order: a spread's margin depends on it. */
  readonly positionIntent: BrokerPositionIntent;
}

/**
 * A spread, placed as one order so its contracts fill together or not at all.
 *
 * It carries no `symbol`, no `side` and no `assetClass`: the spread trades no instrument
 * of its own, has no direction of its own, and is always options. Each of those lives on
 * a leg instead — which is exactly why this does not extend the single-order request.
 *
 * **Nothing holds buying power for one.** A spread's requirement is the width rather than
 * the sum of its legs, and no model here computes that, so it is placed unreserved and
 * says so at the point it happens. See `md/OPEN-ITEMS.md` item 2b.
 */
export interface MultiLegOrderRequest {
  readonly type: 'mleg';
  /** How many spreads. Always positive: the direction is on each leg. */
  readonly size: Decimal;
  /** Two to four contracts. */
  readonly legs: ReadonlyArray<MultiLegOrderRequestLeg>;
  /**
   * The package's net price, **signed**: positive is a debit you will pay, negative a
   * credit you require. Omit for a market order.
   *
   * Getting the sign wrong does not fail. It places a real order at a price nobody would
   * take, or worse, one far better for the other side than you meant.
   */
  readonly netLimitPrice?: Decimal;
  readonly accountId: string;
  readonly onEvent: MultiLegOrderEventHandler;
}

export type OrderRequest = MarketOrderRequest | LimitOrderRequest | OtoRequest | MultiLegOrderRequest;
