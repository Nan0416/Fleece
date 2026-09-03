import { BrokerOrder, OrderGroup } from '@fleece/shared';
import { Pool } from 'pg';
import { BrokerOrderDao } from './broker-order-dao';
import {
  CreateOrderGroupInput,
  CreateOrderGroupOutput,
  DeleteOrderGroupInput,
  DeleteOrderGroupOutput,
  GetOrderGroupInput,
  GetOrderGroupOutput,
  ListOrderGroupsInput,
  ListOrderGroupsOutput,
  OrderGroupDao,
  SetOrderGroupDocumentsInput,
  SetOrderGroupDocumentsOutput,
  SetOrderGroupStatusInput,
  SetOrderGroupStatusOutput,
} from './order-group-dao';
import { toDocuments, toOrderGroupStatus } from './row-parsers';

interface OrderGroupRow {
  readonly group_id: string;
  readonly correlation_id: string;
  readonly correlation_type: string;
  readonly status: string;
  readonly account_id: string;
  readonly documents: unknown;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const SELECT_COLUMNS = 'group_id, correlation_id, correlation_type, status, account_id, documents, created_at, updated_at';

export class PgOrderGroupDao implements OrderGroupDao {
  constructor(
    private readonly pool: Pool,
    private readonly brokerOrderDao: BrokerOrderDao,
  ) {}

  async createOrderGroup(input: CreateOrderGroupInput): Promise<CreateOrderGroupOutput> {
    const result = await this.pool.query<OrderGroupRow>(
      `INSERT INTO order_group (group_id, correlation_id, correlation_type, status, account_id) VALUES ($1, $2, $3, $4, $5) RETURNING ${SELECT_COLUMNS}`,
      [input.groupId, input.correlationId, input.correlationType, input.status, input.accountId],
    );
    // Newly created, so it has no broker orders yet and no second query is needed.
    return { orderGroup: this.toOrderGroup(result.rows[0], []) };
  }

  async getOrderGroup(input: GetOrderGroupInput): Promise<GetOrderGroupOutput> {
    const result = await this.pool.query<OrderGroupRow>(`SELECT ${SELECT_COLUMNS} FROM order_group WHERE group_id = $1`, [input.groupId]);
    const row = result.rows[0];
    if (row === undefined) {
      return { orderGroup: null };
    }
    const { brokerOrders } = await this.brokerOrderDao.listBrokerOrdersByGroupId({ groupIds: [row.group_id] });
    return { orderGroup: this.toOrderGroup(row, brokerOrders) };
  }

  async listOrderGroups(input: ListOrderGroupsInput): Promise<ListOrderGroupsOutput> {
    const parameters: unknown[] = [];
    const conditions: string[] = [];

    const filters: ReadonlyArray<readonly [string, string | undefined]> = [
      ['account_id', input.accountId],
      ['correlation_id', input.correlationId],
      ['correlation_type', input.correlationType],
      ['status', input.status],
    ];
    for (const [column, value] of filters) {
      if (value !== undefined) {
        parameters.push(value);
        conditions.push(`${column} = $${parameters.length}`);
      }
    }

    if (input.startTimestamp !== undefined) {
      parameters.push(input.startTimestamp);
      conditions.push(`created_at >= to_timestamp($${parameters.length} / 1000.0)`);
    }
    if (input.endTimestamp !== undefined) {
      parameters.push(input.endTimestamp);
      conditions.push(`created_at <= to_timestamp($${parameters.length} / 1000.0)`);
    }

    // A group has no symbol of its own — its broker orders do — so this is an EXISTS
    // rather than a column comparison, and a group with no orders yet matches no
    // symbol.
    //
    // The legacy service accepted this filter, validated it, and then built its query
    // without it: anyone narrowing a listing by symbol silently received every group.
    // Applying it is a behaviour change, and the intended one.
    if (input.symbol !== undefined) {
      parameters.push(input.symbol);
      conditions.push(`EXISTS (SELECT 1 FROM broker_order WHERE broker_order.group_id = order_group.group_id AND broker_order.symbol = $${parameters.length})`);
    }

    const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`;
    const result = await this.pool.query<OrderGroupRow>(`SELECT ${SELECT_COLUMNS} FROM order_group${where} ORDER BY created_at, group_id`, parameters);

    if (result.rows.length === 0) {
      return { orderGroups: [] };
    }

    // One query for every group's orders, not one per group.
    const { brokerOrders } = await this.brokerOrderDao.listBrokerOrdersByGroupId({ groupIds: result.rows.map((row) => row.group_id) });
    const byGroup = new Map<string, BrokerOrder[]>();
    for (const brokerOrder of brokerOrders) {
      if (brokerOrder.groupId === undefined) {
        continue;
      }
      const bucket = byGroup.get(brokerOrder.groupId);
      if (bucket === undefined) {
        byGroup.set(brokerOrder.groupId, [brokerOrder]);
      } else {
        bucket.push(brokerOrder);
      }
    }

    return { orderGroups: result.rows.map((row) => this.toOrderGroup(row, byGroup.get(row.group_id) ?? [])) };
  }

  async setStatus(input: SetOrderGroupStatusInput): Promise<SetOrderGroupStatusOutput> {
    const result = await this.pool.query<OrderGroupRow>(`UPDATE order_group SET status = $2, updated_at = now() WHERE group_id = $1 RETURNING ${SELECT_COLUMNS}`, [
      input.groupId,
      input.status,
    ]);
    const row = result.rows[0];
    if (row === undefined) {
      return { orderGroup: null };
    }
    const { brokerOrders } = await this.brokerOrderDao.listBrokerOrdersByGroupId({ groupIds: [row.group_id] });
    return { orderGroup: this.toOrderGroup(row, brokerOrders) };
  }

  async setDocuments(input: SetOrderGroupDocumentsInput): Promise<SetOrderGroupDocumentsOutput> {
    const result = await this.pool.query<OrderGroupRow>(`UPDATE order_group SET documents = $2, updated_at = now() WHERE group_id = $1 RETURNING ${SELECT_COLUMNS}`, [
      input.groupId,
      JSON.stringify(input.documents),
    ]);
    const row = result.rows[0];
    if (row === undefined) {
      return { orderGroup: null };
    }
    const { brokerOrders } = await this.brokerOrderDao.listBrokerOrdersByGroupId({ groupIds: [row.group_id] });
    return { orderGroup: this.toOrderGroup(row, brokerOrders) };
  }

  async deleteOrderGroup(input: DeleteOrderGroupInput): Promise<DeleteOrderGroupOutput> {
    const result = await this.pool.query('DELETE FROM order_group WHERE group_id = $1', [input.groupId]);
    return { deleted: (result.rowCount ?? 0) > 0 };
  }

  private toOrderGroup(row: OrderGroupRow, brokerOrders: ReadonlyArray<BrokerOrder>): OrderGroup {
    return {
      groupId: row.group_id,
      correlationId: row.correlation_id,
      correlationType: row.correlation_type,
      status: toOrderGroupStatus(row.status, row.group_id),
      accountId: row.account_id,
      brokerOrders,
      documents: toDocuments(row.documents, row.group_id),
      createdAt: row.created_at.getTime(),
      lastUpdatedAt: row.updated_at.getTime(),
    };
  }
}
