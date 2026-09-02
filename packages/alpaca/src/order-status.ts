import { AlpacaOrder, AlpacaOrderStatus } from './models';

/**
 * Where an order is in its life, and how to tell whether one event happened before
 * another.
 *
 * This matters because events do not arrive in order. The websocket can drop and
 * reconnect, and the REST backfill can return a picture older than one already seen —
 * so "is this news?" is a question that has to be answered before anything is applied.
 */

/** No further event will arrive. */
export function isTerminalStatus(status: AlpacaOrderStatus): boolean {
  return status === 'canceled' || status === 'done_for_day' || status === 'expired' || status === 'filled' || status === 'replaced' || status === 'rejected';
}

/** Live at the venue and still capable of filling. */
export function isInProgressStatus(status: AlpacaOrderStatus): boolean {
  return status === 'new' || status === 'partially_filled' || status === 'pending_cancel' || status === 'pending_replace';
}

/** Accepted by Alpaca but not yet working at the venue. */
export function isPendingStatus(status: AlpacaOrderStatus): boolean {
  return status === 'accepted' || status === 'held' || status === 'pending_new';
}

/**
 * True when `later` describes a state after `earlier`.
 *
 * The rough progression is
 * `held < accepted < pending_new < new < partially_filled < pending_cancel < terminal`,
 * with filled quantity breaking ties between two in-progress events: a report of five
 * shares filled supersedes one of two, whatever order they arrive in.
 */
export function isBefore(earlier: AlpacaOrder, later: AlpacaOrder): boolean {
  if (earlier.status === 'held' && later.status !== 'held') {
    return true;
  }
  if (earlier.status === 'accepted' && (later.status === 'pending_new' || !isPendingStatus(later.status))) {
    return true;
  }
  if (earlier.status === 'pending_new' && !isPendingStatus(later.status)) {
    return true;
  }
  if (isInProgressStatus(earlier.status) && isTerminalStatus(later.status)) {
    return true;
  }
  if (isInProgressStatus(earlier.status) && isInProgressStatus(later.status)) {
    if (Number(earlier.filled_qty) < Number(later.filled_qty)) {
      return true;
    }
    if (earlier.status === 'new' && later.status !== 'new') {
      return true;
    }
    if (earlier.status === 'partially_filled' && (later.status === 'pending_cancel' || later.status === 'pending_replace')) {
      return true;
    }
  }
  return false;
}

export function alpacaOrderToString(order: AlpacaOrder): string {
  if (order.status === 'filled' || order.status === 'partially_filled') {
    return `alpaca order ${order.id}: ${order.symbol} ${order.status}, ${order.filled_qty} filled at ${order.filled_avg_price}`;
  }
  return `alpaca order ${order.id}: ${order.symbol} ${order.status}`;
}
