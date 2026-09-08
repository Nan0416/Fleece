/**
 * Claiming an order for a virtual account.
 *
 * This is the one thing the tracking service accepts rather than discovers. Everything
 * else it knows comes from the broker's own event stream; this comes from whoever placed
 * the order, and it exists for the orders that stream cannot attribute on its own.
 *
 * **It is a fallback, not an override.** An order normally carries its virtual account in
 * the broker's `client_order_id`, which comes back on every event about it — and a
 * composite order's legs inherit their parent's. A claim sits *last* in the resolution
 * order, behind the broker's own echo and behind whatever the broker order already
 * records, and it cannot move an order that is already booked. See
 * `OrderTrackingFacade.resolve`.
 *
 * What it buys is the orders nothing else can place: one Fleece never sent, and one sent
 * by a caller holding its own broker client. Without a claim, those sit in the holding
 * pen until `FLEECE_UNRESOLVED_ORDER_TIMEOUT_MS` expires and are then booked to the
 * catch-all account.
 */
export interface TrackBrokerOrdersRequest {
  /** The broker's own ids. A composite order may claim its parent and its legs together. */
  readonly brokerOrderIds: ReadonlyArray<string>;
  /** The virtual account they trade for. */
  readonly accountId: string;
}

/**
 * Empty on purpose, and an acknowledgement of *receipt*.
 *
 * The claim is applied on the same queue as the broker's events, so that one order's
 * events and the claim about it cannot be decided concurrently. By the time this
 * returns the claim is accepted and ordered, not necessarily applied — which is why the
 * endpoint answers 202 rather than 200.
 */
export interface TrackBrokerOrdersResponse {}
