import {
  ActivateAccountRequest,
  ActivateAccountResponse,
  AppendDocumentsRequest,
  AppendDocumentsResponse,
  CloseOrderGroupRequest,
  CloseOrderGroupResponse,
  CreateAccountRequest,
  CreateAccountResponse,
  CreateOrderGroupRequest,
  CreateOrderGroupResponse,
  DeactivateAccountRequest,
  DeactivateAccountResponse,
  DeleteAccountRequest,
  DeleteAccountResponse,
  DeleteBrokerOrderRequest,
  DeleteBrokerOrderResponse,
  DeleteOrderGroupRequest,
  DeleteOrderGroupResponse,
  GetAccountRequest,
  GetAccountResponse,
  GetBrokerOrderRequest,
  GetBrokerOrderResponse,
  GetOrderGroupRequest,
  GetOrderGroupResponse,
  GetPositionRequest,
  GetPositionResponse,
  GetProfitRequest,
  GetProfitResponse,
  ListAccountsRequest,
  ListAccountsResponse,
  ListBrokerOrderRecordsRequest,
  ListBrokerOrderRecordsResponse,
  ListBrokerOrdersByGroupIdRequest,
  ListBrokerOrdersByGroupIdResponse,
  ListBrokerOrdersRequest,
  ListBrokerOrdersResponse,
  ListDividendsRequest,
  ListDividendsResponse,
  ListHistoricalPositionsRequest,
  ListHistoricalPositionsResponse,
  ListOrderGroupsRequest,
  ListOrderGroupsResponse,
  ListOrphanBrokerOrdersRequest,
  ListOrphanBrokerOrdersResponse,
  ListPositionsRequest,
  ListPositionsResponse,
  ListProfitsRequest,
  ListProfitsResponse,
  ListTransactionsByReferenceIdRequest,
  ListTransactionsByReferenceIdResponse,
  ListTransactionsRequest,
  ListTransactionsResponse,
  PingRequest,
  PingResponse,
  StockSplitRequest,
  StockSplitResponse,
  TransferPositionRequest,
  TransferPositionResponse,
  UpdateAccountNameRequest,
  UpdateAccountNameResponse,
} from '@fleece/shared';
import { HttpClient, HttpClientProps } from './http-client';

/**
 * The typed surface of the Fleece API.
 *
 * Every method takes exactly one Request interface and returns one Response
 * interface, both from `@fleece/shared` — the CLI and any UI compile against the same
 * contract the service implements, so a contract change is a build failure rather than
 * a runtime 400.
 *
 * This covers the read and management surface only. Applying fills, recording
 * dividends and creating broker orders are not here because they are not HTTP
 * endpoints: the injector and the corporate-action job hold `@fleece/core` directly.
 */
export class FleeceClient {
  private readonly http: HttpClient;

  constructor(props: HttpClientProps) {
    this.http = new HttpClient(props);
  }

  // ---- health ----

  async ping(_request: PingRequest = {}): Promise<PingResponse> {
    return this.http.request('GET', '/ping');
  }

  // ---- accounts ----

  async createAccount(request: CreateAccountRequest): Promise<CreateAccountResponse> {
    return this.http.request('POST', '/account', { body: request });
  }

  async getAccount(request: GetAccountRequest): Promise<GetAccountResponse> {
    return this.http.request('GET', '/account', { query: { accountId: request.accountId } });
  }

  async listAccounts(request: ListAccountsRequest = {}): Promise<ListAccountsResponse> {
    return this.http.request('GET', '/accounts', { query: { status: request.status } });
  }

  async updateAccountName(request: UpdateAccountNameRequest): Promise<UpdateAccountNameResponse> {
    return this.http.request('PUT', '/account/name', { query: { accountId: request.accountId }, body: { name: request.name } });
  }

  async activateAccount(request: ActivateAccountRequest): Promise<ActivateAccountResponse> {
    return this.http.request('PUT', '/account/activate', { query: { accountId: request.accountId } });
  }

  async deactivateAccount(request: DeactivateAccountRequest): Promise<DeactivateAccountResponse> {
    return this.http.request('PUT', '/account/deactivate', { query: { accountId: request.accountId } });
  }

  async deleteAccount(request: DeleteAccountRequest): Promise<DeleteAccountResponse> {
    return this.http.request('DELETE', '/account', { query: { accountId: request.accountId, force: request.force } });
  }

  // ---- positions ----

  async listPositions(request: ListPositionsRequest): Promise<ListPositionsResponse> {
    return this.http.request('GET', '/positions', { query: { accountId: request.accountId, includeClosed: request.includeClosed } });
  }

  async getPosition(request: GetPositionRequest): Promise<GetPositionResponse> {
    return this.http.request('GET', '/position', { query: { accountId: request.accountId, symbol: request.symbol } });
  }

  async listHistoricalPositions(request: ListHistoricalPositionsRequest): Promise<ListHistoricalPositionsResponse> {
    return this.http.request('GET', '/historical-positions', {
      query: { accountId: request.accountId, symbol: request.symbol, from: request.from, limit: request.limit, sort: request.sort },
    });
  }

  async stockSplit(request: StockSplitRequest): Promise<StockSplitResponse> {
    return this.http.request('PUT', '/position/split', { body: request });
  }

  async transferPosition(request: TransferPositionRequest): Promise<TransferPositionResponse> {
    return this.http.request('POST', '/position/transfer', { body: request });
  }

  // ---- profits ----

  async listProfits(request: ListProfitsRequest): Promise<ListProfitsResponse> {
    return this.http.request('GET', '/profits', { query: { accountId: request.accountId } });
  }

  async getProfit(request: GetProfitRequest): Promise<GetProfitResponse> {
    return this.http.request('GET', '/profit', { query: { accountId: request.accountId, symbol: request.symbol } });
  }

  // ---- transactions ----

  async listTransactions(request: ListTransactionsRequest): Promise<ListTransactionsResponse> {
    return this.http.request('GET', '/transactions', {
      query: { accountId: request.accountId, symbol: request.symbol, from: request.from, limit: request.limit, sort: request.sort },
    });
  }

  async listTransactionsByReferenceId(request: ListTransactionsByReferenceIdRequest): Promise<ListTransactionsByReferenceIdResponse> {
    return this.http.request('GET', '/transactions', { query: { referenceId: request.referenceId } });
  }

  // ---- dividends ----

  async listDividends(request: ListDividendsRequest): Promise<ListDividendsResponse> {
    return this.http.request('GET', '/dividends', { query: { accountId: request.accountId, symbol: request.symbol } });
  }

  // ---- order groups ----

  async createOrderGroup(request: CreateOrderGroupRequest): Promise<CreateOrderGroupResponse> {
    return this.http.request('POST', '/order-group', { body: request });
  }

  async getOrderGroup(request: GetOrderGroupRequest): Promise<GetOrderGroupResponse> {
    return this.http.request('GET', '/order-group', { query: { groupId: request.groupId } });
  }

  async listOrderGroups(request: ListOrderGroupsRequest): Promise<ListOrderGroupsResponse> {
    return this.http.request('GET', '/order-groups', {
      query: {
        accountId: request.accountId,
        correlationType: request.correlationType,
        correlationId: request.correlationId,
        symbol: request.symbol,
        status: request.status,
        startTimestamp: request.startTimestamp,
        endTimestamp: request.endTimestamp,
      },
    });
  }

  async closeOrderGroup(request: CloseOrderGroupRequest): Promise<CloseOrderGroupResponse> {
    return this.http.request('PUT', '/order-group/close', { query: { groupId: request.groupId } });
  }

  async deleteOrderGroup(request: DeleteOrderGroupRequest): Promise<DeleteOrderGroupResponse> {
    return this.http.request('DELETE', '/order-group', { query: { groupId: request.groupId } });
  }

  async appendDocuments(request: AppendDocumentsRequest): Promise<AppendDocumentsResponse> {
    return this.http.request('PUT', '/order-group/documents', { body: request });
  }

  // ---- broker orders ----

  async getBrokerOrder(request: GetBrokerOrderRequest): Promise<GetBrokerOrderResponse> {
    return this.http.request('GET', '/broker-order', { query: { brokerOrderId: request.brokerOrderId } });
  }

  async listBrokerOrders(request: ListBrokerOrdersRequest): Promise<ListBrokerOrdersResponse> {
    return this.http.request('GET', '/broker-orders', {
      query: {
        accountId: request.accountId,
        brokerAccountId: request.brokerAccountId,
        symbol: request.symbol,
        status: request.status,
        from: request.from,
        limit: request.limit,
        sort: request.sort,
      },
    });
  }

  async listBrokerOrdersByGroupId(request: ListBrokerOrdersByGroupIdRequest): Promise<ListBrokerOrdersByGroupIdResponse> {
    return this.http.request('GET', '/broker-orders-by-group', { query: { groupId: request.groupId } });
  }

  async listOrphanBrokerOrders(_request: ListOrphanBrokerOrdersRequest = {}): Promise<ListOrphanBrokerOrdersResponse> {
    return this.http.request('GET', '/orphan-broker-orders');
  }

  async listBrokerOrderRecords(request: ListBrokerOrderRecordsRequest): Promise<ListBrokerOrderRecordsResponse> {
    return this.http.request('GET', '/broker-order-records', { query: { brokerOrderId: request.brokerOrderId } });
  }

  async deleteBrokerOrder(request: DeleteBrokerOrderRequest): Promise<DeleteBrokerOrderResponse> {
    return this.http.request('DELETE', '/broker-order', { query: { brokerOrderId: request.brokerOrderId } });
  }
}
