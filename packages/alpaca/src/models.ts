/**
 * Alpaca's wire shapes, exactly as they arrive. Everything is a string because that is
 * how Alpaca sends numbers; converting happens in `order-converter.ts`, at the one
 * boundary where a broker's format becomes the ledger's.
 *
 * Only what the injector needs is here. Order placement, watchlists, market calendar
 * and account balances belong to services that are not part of this port.
 */

export type AlpacaOrderStatus =
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

/**
 * `us_option` is what a single option contract trades as. A multi-leg parent carries
 * the empty string: it is a container, and the instruments are on its legs.
 */
export type AlpacaAssetClass = 'us_equity' | 'us_option' | 'crypto' | '';

/**
 * `''` is what Alpaca sends for a plain order rather than omitting the field, and
 * `simple` is what its own documentation calls the same thing. Both arrive in practice.
 *
 * `mleg` is a multi-leg options order — a spread placed as one order so that its legs
 * fill together or not at all.
 */
export type AlpacaOrderClass = 'simple' | 'oco' | 'oto' | 'bracket' | 'mleg' | '';

export type AlpacaOrderType = 'market' | 'limit' | 'stop' | 'stop_limit' | 'trailing_stop';

export type AlpacaOrderSide = 'buy' | 'sell';

/**
 * Whether a leg opens exposure or closes it. Required on every leg of a multi-leg
 * order, and accepted on a single-leg option order.
 */
export type AlpacaPositionIntent = 'buy_to_open' | 'buy_to_close' | 'sell_to_open' | 'sell_to_close';

export interface AlpacaOrder {
  /** Alpaca's order id. Changes when an order is replaced, because a replace is a new order. */
  readonly id: string;
  /** Set by us at order placement; carries the encoded correlation. */
  readonly client_order_id: string;
  readonly status: AlpacaOrderStatus;
  /** Options accept `day` and `gtc` only; the rest are equities and crypto. */
  readonly time_in_force: 'day' | 'gtc' | 'opg' | 'cls' | 'ioc' | 'fok';
  readonly order_class: AlpacaOrderClass;
  readonly order_type: AlpacaOrderType;
  /** Alpaca's older name for `order_type`, sent alongside it and always equal to it. */
  readonly type: AlpacaOrderType;
  /**
   * Empty on a multi-leg parent over REST — and *not* empty on the same order over the
   * websocket, which sends `'buy'` regardless of what the spread does. Neither is a
   * direction. Read the legs.
   */
  readonly side: AlpacaOrderSide | '';
  readonly extended_hours: boolean;

  /** Empty, or all-zero over the websocket, on a multi-leg parent. */
  readonly asset_id: string;
  /** An OCC contract symbol for an option, e.g. `AMZN261016C00280000`. Empty on a multi-leg parent. */
  readonly symbol: string;
  readonly asset_class: AlpacaAssetClass;
  /**
   * On a leg, which side of the spread it is. Empty on a multi-leg parent over the
   * websocket and absent from it over REST — Alpaca disagrees with itself here too.
   */
  readonly position_intent?: AlpacaPositionIntent | '';
  /**
   * A leg's share of one spread: a leg with `ratio_qty` 2 fills two contracts for every
   * one of the parent's `qty`. Legs only, and their greatest common divisor must be 1.
   */
  readonly ratio_qty?: string | null;

  /**
   * On a multi-leg order this is the whole spread's net price, and it is signed:
   * positive is a debit you pay, negative a credit you receive. Null on the legs, which
   * do not price themselves.
   */
  readonly limit_price: string | null;
  readonly stop_price: string | null;
  /** Always positive; the direction is in `side`. Counts spreads on a multi-leg parent. */
  readonly qty: string;
  readonly notional: string | null;
  /** '0' when nothing has filled. */
  readonly filled_qty: string;
  /** Signed on a multi-leg parent, the same way `limit_price` is. Unsigned elsewhere. */
  readonly filled_avg_price: string | null;

  readonly created_at: string;
  readonly updated_at: string;
  readonly submitted_at: string;
  readonly filled_at: string | null;
  readonly expired_at: string | null;
  readonly canceled_at: string | null;
  readonly failed_at: string | null;
  readonly replaced_at: string | null;
  readonly replaced_by: string | null;
  readonly replaces: string | null;
  /** When the order stops being good. Set on options; absent on older equity payloads. */
  readonly expires_at?: string | null;
  /** Websocket events only. A cancel that has been asked for but not yet confirmed. */
  readonly cancel_requested_at?: string | null;

  /**
   * Bracket, OTO and OCO orders carry their other orders here. A multi-leg order carries
   * the two to four contracts that make up the spread, and unlike the others they are
   * the only place its instruments appear.
   */
  readonly legs: null | ReadonlyArray<AlpacaOrder>;
  readonly trail_percent: null | string;
  readonly trail_price: null | string;
  readonly hwm: null | string;
  /** REST responses only. Alpaca's own routing metadata; nothing here reads them. */
  readonly subtag?: string | null;
  readonly source?: string | null;
}

/**
 * The subset of Alpaca's account entity the broker needs. Their payload is far larger;
 * these are the fields anything here actually reads.
 */
export interface AlpacaAccount {
  readonly id: string;
  readonly account_number: string;
  readonly status: string;
  readonly cash: string;
  readonly equity: string;
  /**
   * Cash plus margin. This, not `cash`, is what an order can draw on, which is why it
   * is what seeds the tracker.
   */
  readonly buying_power: string;
}

export interface AlpacaPosition {
  readonly symbol: string;
  readonly asset_id: string;
  readonly asset_class: AlpacaAssetClass;
  /** Signed: negative for a short. Counts contracts, not shares, for an option. */
  readonly qty: string;
  /**
   * Per share, so an option's is its premium rather than what the contract cost. The
   * dollars are in `cost_basis`, which Alpaca has already multiplied out.
   */
  readonly avg_entry_price: string;
  readonly side: 'long' | 'short';
  readonly market_value: string;
  readonly cost_basis: string;
}

export interface AlpacaAsset {
  readonly id: string;
  readonly symbol: string;
  readonly name: string;
  readonly exchange: string;
  readonly class: string;
  readonly status: string;
  readonly tradable: boolean;
  readonly marginable: boolean;
  readonly shortable: boolean;
  readonly easy_to_borrow: boolean;
}

/**
 * An option contract, from `/v2/options/contracts`.
 *
 * Options are not in `/v2/assets` — that endpoint 404s on an OCC symbol, and only says
 * of an underlying whether it has options at all. So an option instrument can be looked
 * up only here, which is why `getOptionContract` exists alongside `getAsset`.
 */
export interface AlpacaOptionContract {
  readonly id: string;
  /** The OCC symbol, e.g. `AMZN261016C00280000`. */
  readonly symbol: string;
  readonly name: string;
  readonly status: 'active' | 'inactive';
  readonly tradable: boolean;
  /** `YYYY-MM-DD`. */
  readonly expiration_date: string;
  readonly root_symbol: string;
  readonly underlying_symbol: string;
  readonly underlying_asset_id: string;
  readonly type: 'call' | 'put';
  readonly style: 'american' | 'european';
  readonly strike_price: string;
  /**
   * Shares of the underlying per contract. '100' for every ordinary US equity option;
   * a split or a merger can leave an adjusted contract with something else, which is
   * the case `OPTION_CONTRACT_MULTIPLIER` does not cover.
   */
  readonly multiplier: string;
  readonly size: string;
  readonly open_interest?: string;
  readonly open_interest_date?: string;
  readonly close_price?: string;
  readonly close_price_date?: string;
}

export interface AlpacaCredentials {
  readonly accessKey: string;
  readonly secretKey: string;
}

/** A function so that a rotated key is picked up on the next reconnect. */
export type AlpacaCredentialsProvider = AlpacaCredentials | (() => Promise<AlpacaCredentials>);

/**
 * Which Alpaca account this is, and whether it is real money.
 *
 * `accountId` is a plain string. The legacy type pinned it to a union of six literal
 * account numbers, so adding an account meant editing and republishing a shared
 * package — the ids now come from the environment.
 */
export interface AlpacaAccountIdentifier {
  readonly accountId: string;
  readonly live: boolean;
}

export async function resolveCredentials(provider: AlpacaCredentialsProvider): Promise<AlpacaCredentials> {
  return typeof provider === 'function' ? await provider() : provider;
}
