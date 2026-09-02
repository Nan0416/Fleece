import {
  AppendDocumentsRequest,
  AppendDocumentsResponse,
  CloseOrderGroupRequest,
  CloseOrderGroupResponse,
  CreateOrderGroupRequest,
  CreateOrderGroupResponse,
  DeleteOrderGroupRequest,
  DeleteOrderGroupResponse,
  Document,
  GetOrderGroupRequest,
  GetOrderGroupResponse,
  InvalidRequestError,
  ListOrderGroupsRequest,
  ListOrderGroupsResponse,
  LoggerFactory,
  NotFoundError,
  OrderGroup,
} from '@fleece/shared';
import { AccountDao } from '../data/account-dao';
import { OrderGroupDao } from '../data/order-group-dao';

const logger = LoggerFactory.getLogger('OrderGroupService');

export class OrderGroupService {
  constructor(
    private readonly orderGroupDao: OrderGroupDao,
    private readonly accountDao: AccountDao,
  ) {}

  async createOrderGroup(request: CreateOrderGroupRequest): Promise<CreateOrderGroupResponse> {
    await this.requireAccount(request.accountId);
    const groupId = crypto.randomUUID();
    logger.info(`Creating order group ${groupId} for account ${request.accountId}, correlation type "${request.correlationType}".`);
    await this.orderGroupDao.createOrderGroup({
      groupId,
      // A group is always findable by correlation, so one is generated when the
      // caller has no id of its own to key on.
      correlationId: request.correlationId ?? crypto.randomUUID(),
      correlationType: request.correlationType,
      status: 'open',
      accountId: request.accountId,
    });
    return { groupId };
  }

  async getOrderGroup(request: GetOrderGroupRequest): Promise<GetOrderGroupResponse> {
    return { orderGroup: await this.requireOrderGroup(request.groupId) };
  }

  /**
   * Exactly one search property, and a time window with it unless that property is
   * `correlationId`.
   *
   * The restriction is about indexes, not taste: each search property has an index
   * paired with the creation timestamp, so one property plus a window is a range scan.
   * Two properties, or a property with no window, is a sequential scan over the whole
   * table — which the legacy service refused rather than served slowly, and so does
   * this. `symbol` is a refinement rather than a search property and does not count.
   */
  async listOrderGroups(request: ListOrderGroupsRequest): Promise<ListOrderGroupsResponse> {
    const windowed: ReadonlyArray<readonly [string, unknown]> = [
      ['accountId', request.accountId],
      ['correlationType', request.correlationType],
      ['status', request.status],
    ];
    const provided = windowed.filter(([, value]) => value !== undefined).map(([name]) => name);
    const hasCorrelationId = request.correlationId !== undefined;
    const searchProperties = provided.length + (hasCorrelationId ? 1 : 0);

    if (searchProperties === 0) {
      throw new InvalidRequestError('Listing order groups needs one search property: accountId, correlationType, correlationId or status.');
    }
    if (searchProperties > 1) {
      throw new InvalidRequestError(`Listing order groups accepts one search property, got ${searchProperties}. Pick one of accountId, correlationType, correlationId or status.`);
    }

    const hasWindow = request.startTimestamp !== undefined && request.endTimestamp !== undefined;
    if (hasCorrelationId) {
      if (request.startTimestamp !== undefined || request.endTimestamp !== undefined) {
        throw new InvalidRequestError('Searching by correlationId is already selective, so it cannot be combined with a time window. Drop startTimestamp and endTimestamp.');
      }
    } else if (!hasWindow) {
      throw new InvalidRequestError(`Searching by ${provided[0]} needs both startTimestamp and endTimestamp, so the query stays bounded.`);
    }

    return await this.orderGroupDao.listOrderGroups(request);
  }

  async closeOrderGroup(request: CloseOrderGroupRequest): Promise<CloseOrderGroupResponse> {
    await this.requireOrderGroup(request.groupId);
    logger.info(`Closing order group ${request.groupId}.`);
    await this.orderGroupDao.setStatus({ groupId: request.groupId, status: 'closed' });
    return {};
  }

  async deleteOrderGroup(request: DeleteOrderGroupRequest): Promise<DeleteOrderGroupResponse> {
    await this.requireOrderGroup(request.groupId);
    logger.info(`Deleting order group ${request.groupId}, along with its broker orders and their records.`);
    await this.orderGroupDao.deleteOrderGroup({ groupId: request.groupId });
    return {};
  }

  /** Upserts by `documentId`: a document already on the group is replaced, not duplicated. */
  async appendDocuments(request: AppendDocumentsRequest): Promise<AppendDocumentsResponse> {
    const group = await this.requireOrderGroup(request.groupId);

    const byDocumentId = new Map<string, Document>();
    for (const document of group.documents ?? []) {
      byDocumentId.set(document.documentId, document);
    }
    for (const document of request.documents) {
      byDocumentId.set(document.documentId, document);
    }

    logger.info(`Appending ${request.documents.length} document(s) to order group ${request.groupId}; it now has ${byDocumentId.size}.`);
    await this.orderGroupDao.setDocuments({ groupId: request.groupId, documents: [...byDocumentId.values()] });
    return {};
  }

  private async requireOrderGroup(groupId: string): Promise<OrderGroup> {
    const { orderGroup } = await this.orderGroupDao.getOrderGroup({ groupId });
    if (orderGroup === null) {
      throw new NotFoundError(`Order group ${groupId} does not exist.`);
    }
    return orderGroup;
  }

  private async requireAccount(accountId: string): Promise<void> {
    const { account } = await this.accountDao.getAccount({ accountId });
    if (account === null) {
      throw new NotFoundError(`Account ${accountId} does not exist. List accounts to see which ids are in use.`);
    }
  }
}
