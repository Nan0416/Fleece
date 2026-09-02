import { BrokerOrderEvent } from '@fleece/shared';

/**
 * A live handle on an order that has been placed.
 *
 * More than a snapshot of state: it accumulates every event the broker reports about
 * the order, in arrival order, and lets the caller cancel it. Whoever placed the order
 * holds one of these rather than polling for status.
 */
export interface OrderObj {
  readonly symbol: string;
  readonly brokerOrderId: string;
  readonly accountId: string;
  readonly groupId?: string;

  /** Every event received for this order, oldest first. */
  readonly events: ReadonlyArray<BrokerOrderEvent>;

  /** The most recent event, or undefined if none has arrived yet. */
  readonly latestEvent: BrokerOrderEvent | undefined;

  cancel(): Promise<void>;
}

/** The pair an OTO request produces: an entry, and the exit it releases when filled. */
export interface OtoOrderObj {
  readonly entryOrder: OrderObj;
  readonly exitOrder: OrderObj;
}
