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

export interface AlpacaOrder {
  /** Alpaca's order id. Changes when an order is replaced, because a replace is a new order. */
  readonly id: string;
  /** Set by us at order placement; carries the encoded correlation. */
  readonly client_order_id: string;
  readonly status: AlpacaOrderStatus;
  readonly time_in_force: 'day' | 'gtc' | 'opg' | 'cls' | 'ioc' | 'fok';
  /** Empty string rather than absent for a plain order. */
  readonly order_class: 'oco' | 'oto' | 'bracket' | '';
  readonly order_type: 'market' | 'limit' | 'stop_limit' | 'stop';
  readonly type: 'market' | 'limit';
  readonly side: 'buy' | 'sell';
  readonly extended_hours: boolean;

  readonly asset_id: string;
  readonly symbol: string;
  readonly asset_class: string;

  readonly limit_price: string | null;
  readonly stop_price: string | null;
  /** Always positive; the direction is in `side`. */
  readonly qty: string;
  readonly notional: string | null;
  /** '0' when nothing has filled. */
  readonly filled_qty: string;
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

  /** Bracket, OTO and OCO orders carry their other orders here. */
  readonly legs: null | ReadonlyArray<AlpacaOrder>;
  readonly trail_percent: null | string;
  readonly trail_price: null | string;
  readonly hwm: null | string;
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
  /** Signed: negative for a short. */
  readonly qty: string;
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
