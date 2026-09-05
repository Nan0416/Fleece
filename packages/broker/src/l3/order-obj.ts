import { BrokerOrderEvent, Decimal } from '@fleece/shared';

/**
 * What a caller holds after placing an order.
 *
 * More than a snapshot: a handle accumulates every event the broker reports about its
 * order, in arrival order, so whoever placed it watches rather than polls.
 *
 * **The shape mirrors the ledger's, deliberately.** `broker_order` gives a spread one row
 * for the parent and one per contract, all naming the parent, because a leg is a real
 * order at the broker with its own id, instrument, status and fills. These types say the
 * same thing, so "did what I placed get booked?" is a comparison rather than a
 * translation.
 */

/** An id and an event history. Everything a broker order has, including a leg. */
export interface OrderView {
  readonly brokerOrderId: string;
  readonly accountId: string;
  /** Every event received for this order, oldest first. */
  readonly events: ReadonlyArray<BrokerOrderEvent>;
  /** The most recent event, or undefined if none has arrived yet. */
  readonly latestEvent: BrokerOrderEvent | undefined;
}

/** A view you can also act on: the order as it was placed. */
export interface OrderObj extends OrderView {
  cancel(): Promise<void>;
}

/** One order in one instrument: an equity order, an option, or a leg of an OTO. */
export interface SingleOrderObj extends OrderObj {
  readonly kind: 'single';
  readonly symbol: string;
}

/**
 * A spread: the order you placed, with the contracts it is made of.
 *
 * It has no `symbol` and no price of its own worth reading — Alpaca leaves the parent's
 * symbol empty, and its `filledAvgPrice` is the package's **signed net**, `-0.9` for a
 * vertical sold at a credit. What filled, in what, at what price is on the legs.
 *
 * `cancel` lives here and not on a leg because that is the only cancellation Alpaca
 * offers: a spread's contracts fill together or not at all, and a method to cancel one
 * of them would be a method that cannot work.
 */
export interface MultiLegOrderObj extends OrderObj {
  readonly kind: 'multi-leg';
  /** Two to four contracts, in the order they were requested. */
  readonly legs: ReadonlyArray<OrderLegView>;
}

/**
 * One contract of a spread.
 *
 * A real order at the broker — its own id, its own instrument, its own fills — and
 * deliberately **not** an `OrderObj`: it cannot be cancelled apart from the spread it
 * belongs to.
 */
export interface OrderLegView extends OrderView {
  readonly parentBrokerOrderId: string;
  readonly symbol: string;
  /** This leg's contracts per spread. A vertical is 1 and 1; a ratio spread 1 and 2. */
  readonly ratioQty: Decimal;
}

/**
 * The pair an OTO request produces: an entry, and the exit it releases when filled.
 *
 * Two peers rather than a parent and a child, which is the difference between an OTO and
 * a spread. An OTO's exit is a real order in a real instrument that Alpaca will work,
 * fill and cancel on its own — so it gets a handle of its own, with a `cancel` that does
 * something.
 */
export interface OtoOrderObj {
  readonly entryOrder: SingleOrderObj;
  readonly exitOrder: SingleOrderObj;
}
