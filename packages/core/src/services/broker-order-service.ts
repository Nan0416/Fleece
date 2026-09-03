import {
  Broker,
  BrokerOrder,
  BrokerOrderRecord,
  DeleteBrokerOrderRequest,
  DeleteBrokerOrderResponse,
  GetBrokerOrderRequest,
  GetBrokerOrderResponse,
  InvalidRequestError,
  ListBrokerOrderRecordsRequest,
  ListBrokerOrderRecordsResponse,
  ListBrokerOrdersByGroupIdRequest,
  ListBrokerOrdersByGroupIdResponse,
  ListBrokerOrdersRequest,
  ListBrokerOrdersResponse,
  ListOrphanBrokerOrdersRequest,
  ListOrphanBrokerOrdersResponse,
  LoggerFactory,
  NotFoundError,
} from '@fleece/shared';
import { AccountDao } from '../data/account-dao';
import { BrokerOrderDao } from '../data/broker-order-dao';
import { OrderGroupDao } from '../data/order-group-dao';

const logger = LoggerFactory.getLogger('BrokerOrderService');

interface SearchProperty {
  readonly name: string;
  readonly value: string | undefined;
}

export interface CreateBrokerOrderRequest {
  readonly brokerOrderId: string;
  readonly symbol: string;
  readonly accountId: string;
  readonly broker: Broker;
  readonly brokerAccountId: string;
  readonly status: string;
  /** Omit for an orphan: an order with no group, stored with a NULL group id. */
  readonly groupId?: string;
}

export interface CreateBrokerOrderResponse {
  readonly brokerOrder: BrokerOrder;
}

export interface SetBrokerOrderStatusRequest {
  readonly brokerOrderId: string;
  readonly status: string;
}

export interface SetBrokerOrderStatusResponse {}

export interface SetBrokerOrderGroupIdRequest {
  readonly brokerOrderId: string;
  readonly groupId: string;
}

export interface SetBrokerOrderGroupIdResponse {
  /** False when the order was already in a group, which is never overwritten. */
  readonly bound: boolean;
}

export interface InsertBrokerOrderRecordRequest {
  readonly record: BrokerOrderRecord;
}

export interface InsertBrokerOrderRecordResponse {}

export class BrokerOrderService {
  constructor(
    private readonly brokerOrderDao: BrokerOrderDao,
    private readonly accountDao: AccountDao,
    private readonly orderGroupDao: OrderGroupDao,
  ) {}

  async getBrokerOrder(request: GetBrokerOrderRequest): Promise<GetBrokerOrderResponse> {
    return { brokerOrder: await this.requireBrokerOrder(request.brokerOrderId) };
  }

  async findBrokerOrder(brokerOrderId: string): Promise<BrokerOrder | null> {
    const { brokerOrder } = await this.brokerOrderDao.getBrokerOrder({ brokerOrderId });
    return brokerOrder;
  }

  async createBrokerOrder(request: CreateBrokerOrderRequest): Promise<CreateBrokerOrderResponse> {
    await this.requireAccount(request.accountId);
    if (request.groupId !== undefined) {
      await this.requireOrderGroup(request.groupId);
    }
    logger.info(
      `Recording ${request.broker} order ${request.brokerOrderId} (${request.status}) for account ${request.accountId}${request.groupId === undefined ? ' with no group' : ` in group ${request.groupId}`}.`,
    );
    return await this.brokerOrderDao.createBrokerOrder(request);
  }

  /** At most one search property, for the same index-coverage reason as order groups. */
  async listBrokerOrders(request: ListBrokerOrdersRequest): Promise<ListBrokerOrdersResponse> {
    const searchProperties: ReadonlyArray<SearchProperty> = [
      { name: 'accountId', value: request.accountId },
      { name: 'brokerAccountId', value: request.brokerAccountId },
      { name: 'symbol', value: request.symbol },
      { name: 'status', value: request.status },
    ];
    const provided = searchProperties.filter((property) => property.value !== undefined).map((property) => property.name);

    if (provided.length > 1) {
      throw new InvalidRequestError(`Listing broker orders accepts at most one search property, got ${provided.length} (${provided.join(', ')}). Pick one.`);
    }
    return await this.brokerOrderDao.listBrokerOrders(request);
  }

  async listBrokerOrdersByGroupId(request: ListBrokerOrdersByGroupIdRequest): Promise<ListBrokerOrdersByGroupIdResponse> {
    return await this.brokerOrderDao.listBrokerOrdersByGroupId({ groupIds: [request.groupId] });
  }

  async listOrphanBrokerOrders(_request: ListOrphanBrokerOrdersRequest = {}): Promise<ListOrphanBrokerOrdersResponse> {
    return await this.brokerOrderDao.listOrphanBrokerOrders({});
  }

  async setStatus(request: SetBrokerOrderStatusRequest): Promise<SetBrokerOrderStatusResponse> {
    const { brokerOrder } = await this.brokerOrderDao.setStatus(request);
    if (brokerOrder === null) {
      throw new NotFoundError(`Broker order ${request.brokerOrderId} does not exist, so its status cannot be set to ${request.status}.`);
    }
    return {};
  }

  /**
   * Binds an order to a group, and only if it has none.
   *
   * An order's group never changes: a leg order can arrive before the tracking request
   * that names its group, but once bound it stays bound. The guard lives in the UPDATE
   * rather than here, so a concurrent late report cannot slip between a read and a
   * write.
   */
  async setGroupId(request: SetBrokerOrderGroupIdRequest): Promise<SetBrokerOrderGroupIdResponse> {
    await this.requireBrokerOrder(request.brokerOrderId);
    await this.requireOrderGroup(request.groupId);
    const { brokerOrder } = await this.brokerOrderDao.setGroupId(request);
    if (brokerOrder === null) {
      logger.warn(`Broker order ${request.brokerOrderId} is already in a group, so it was not bound to ${request.groupId}.`);
      return { bound: false };
    }
    logger.info(`Bound broker order ${request.brokerOrderId} to group ${request.groupId}.`);
    return { bound: true };
  }

  /**
   * Deletes the order and its records. The transactions it produced are left alone:
   * they are the record of shares that actually moved, and removing them would leave
   * the position they built unexplained.
   */
  async deleteBrokerOrder(request: DeleteBrokerOrderRequest): Promise<DeleteBrokerOrderResponse> {
    await this.requireBrokerOrder(request.brokerOrderId);
    logger.info(`Deleting broker order ${request.brokerOrderId} and its records.`);
    await this.brokerOrderDao.deleteBrokerOrder(request);
    return {};
  }

  async insertRecord(request: InsertBrokerOrderRecordRequest): Promise<InsertBrokerOrderRecordResponse> {
    return await this.brokerOrderDao.insertRecord({ brokerOrderId: request.record.id, record: request.record });
  }

  async listRecords(request: ListBrokerOrderRecordsRequest): Promise<ListBrokerOrderRecordsResponse> {
    await this.requireBrokerOrder(request.brokerOrderId);
    return await this.brokerOrderDao.listRecords(request);
  }

  private async requireBrokerOrder(brokerOrderId: string): Promise<BrokerOrder> {
    const { brokerOrder } = await this.brokerOrderDao.getBrokerOrder({ brokerOrderId });
    if (brokerOrder === null) {
      throw new NotFoundError(`Broker order ${brokerOrderId} does not exist.`);
    }
    return brokerOrder;
  }

  private async requireOrderGroup(groupId: string): Promise<void> {
    const { orderGroup } = await this.orderGroupDao.getOrderGroup({ groupId });
    if (orderGroup === null) {
      throw new NotFoundError(`Order group ${groupId} does not exist.`);
    }
  }

  private async requireAccount(accountId: string): Promise<void> {
    const { account } = await this.accountDao.getAccount({ accountId });
    if (account === null) {
      throw new NotFoundError(`Account ${accountId} does not exist. List accounts to see which ids are in use.`);
    }
  }
}
