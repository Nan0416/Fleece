import { Document, OrderGroup, OrderGroupStatus } from '@fleece/shared';

export interface CreateOrderGroupInput {
  readonly groupId: string;
  readonly correlationId: string;
  readonly correlationType: string;
  readonly status: OrderGroupStatus;
  readonly accountId: string;
}

export interface CreateOrderGroupOutput {
  readonly orderGroup: OrderGroup;
}

export interface GetOrderGroupInput {
  readonly groupId: string;
}

export interface GetOrderGroupOutput {
  readonly orderGroup: OrderGroup | null;
}

/**
 * Exactly one of the search properties, and a time window with it unless it is
 * `correlationId`. The service enforces that; this assumes it.
 */
export interface ListOrderGroupsInput {
  readonly accountId?: string;
  readonly correlationType?: string;
  readonly correlationId?: string;
  readonly status?: OrderGroupStatus;
  readonly symbol?: string;
  readonly startTimestamp?: number;
  readonly endTimestamp?: number;
}

export interface ListOrderGroupsOutput {
  readonly orderGroups: ReadonlyArray<OrderGroup>;
}

export interface SetOrderGroupStatusInput {
  readonly groupId: string;
  readonly status: OrderGroupStatus;
}

export interface SetOrderGroupStatusOutput {
  readonly orderGroup: OrderGroup | null;
}

export interface SetOrderGroupDocumentsInput {
  readonly groupId: string;
  readonly documents: ReadonlyArray<Document>;
}

export interface SetOrderGroupDocumentsOutput {
  readonly orderGroup: OrderGroup | null;
}

export interface DeleteOrderGroupInput {
  readonly groupId: string;
}

export interface DeleteOrderGroupOutput {
  readonly deleted: boolean;
}

/**
 * An order group is an aggregate: it is never useful without the broker orders it
 * contains, so every read here returns them too. That is one extra query for the
 * whole result set rather than the legacy's one per group.
 */
export interface OrderGroupDao {
  createOrderGroup(input: CreateOrderGroupInput): Promise<CreateOrderGroupOutput>;
  getOrderGroup(input: GetOrderGroupInput): Promise<GetOrderGroupOutput>;
  listOrderGroups(input: ListOrderGroupsInput): Promise<ListOrderGroupsOutput>;
  setStatus(input: SetOrderGroupStatusInput): Promise<SetOrderGroupStatusOutput>;
  setDocuments(input: SetOrderGroupDocumentsInput): Promise<SetOrderGroupDocumentsOutput>;
  /** Broker orders in the group, and their records, go with it by cascade. */
  deleteOrderGroup(input: DeleteOrderGroupInput): Promise<DeleteOrderGroupOutput>;
}
