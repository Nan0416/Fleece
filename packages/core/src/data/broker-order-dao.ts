import {
  AssetClass,
  Broker,
  BrokerOrder,
  BrokerOrderAttribution,
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
 * A leg is a row here like any other order, naming its parent in
 * `parentBrokerOrderId` — which groups but does not resolve, because the converter
 * discards a multi-leg parent and a spread's legs therefore name an id this table holds
 * nothing for.
 */

/**
 * Records what a broker just said about an order, whether or not it has been seen
 * before.
 *
 * One idempotent write rather than a read followed by a create-or-update. Two events
 * for the same order arriving at once would otherwise each decide independently whether
 * the row existed, and one of the two inserts would fail on the primary key.
 *
 * **What an existing row keeps.** `accountId`, `attribution`, `symbol` and everything
 * else describing what the order *is* are written once and never overwritten: an order's
 * account does not change, and a later report claiming otherwise is a bug upstream
 * rather than a correction. Only what a broker legitimately revises — the status, the
 * filled quantity and price, the fill time — is updated. Claiming an order that was
 * booked to the catch-all account is `claimBrokerOrder`, which is guarded in SQL.
 */
export interface UpsertBrokerOrderInput {
  readonly brokerOrderId: string;
  readonly parentBrokerOrderId?: string;
  readonly accountId: string;
  readonly broker: Broker;
  readonly brokerAccountId: string;
  readonly attribution: BrokerOrderAttribution;

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

/** Orders nobody claimed: `attribution` is `default`, so they were booked to a catch-all account. */
export interface ListOrphanBrokerOrdersInput {}

export interface ListOrphanBrokerOrdersOutput {
  readonly brokerOrders: ReadonlyArray<BrokerOrder>;
}

/**
 * Moves an order off the catch-all account, and only off the catch-all account.
 *
 * `UPDATE ... WHERE attribution = 'default'` rather than a read followed by a write, so
 * a claim that arrives after the order has already been attributed cannot move it. That
 * guard is the reason this exists as its own method: a read-then-write would lose the
 * race, and losing it means a fill counted against the wrong strategy.
 */
export interface ClaimBrokerOrderInput {
  readonly brokerOrderId: string;
  readonly accountId: string;
  readonly attribution: BrokerOrderAttribution;
}

export interface ClaimBrokerOrderOutput {
  /** Null when there is no such order, or when it was already attributed to somebody. */
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
  upsertBrokerOrder(input: UpsertBrokerOrderInput): Promise<UpsertBrokerOrderOutput>;
  getBrokerOrder(input: GetBrokerOrderInput): Promise<GetBrokerOrderOutput>;
  listBrokerOrders(input: ListBrokerOrdersInput): Promise<ListBrokerOrdersOutput>;
  listBrokerOrderLegs(input: ListBrokerOrderLegsInput): Promise<ListBrokerOrderLegsOutput>;
  listOrphanBrokerOrders(input: ListOrphanBrokerOrdersInput): Promise<ListOrphanBrokerOrdersOutput>;
  claimBrokerOrder(input: ClaimBrokerOrderInput): Promise<ClaimBrokerOrderOutput>;
  /** Records go with it, by foreign key cascade. Legs do not: they are orders in their own right. */
  deleteBrokerOrder(input: DeleteBrokerOrderInput): Promise<DeleteBrokerOrderOutput>;
  insertRecord(input: InsertBrokerOrderRecordInput): Promise<InsertBrokerOrderRecordOutput>;
  listRecords(input: ListBrokerOrderRecordsInput): Promise<ListBrokerOrderRecordsOutput>;
}
