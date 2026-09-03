import { Document, OrderGroup, OrderGroupStatus } from '../models/order';

export interface CreateOrderGroupRequest {
  readonly accountId: string;
  readonly correlationType: string;
  /** Omit to have one generated. */
  readonly correlationId?: string;
}

export interface CreateOrderGroupResponse {
  readonly groupId: string;
}

export interface GetOrderGroupRequest {
  readonly groupId: string;
}

export interface GetOrderGroupResponse {
  readonly orderGroup: OrderGroup;
}

/**
 * Exactly one search property, and a time window with it unless that property is
 * `correlationId`.
 *
 * This looks arbitrary and is not: each property has a covering index paired with the
 * creation timestamp, so a query on one of them within a window is an index range
 * scan. Two properties, or one without a window, is a table scan the legacy service
 * refused rather than served slowly. `correlationId` is exempt because it is
 * selective on its own.
 */
export interface ListOrderGroupsRequest {
  readonly accountId?: string;
  readonly correlationType?: string;
  readonly correlationId?: string;
  readonly status?: OrderGroupStatus;
  readonly symbol?: string;
  readonly startTimestamp?: number;
  readonly endTimestamp?: number;
}

export interface ListOrderGroupsResponse {
  readonly orderGroups: ReadonlyArray<OrderGroup>;
}

export interface CloseOrderGroupRequest {
  readonly groupId: string;
}

export interface CloseOrderGroupResponse {}

/** Takes the group's broker orders and their records with it. */
export interface DeleteOrderGroupRequest {
  readonly groupId: string;
}

export interface DeleteOrderGroupResponse {}

/**
 * Upserts by `documentId`: a document already on the group is replaced, not
 * duplicated.
 */
export interface AppendDocumentsRequest {
  readonly groupId: string;
  readonly documents: ReadonlyArray<Document>;
}

export interface AppendDocumentsResponse {}
