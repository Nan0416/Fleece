import { BrokerOrder, BrokerOrderRecord, InternalServiceError } from '@fleece/shared';
import { Pool } from 'pg';
import {
  BrokerOrderDao,
  CreateBrokerOrderInput,
  CreateBrokerOrderOutput,
  DeleteBrokerOrderInput,
  DeleteBrokerOrderOutput,
  GetBrokerOrderInput,
  GetBrokerOrderOutput,
  InsertBrokerOrderRecordInput,
  InsertBrokerOrderRecordOutput,
  ListBrokerOrderRecordsInput,
  ListBrokerOrderRecordsOutput,
  ListBrokerOrdersByGroupIdInput,
  ListBrokerOrdersByGroupIdOutput,
  ListBrokerOrdersInput,
  ListBrokerOrdersOutput,
  ListOrphanBrokerOrdersInput,
  ListOrphanBrokerOrdersOutput,
  SetBrokerOrderGroupIdInput,
  SetBrokerOrderGroupIdOutput,
  SetBrokerOrderStatusInput,
  SetBrokerOrderStatusOutput,
} from './broker-order-dao';
import { toBroker } from './row-parsers';

interface BrokerOrderRow {
  readonly broker_order_id: string;
  readonly symbol: string;
  readonly account_id: string;
  readonly broker: string;
  readonly broker_account_id: string;
  readonly status: string;
  readonly group_id: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function toBrokerOrder(row: BrokerOrderRow): BrokerOrder {
  return {
    brokerOrderId: row.broker_order_id,
    symbol: row.symbol,
    accountId: row.account_id,
    broker: toBroker(row.broker, row.broker_order_id),
    brokerAccountId: row.broker_account_id,
    status: row.status,
    groupId: row.group_id === null ? undefined : row.group_id,
    createdAt: row.created_at.getTime(),
    lastUpdatedAt: row.updated_at.getTime(),
  };
}

const SELECT_COLUMNS = 'broker_order_id, symbol, account_id, broker, broker_account_id, status, group_id, created_at, updated_at';

export class PgBrokerOrderDao implements BrokerOrderDao {
  constructor(private readonly pool: Pool) {}

  async createBrokerOrder(input: CreateBrokerOrderInput): Promise<CreateBrokerOrderOutput> {
    const result = await this.pool.query<BrokerOrderRow>(
      `INSERT INTO broker_order (broker_order_id, symbol, account_id, broker, broker_account_id, status, group_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${SELECT_COLUMNS}`,
      [input.brokerOrderId, input.symbol, input.accountId, input.broker, input.brokerAccountId, input.status, input.groupId ?? null],
    );
    return { brokerOrder: toBrokerOrder(result.rows[0]) };
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

  async listBrokerOrdersByGroupId(input: ListBrokerOrdersByGroupIdInput): Promise<ListBrokerOrdersByGroupIdOutput> {
    if (input.groupIds.length === 0) {
      return { brokerOrders: [] };
    }
    // `= ANY($1)` rather than a generated IN list: one prepared statement shape
    // whatever the number of groups, and no parameter-count ceiling to trip over.
    const result = await this.pool.query<BrokerOrderRow>(`SELECT ${SELECT_COLUMNS} FROM broker_order WHERE group_id = ANY($1) ORDER BY created_at, broker_order_id`, [
      [...input.groupIds],
    ]);
    return { brokerOrders: result.rows.map(toBrokerOrder) };
  }

  async listOrphanBrokerOrders(_input: ListOrphanBrokerOrdersInput): Promise<ListOrphanBrokerOrdersOutput> {
    const result = await this.pool.query<BrokerOrderRow>(`SELECT ${SELECT_COLUMNS} FROM broker_order WHERE group_id IS NULL ORDER BY created_at, broker_order_id`);
    return { brokerOrders: result.rows.map(toBrokerOrder) };
  }

  async setStatus(input: SetBrokerOrderStatusInput): Promise<SetBrokerOrderStatusOutput> {
    const result = await this.pool.query<BrokerOrderRow>(`UPDATE broker_order SET status = $2, updated_at = now() WHERE broker_order_id = $1 RETURNING ${SELECT_COLUMNS}`, [
      input.brokerOrderId,
      input.status,
    ]);
    const row = result.rows[0];
    return { brokerOrder: row === undefined ? null : toBrokerOrder(row) };
  }

  /**
   * Only ever sets a group on an order that has none. An order's group is not
   * something that changes: the guard is in the WHERE clause rather than in a
   * read-then-write, so a late tracking request cannot move an order that has already
   * been placed in a group.
   */
  async setGroupId(input: SetBrokerOrderGroupIdInput): Promise<SetBrokerOrderGroupIdOutput> {
    const result = await this.pool.query<BrokerOrderRow>(
      `UPDATE broker_order SET group_id = $2, updated_at = now() WHERE broker_order_id = $1 AND group_id IS NULL RETURNING ${SELECT_COLUMNS}`,
      [input.brokerOrderId, input.groupId],
    );
    const row = result.rows[0];
    return { brokerOrder: row === undefined ? null : toBrokerOrder(row) };
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
    const result = await this.pool.query<{ record: unknown }>('SELECT record FROM broker_order_record WHERE broker_order_id = $1 ORDER BY created_at, record_id', [
      input.brokerOrderId,
    ]);
    return {
      records: result.rows.map((row) => {
        const record = row.record;
        if (typeof record !== 'object' || record === null || !('id' in record) || typeof record.id !== 'string') {
          throw new InternalServiceError(`A broker order record for ${input.brokerOrderId} is missing its id.`);
        }
        const parsed: BrokerOrderRecord = { ...record, id: record.id };
        return parsed;
      }),
    };
  }
}
