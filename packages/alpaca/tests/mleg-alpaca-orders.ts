import { AlpacaOrder, AlpacaPositionIntent } from '../src/models';

/**
 * A two-leg AMZN call spread, in the shape Alpaca really sends.
 *
 * Copied field for field from `packages/playground/data/live-options-filled.json` — a
 * live vertical placed to record exactly this. It is reproduced here rather than
 * imported because `playground` sits outside the build, and nothing in the product may
 * depend on it.
 *
 * The details that look like mistakes and are not:
 *
 * - the parent's `symbol`, `asset_class` and `position_intent` are empty, and its
 *   `asset_id` is the all-zero uuid;
 * - the parent's `side` is `'buy'` here and `''` in the REST response for the same
 *   order, and neither describes what the spread does;
 * - the parent's `limit_price` and `filled_avg_price` are *negative*, because this
 *   spread was sold for a credit;
 * - the legs carry `order_type: 'limit'` with a null `limit_price`, because the price
 *   belongs to the package.
 */
export function mlegAlpacaOrder(overrides: Partial<AlpacaOrder> = {}): AlpacaOrder {
  return {
    id: 'mleg-parent-1',
    client_order_id: 'amzn-call-spread-9',
    status: 'filled',
    time_in_force: 'day',
    order_class: 'mleg',
    order_type: 'limit',
    type: 'limit',
    side: 'buy',
    position_intent: '',
    extended_hours: false,
    asset_id: '00000000-0000-0000-0000-000000000000',
    symbol: '',
    asset_class: '',
    limit_price: '-0.85',
    stop_price: null,
    qty: '1',
    notional: null,
    filled_qty: '1',
    filled_avg_price: '-0.9',
    created_at: '2026-09-04T19:51:40.827Z',
    updated_at: '2026-09-04T19:51:40.851Z',
    submitted_at: '2026-09-04T19:51:40.830Z',
    filled_at: '2026-09-04T19:51:40.839Z',
    expired_at: null,
    cancel_requested_at: null,
    canceled_at: null,
    failed_at: null,
    replaced_at: null,
    replaced_by: null,
    replaces: null,
    expires_at: '2026-09-04T20:00:00Z',
    legs: [
      mlegLeg({ id: 'mleg-leg-short', symbol: 'AMZN261016C00280000', side: 'sell', position_intent: 'sell_to_open', filled_avg_price: '3.85' }),
      mlegLeg({ id: 'mleg-leg-long', symbol: 'AMZN261016C00285000', side: 'buy', position_intent: 'buy_to_open', filled_avg_price: '2.95' }),
    ],
    trail_percent: null,
    trail_price: null,
    hwm: null,
    ...overrides,
  };
}

/** One contract of the spread above. */
export function mlegLeg(overrides: Partial<AlpacaOrder> & { readonly position_intent: AlpacaPositionIntent }): AlpacaOrder {
  return {
    id: 'mleg-leg-1',
    client_order_id: '252683c6-6b96-4663-a98b-ba765da74814',
    status: 'filled',
    time_in_force: 'day',
    order_class: 'mleg',
    order_type: 'limit',
    type: 'limit',
    side: 'sell',
    extended_hours: false,
    asset_id: 'b1fe5b79-ecc3-4432-8a4f-9436b0346fd5',
    symbol: 'AMZN261016C00280000',
    asset_class: 'us_option',
    ratio_qty: '1',
    // Null on a leg: the spread is priced as a package, on the parent.
    limit_price: null,
    stop_price: null,
    qty: '1',
    notional: null,
    filled_qty: '1',
    filled_avg_price: '3.85',
    created_at: '2026-09-04T19:51:40.827Z',
    updated_at: '2026-09-04T19:51:40.850Z',
    submitted_at: '2026-09-04T19:51:40.830Z',
    filled_at: '2026-09-04T19:51:40.839Z',
    expired_at: null,
    cancel_requested_at: null,
    canceled_at: null,
    failed_at: null,
    replaced_at: null,
    replaced_by: null,
    replaces: null,
    expires_at: '2026-09-04T20:00:00Z',
    legs: null,
    trail_percent: null,
    trail_price: null,
    hwm: null,
    ...overrides,
  };
}
