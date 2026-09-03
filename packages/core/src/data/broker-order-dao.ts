import { Broker, BrokerOrder, BrokerOrderRecord, SortDirection } from '@fleece/shared';

export interface CreateBrokerOrderInput {
  readonly brokerOrderId: string;
  readonly symbol: string;
  readonly accountId: string;
  readonly broker: Broker;
  readonly brokerAccountId: string;
  readonly status: string;
  /** Absent means orphan — stored as NULL, not as a sentinel group id. */
  readonly groupId?: string;
}

export interface CreateBrokerOrderOutput {
  readonly brokerOrder: BrokerOrder;
}

export interface GetBrokerOrderInput {
  readonly brokerOrderId: string;
}

export interface GetBrokerOrderOutput {
  readonly brokerOrder: BrokerOrder | null;
}

export interface ListBrokerOrdersInput {
  readonly accountId?: string;
  readonly brokerAccountId?: string;
  readonly symbol?: string;
  readonly status?: string;
  readonly from: number;
  readonly limit: number;
  readonly sort: SortDirection;
}

export interface ListBrokerOrdersOutput {
  readonly brokerOrders: ReadonlyArray<BrokerOrder>;
}

export interface ListBrokerOrdersByGroupIdInput {
  readonly groupIds: ReadonlyArray<string>;
}

export interface ListBrokerOrdersByGroupIdOutput {
  readonly brokerOrders: ReadonlyArray<BrokerOrder>;
}

export interface ListOrphanBrokerOrdersInput {}

export interface ListOrphanBrokerOrdersOutput {
  readonly brokerOrders: ReadonlyArray<BrokerOrder>;
}

export interface SetBrokerOrderStatusInput {
  readonly brokerOrderId: string;
  readonly status: string;
}

export interface SetBrokerOrderStatusOutput {
  readonly brokerOrder: BrokerOrder | null;
}

export interface SetBrokerOrderGroupIdInput {
  readonly brokerOrderId: string;
  readonly groupId: string;
}

export interface SetBrokerOrderGroupIdOutput {
  readonly brokerOrder: BrokerOrder | null;
}

export interface DeleteBrokerOrderInput {
  readonly brokerOrderId: string;
}

export interface DeleteBrokerOrderOutput {
  readonly deleted: boolean;
}

export interface InsertBrokerOrderRecordInput {
  readonly brokerOrderId: string;
  readonly record: BrokerOrderRecord;
}

export interface InsertBrokerOrderRecordOutput {}

export interface ListBrokerOrderRecordsInput {
  readonly brokerOrderId: string;
}

export interface ListBrokerOrderRecordsOutput {
  readonly records: ReadonlyArray<BrokerOrderRecord>;
}

export interface BrokerOrderDao {
  createBrokerOrder(input: CreateBrokerOrderInput): Promise<CreateBrokerOrderOutput>;
  getBrokerOrder(input: GetBrokerOrderInput): Promise<GetBrokerOrderOutput>;
  listBrokerOrders(input: ListBrokerOrdersInput): Promise<ListBrokerOrdersOutput>;
  /** Takes every group at once, so building a list of groups stays two queries rather than one per group. */
  listBrokerOrdersByGroupId(input: ListBrokerOrdersByGroupIdInput): Promise<ListBrokerOrdersByGroupIdOutput>;
  listOrphanBrokerOrders(input: ListOrphanBrokerOrdersInput): Promise<ListOrphanBrokerOrdersOutput>;
  setStatus(input: SetBrokerOrderStatusInput): Promise<SetBrokerOrderStatusOutput>;
  setGroupId(input: SetBrokerOrderGroupIdInput): Promise<SetBrokerOrderGroupIdOutput>;
  /** Records go with it, by foreign key cascade. */
  deleteBrokerOrder(input: DeleteBrokerOrderInput): Promise<DeleteBrokerOrderOutput>;
  insertRecord(input: InsertBrokerOrderRecordInput): Promise<InsertBrokerOrderRecordOutput>;
  listRecords(input: ListBrokerOrderRecordsInput): Promise<ListBrokerOrderRecordsOutput>;
}
