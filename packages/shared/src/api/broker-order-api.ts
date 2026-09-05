import { AssetClass } from '../models/asset-class';
import { BrokerOrder, BrokerOrderRecord, OrderFillProgress } from '../models/order';
import { TimeWindowPage } from './common';

export interface GetBrokerOrderRequest {
  readonly brokerOrderId: string;
}

export interface GetBrokerOrderResponse {
  readonly brokerOrder: BrokerOrder;
}

/**
 * At most one search property, plus a time window.
 *
 * Not taste: each property has an index paired with `created_at`, so one property plus a
 * window is a range scan and anything else is a table scan. The error message names the
 * properties to pick from.
 */
export interface ListBrokerOrdersRequest extends TimeWindowPage {
  readonly accountId?: string;
  readonly brokerAccountId?: string;
  readonly symbol?: string;
  readonly status?: string;
  readonly assetClass?: AssetClass;
}

export interface ListBrokerOrdersResponse {
  readonly brokerOrders: ReadonlyArray<BrokerOrder>;
}

/**
 * The legs of one composite order.
 *
 * Takes the parent's broker order id without requiring a row for it. A parent is
 * normally recorded — it is the id a placement returns and a cancel names — but this
 * resolves the legs whether or not it is, because `parent_broker_order_id` is a grouping
 * column rather than a foreign key.
 */
export interface ListBrokerOrderLegsRequest {
  readonly parentBrokerOrderId: string;
}

export interface ListBrokerOrderLegsResponse {
  readonly brokerOrders: ReadonlyArray<BrokerOrder>;
}

/**
 * Orders nobody claimed — `attribution` is `default`.
 *
 * Placed outside the system, typically by hand on the broker's own website, or a leg
 * whose parent could not be resolved before the injector gave up waiting. Worth
 * reviewing, because each one was booked against a catch-all virtual account rather
 * than the strategy that caused it.
 */
export interface ListOrphanBrokerOrdersRequest {}

export interface ListOrphanBrokerOrdersResponse {
  readonly brokerOrders: ReadonlyArray<BrokerOrder>;
}

/** The raw broker events for one order, oldest first. */
export interface ListBrokerOrderRecordsRequest {
  readonly brokerOrderId: string;
}

export interface ListBrokerOrderRecordsResponse {
  readonly records: ReadonlyArray<BrokerOrderRecord>;
}

/**
 * What the ledger has booked against one broker order, next to what the broker says it
 * filled.
 *
 * The two are different numbers in different units, and this is where they can be
 * compared. `reconciled` is the check that the stored progress still agrees with the
 * transactions it counts — the guarantee that came free when the figure was summed on
 * every read, and that has to be asked for now that it is stored.
 */
export interface GetOrderFillProgressRequest {
  readonly referenceId: string;
}

export interface GetOrderFillProgressResponse {
  /**
   * One entry per account and symbol the order booked against — normally exactly one,
   * and a list rather than a single value because that is what the key actually is.
   */
  readonly progress: ReadonlyArray<OrderFillProgress>;
  /** False when a stored counter no longer agrees with the transactions it counts. */
  readonly reconciled: boolean;
}

/** Takes the order's records with it. Does not unwind the transactions it produced. */
export interface DeleteBrokerOrderRequest {
  readonly brokerOrderId: string;
}

export interface DeleteBrokerOrderResponse {}
