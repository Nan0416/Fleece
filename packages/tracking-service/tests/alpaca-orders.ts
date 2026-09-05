import { AlpacaOrder } from '@fleece/alpaca';

/** A plausible Alpaca order, overridable field by field. */
export function alpacaOrder(overrides: Partial<AlpacaOrder> = {}): AlpacaOrder {
  return {
    id: 'order-1',
    client_order_id: '_c@a:MOMENTUM01',
    status: 'filled',
    time_in_force: 'day',
    order_class: '',
    order_type: 'market',
    type: 'market',
    side: 'buy',
    extended_hours: false,
    asset_id: 'asset-1',
    symbol: 'AAPL',
    asset_class: 'us_equity',
    limit_price: null,
    stop_price: null,
    qty: '10',
    notional: null,
    filled_qty: '10',
    filled_avg_price: '150',
    created_at: '2026-09-01T14:30:00Z',
    updated_at: '2026-09-01T14:30:00Z',
    submitted_at: '2026-09-01T14:30:00Z',
    filled_at: '2026-09-01T14:30:00Z',
    expired_at: null,
    canceled_at: null,
    failed_at: null,
    replaced_at: null,
    replaced_by: null,
    replaces: null,
    legs: null,
    trail_percent: null,
    trail_price: null,
    hwm: null,
    ...overrides,
  };
}

/**
 * A filled two-leg AMZN call spread, in the shape Alpaca really sends — an empty symbol
 * and a negative net price on the parent, the contracts on the legs.
 *
 * Taken from `packages/playground/data/live-options-filled.json`.
 */
export function mlegOrder(overrides: Partial<AlpacaOrder> = {}): AlpacaOrder {
  return alpacaOrder({
    id: 'mleg-parent-1',
    order_class: 'mleg',
    order_type: 'limit',
    type: 'limit',
    side: '',
    symbol: '',
    asset_class: '',
    asset_id: '',
    limit_price: '-0.85',
    qty: '1',
    filled_qty: '1',
    filled_avg_price: '-0.9',
    legs: [
      alpacaOrder({
        id: 'mleg-leg-short',
        client_order_id: 'alpaca-assigned-1',
        order_class: 'mleg',
        order_type: 'limit',
        type: 'limit',
        side: 'sell',
        symbol: 'AMZN261016C00280000',
        asset_class: 'us_option',
        position_intent: 'sell_to_open',
        ratio_qty: '1',
        limit_price: null,
        qty: '1',
        filled_qty: '1',
        filled_avg_price: '3.85',
      }),
      alpacaOrder({
        id: 'mleg-leg-long',
        client_order_id: 'alpaca-assigned-2',
        order_class: 'mleg',
        order_type: 'limit',
        type: 'limit',
        side: 'buy',
        symbol: 'AMZN261016C00285000',
        asset_class: 'us_option',
        position_intent: 'buy_to_open',
        ratio_qty: '1',
        limit_price: null,
        qty: '1',
        filled_qty: '1',
        filled_avg_price: '2.95',
      }),
    ],
    ...overrides,
  });
}
