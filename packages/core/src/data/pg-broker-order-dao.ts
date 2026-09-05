import { BrokerOrder, BrokerOrderRecord, Decimal, InternalServiceError } from '@fleece/shared';
import { Pool } from 'pg';
import {
  BrokerOrderDao,
  DeleteBrokerOrderInput,
  DeleteBrokerOrderOutput,
  GetBrokerOrderInput,
  GetBrokerOrderOutput,
  InsertBrokerOrderRecordInput,
  InsertBrokerOrderRecordOutput,
  ListBrokerOrderLegsInput,
  ListBrokerOrderLegsOutput,
  ListBrokerOrderRecordsInput,
  ListBrokerOrderRecordsOutput,
  ListBrokerOrdersInput,
  ListBrokerOrdersOutput,
  ListOrphanBrokerOrdersInput,
  ListOrphanBrokerOrdersOutput,
  UpsertBrokerOrderInput,
  UpsertBrokerOrderOutput,
} from './broker-order-dao';
import {
  toAssetClass,
  toBroker,
  toBrokerOrderAttribution,
  toBrokerOrderClass,
  toBrokerOrderSide,
  toBrokerOrderTimeInForce,
  toBrokerOrderType,
  toBrokerPositionIntent,
  toDecimal,
  toOptionalDecimal,
} from './row-parsers';

interface BrokerOrderRow {
  readonly broker_order_id: string;
  readonly parent_broker_order_id: string | null;
  readonly account_id: string;
  readonly broker: string;
  readonly broker_account_id: string;
  readonly attribution: string;
  readonly symbol: string | null;
  readonly asset_class: string;
  readonly multiplier: string;
  readonly status: string;
  readonly order_class: string;
  readonly order_type: string;
  readonly side: string | null;
  readonly position_intent: string | null;
  readonly time_in_force: string;
  readonly extended_hours: boolean;
  readonly qty: string;
  readonly ratio_qty: string | null;
  readonly limit_price: string | null;
  readonly stop_price: string | null;
  readonly filled_qty: string;
  readonly filled_avg_price: string | null;
  readonly submitted_at: Date | null;
  readonly filled_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function toBrokerOrder(row: BrokerOrderRow): BrokerOrder {
  const id = row.broker_order_id;
  return {
    brokerOrderId: id,
    parentBrokerOrderId: row.parent_broker_order_id === null ? undefined : row.parent_broker_order_id,
    accountId: row.account_id,
    broker: toBroker(row.broker, id),
    brokerAccountId: row.broker_account_id,
    attribution: toBrokerOrderAttribution(row.attribution, id),
    symbol: row.symbol === null ? undefined : row.symbol,
    assetClass: toAssetClass(row.asset_class, `Broker order ${id}`),
    multiplier: toDecimal(row.multiplier, `Broker order ${id} multiplier`),
    status: row.status,
    orderClass: toBrokerOrderClass(row.order_class, id),
    orderType: toBrokerOrderType(row.order_type, id),
    side: toBrokerOrderSide(row.side, id),
    positionIntent: toBrokerPositionIntent(row.position_intent, id),
    timeInForce: toBrokerOrderTimeInForce(row.time_in_force, id),
    extendedHours: row.extended_hours,
    qty: toDecimal(row.qty, `Broker order ${id} qty`),
    ratioQty: toOptionalDecimal(row.ratio_qty, `Broker order ${id} ratio_qty`),
    limitPrice: toOptionalDecimal(row.limit_price, `Broker order ${id} limit_price`),
    stopPrice: toOptionalDecimal(row.stop_price, `Broker order ${id} stop_price`),
    filledQty: toDecimal(row.filled_qty, `Broker order ${id} filled_qty`),
    filledAvgPrice: toOptionalDecimal(row.filled_avg_price, `Broker order ${id} filled_avg_price`),
    submittedAt: row.submitted_at === null ? undefined : row.submitted_at.getTime(),
    filledAt: row.filled_at === null ? undefined : row.filled_at.getTime(),
    createdAt: row.created_at.getTime(),
    lastUpdatedAt: row.updated_at.getTime(),
  };
}

function optionalDecimal(value: Decimal | undefined): string | null {
  return value === undefined ? null : value.toString();
}

const SELECT_COLUMNS = `broker_order_id, parent_broker_order_id, account_id, broker, broker_account_id, attribution, symbol, asset_class, multiplier,
  status, order_class, order_type, side, position_intent, time_in_force, extended_hours,
  qty, ratio_qty, limit_price, stop_price, filled_qty, filled_avg_price, submitted_at, filled_at, created_at, updated_at`;

export class PgBrokerOrderDao implements BrokerOrderDao {
  constructor(private readonly pool: Pool) {}

  /**
   * One statement, so two events for the same order cannot race each other into a
   * duplicate-key failure.
   *
   * `xmax = 0` is how Postgres answers "did this INSERT actually insert?" — on a row the
   * conflict clause updated, `xmax` holds the transaction that locked it and is
   * non-zero. It is the only way to tell an insert from an update in a single
   * round-trip, and the caller wants to know because a first sighting is worth a log
   * line and a repeat is not.
   *
   * The DO UPDATE list is deliberately short. Everything describing what the order *is*
   * — the account it trades for, how that was decided, its instrument, its size — is
   * written once and never overwritten, because an order does not change those and a
   * later report that disagrees is a bug upstream, not a correction to apply.
   */
  async upsertBrokerOrder(input: UpsertBrokerOrderInput): Promise<UpsertBrokerOrderOutput> {
    const result = await this.pool.query<BrokerOrderRow & { inserted: boolean }>(
      `INSERT INTO broker_order
         (broker_order_id, parent_broker_order_id, account_id, broker, broker_account_id, attribution, symbol, asset_class, multiplier,
          status, order_class, order_type, side, position_intent, time_in_force, extended_hours,
          qty, ratio_qty, limit_price, stop_price, filled_qty, filled_avg_price, submitted_at, filled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22,
               CASE WHEN $23::BIGINT IS NULL THEN NULL ELSE to_timestamp($23::BIGINT / 1000.0) END,
               CASE WHEN $24::BIGINT IS NULL THEN NULL ELSE to_timestamp($24::BIGINT / 1000.0) END)
       ON CONFLICT (broker_order_id) DO UPDATE
         SET status = EXCLUDED.status,
             filled_qty = EXCLUDED.filled_qty,
             filled_avg_price = COALESCE(EXCLUDED.filled_avg_price, broker_order.filled_avg_price),
             filled_at = COALESCE(EXCLUDED.filled_at, broker_order.filled_at),
             updated_at = now()
       RETURNING ${SELECT_COLUMNS}, (xmax = 0) AS inserted`,
      [
        input.brokerOrderId,
        input.parentBrokerOrderId ?? null,
        input.accountId,
        input.broker,
        input.brokerAccountId,
        input.attribution,
        input.symbol ?? null,
        input.assetClass,
        input.multiplier.toString(),
        input.status,
        input.orderClass,
        input.orderType,
        input.side ?? null,
        input.positionIntent ?? null,
        input.timeInForce,
        input.extendedHours,
        input.qty.toString(),
        optionalDecimal(input.ratioQty),
        optionalDecimal(input.limitPrice),
        optionalDecimal(input.stopPrice),
        input.filledQty.toString(),
        optionalDecimal(input.filledAvgPrice),
        input.submittedAt ?? null,
        input.filledAt ?? null,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new InternalServiceError(`Recording broker order ${input.brokerOrderId} returned no row.`);
    }
    return { brokerOrder: toBrokerOrder(row), created: row.inserted };
  }

  async getBrokerOrder(input: GetBrokerOrderInput): Promise<GetBrokerOrderOutput> {
    const result = await this.pool.query<BrokerOrderRow>(`SELECT ${SELECT_COLUMNS} FROM broker_order WHERE broker_order_id = $1`, [input.brokerOrderId]);
    const row = result.rows[0];
    return { brokerOrder: row === undefined ? null : toBrokerOrder(row) };
  }

  /**
   * At most one search property, each with its own index paired with `created_at`.
   * The service rejects more than one before it gets here; this builds whichever was
   * given into a range scan over that index.
   */
  async listBrokerOrders(input: ListBrokerOrdersInput): Promise<ListBrokerOrdersOutput> {
    const ascending = input.sort === 'asc';
    const parameters: unknown[] = [input.from, input.limit];
    const conditions: string[] = [`created_at ${ascending ? '>=' : '<='} to_timestamp($1 / 1000.0)`];

    const filters: ReadonlyArray<readonly [string, string | undefined]> = [
      ['account_id', input.accountId],
      ['broker_account_id', input.brokerAccountId],
      ['symbol', input.symbol],
      ['status', input.status],
      ['asset_class', input.assetClass],
    ];
    for (const [column, value] of filters) {
      if (value !== undefined) {
        parameters.push(value);
        conditions.push(`${column} = $${parameters.length}`);
      }
    }

    const direction = ascending ? 'ASC' : 'DESC';
    const result = await this.pool.query<BrokerOrderRow>(
      `SELECT ${SELECT_COLUMNS} FROM broker_order WHERE ${conditions.join(' AND ')} ORDER BY created_at ${direction}, broker_order_id ${direction} LIMIT $2`,
      parameters,
    );
    return { brokerOrders: result.rows.map(toBrokerOrder) };
  }

  async listBrokerOrderLegs(input: ListBrokerOrderLegsInput): Promise<ListBrokerOrderLegsOutput> {
    if (input.parentBrokerOrderIds.length === 0) {
      return { brokerOrders: [] };
    }
    // `= ANY($1)` rather than a generated IN list: one prepared statement shape
    // whatever the number of parents, and no parameter-count ceiling to trip over.
    const result = await this.pool.query<BrokerOrderRow>(`SELECT ${SELECT_COLUMNS} FROM broker_order WHERE parent_broker_order_id = ANY($1) ORDER BY created_at, broker_order_id`, [
      [...input.parentBrokerOrderIds],
    ]);
    return { brokerOrders: result.rows.map(toBrokerOrder) };
  }

  async listOrphanBrokerOrders(_input: ListOrphanBrokerOrdersInput): Promise<ListOrphanBrokerOrdersOutput> {
    const result = await this.pool.query<BrokerOrderRow>(`SELECT ${SELECT_COLUMNS} FROM broker_order WHERE attribution = 'default' ORDER BY created_at, broker_order_id`);
    return { brokerOrders: result.rows.map(toBrokerOrder) };
  }

  async deleteBrokerOrder(input: DeleteBrokerOrderInput): Promise<DeleteBrokerOrderOutput> {
    const result = await this.pool.query('DELETE FROM broker_order WHERE broker_order_id = $1', [input.brokerOrderId]);
    return { deleted: (result.rowCount ?? 0) > 0 };
  }

  async insertRecord(input: InsertBrokerOrderRecordInput): Promise<InsertBrokerOrderRecordOutput> {
    await this.pool.query('INSERT INTO broker_order_record (broker_order_id, record) VALUES ($1, $2)', [input.brokerOrderId, JSON.stringify(input.record)]);
    return {};
  }

  async listRecords(input: ListBrokerOrderRecordsInput): Promise<ListBrokerOrderRecordsOutput> {
    const result = await this.pool.query<{ record: BrokerOrderRecord }>('SELECT record FROM broker_order_record WHERE broker_order_id = $1 ORDER BY created_at, record_id', [
      input.brokerOrderId,
    ]);
    return { records: result.rows.map((row) => row.record) };
  }
}
