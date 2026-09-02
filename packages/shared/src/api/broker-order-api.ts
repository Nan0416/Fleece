import { BrokerOrder, BrokerOrderRecord } from '../models/order';
import { TimeWindowPage } from './common';

export interface GetBrokerOrderRequest {
  readonly brokerOrderId: string;
}

export interface GetBrokerOrderResponse {
  readonly brokerOrder: BrokerOrder;
}

/** At most one search property, for the same index-coverage reason as order groups. */
export interface ListBrokerOrdersRequest extends TimeWindowPage {
  readonly accountId?: string;
  readonly brokerAccountId?: string;
  readonly symbol?: string;
  readonly status?: string;
}

export interface ListBrokerOrdersResponse {
  readonly brokerOrders: ReadonlyArray<BrokerOrder>;
}

export interface ListBrokerOrdersByGroupIdRequest {
  readonly groupId: string;
}

export interface ListBrokerOrdersByGroupIdResponse {
  readonly brokerOrders: ReadonlyArray<BrokerOrder>;
}

/**
 * Orders with no order group: placed outside the system, or a leg whose parent could
 * not be resolved before the injector gave up waiting. Worth reviewing, because each
 * one was booked against a default virtual account rather than the strategy that
 * caused it.
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

/** Takes the order's records with it. Does not unwind the transactions it produced. */
export interface DeleteBrokerOrderRequest {
  readonly brokerOrderId: string;
}

export interface DeleteBrokerOrderResponse {}
