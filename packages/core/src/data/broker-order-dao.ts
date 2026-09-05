import {
  AssetClass,
  Broker,
  BrokerOrder,
  BrokerOrderClass,
  BrokerOrderRecord,
  BrokerOrderSide,
  BrokerOrderTimeInForce,
  BrokerOrderType,
  BrokerPositionIntent,
  Decimal,
  SortDirection,
} from '@fleece/shared';

/**
 * One order at one broker, and the raw events behind it.
 *
 * A leg is a row here like any other order, naming its parent in `parentBrokerOrderId`
 * — a grouping column with no foreign key, so a leg lands whether or not its parent has
 * been recorded yet.
 */

/**
 * Records what a broker just said about an order, whether or not it has been seen
 * before.
 *
 * One idempotent write rather than a read followed by a create-or-update. Two events
 * for the same order arriving at once would otherwise each decide independently whether
 * the row existed, and one of the two inserts would fail on the primary key.
 *
 * **What an existing row keeps.** `accountId`, `symbol` and everything else describing
 * what the order *is* are written once and never overwritten. Only what
 * a broker legitimately revises — the status, the filled quantity and price, the fill
 * time — is updated.
 *
 * **There is no way to change an order's account, and that is the point.** Every
 * `ledger_transaction`, `position`, `profit` row and `order_fill_progress` counter the
 * order produced is keyed by the account it was booked to. Moving the order alone leaves
 * all of them behind and makes the next cumulative report read a counter that does not
 * exist, which books the whole fill a second time under the new account. The legacy
 * refused to move one for the same reason, logging a fatal-error metric instead. To
 * correct a mis-booked orphan, move the *position* with `transferPosition`, which is
 * double-entry and leaves an audit trail on both sides.
 */
export interface UpsertBrokerOrderInput {
  readonly brokerOrderId: string;
  readonly parentBrokerOrderId?: string;
  readonly accountId: string;
  readonly broker: Broker;
  readonly brokerAccountId: string;

  /** Absent only for a composite parent, which trades no instrument of its own. */
  readonly symbol?: string;
  readonly assetClass: AssetClass;
  readonly multiplier: Decimal;

  readonly status: string;
  readonly orderClass: BrokerOrderClass;
  readonly orderType: BrokerOrderType;
  readonly side?: BrokerOrderSide;
  readonly positionIntent?: BrokerPositionIntent;
  readonly timeInForce: BrokerOrderTimeInForce;
  readonly extendedHours: boolean;

  readonly qty: Decimal;
  readonly ratioQty?: Decimal;
  readonly limitPrice?: Decimal;
  readonly stopPrice?: Decimal;
  /** As the broker reports it: contracts and a premium per share for an option. */
  readonly filledQty: Decimal;
  readonly filledAvgPrice?: Decimal;

  readonly submittedAt?: number;
  readonly filledAt?: number;
}

export interface UpsertBrokerOrderOutput {
  readonly brokerOrder: BrokerOrder;
  /** False when the row already existed and only its mutable fields moved. */
  readonly created: boolean;
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
  readonly assetClass?: AssetClass;
  readonly from: number;
  readonly limit: number;
  readonly sort: SortDirection;
}

export interface ListBrokerOrdersOutput {
  readonly brokerOrders: ReadonlyArray<BrokerOrder>;
}

export interface ListBrokerOrderLegsInput {
  /** Takes every parent at once, so listing legs for many orders stays one query. */
  readonly parentBrokerOrderIds: ReadonlyArray<string>;
}

export interface ListBrokerOrderLegsOutput {
  readonly brokerOrders: ReadonlyArray<BrokerOrder>;
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
  upsertBrokerOrder(input: UpsertBrokerOrderInput): Promise<UpsertBrokerOrderOutput>;
  getBrokerOrder(input: GetBrokerOrderInput): Promise<GetBrokerOrderOutput>;
  listBrokerOrders(input: ListBrokerOrdersInput): Promise<ListBrokerOrdersOutput>;
  listBrokerOrderLegs(input: ListBrokerOrderLegsInput): Promise<ListBrokerOrderLegsOutput>;
  /** Records go with it, by foreign key cascade. Legs do not: they are orders in their own right. */
  deleteBrokerOrder(input: DeleteBrokerOrderInput): Promise<DeleteBrokerOrderOutput>;
  insertRecord(input: InsertBrokerOrderRecordInput): Promise<InsertBrokerOrderRecordOutput>;
  listRecords(input: ListBrokerOrderRecordsInput): Promise<ListBrokerOrderRecordsOutput>;
}
