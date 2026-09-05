import {
  ActivateAccountRequest,
  ActivateAccountResponse,
  assertInteger,
  assertNonEmptyString,
  assertOneOf,
  assertRecord,
  CreateAccountRequest,
  CreateAccountResponse,
  DeactivateAccountRequest,
  DeactivateAccountResponse,
  DeleteAccountRequest,
  DeleteAccountResponse,
  DeleteBrokerOrderRequest,
  DeleteBrokerOrderResponse,
  GetAccountRequest,
  GetAccountResponse,
  GetBrokerOrderRequest,
  GetBrokerOrderResponse,
  GetOrderFillProgressRequest,
  GetOrderFillProgressResponse,
  GetPositionRequest,
  GetPositionResponse,
  GetProfitRequest,
  GetProfitResponse,
  ListAccountsRequest,
  ListAccountsResponse,
  ListBrokerOrderLegsRequest,
  ListBrokerOrderLegsResponse,
  ListBrokerOrderRecordsRequest,
  ListBrokerOrderRecordsResponse,
  ListBrokerOrdersRequest,
  ListBrokerOrdersResponse,
  ListDividendsRequest,
  ListDividendsResponse,
  ListHistoricalPositionsRequest,
  ListHistoricalPositionsResponse,
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
  reviveAccount,
  reviveAccounts,
  reviveBrokerOrder,
  reviveBrokerOrderRecords,
  reviveBrokerOrders,
  reviveDividends,
  reviveHistoricalPositions,
  reviveOrderFillProgressList,
  revivePosition,
  revivePositions,
  reviveProfit,
  reviveProfits,
  reviveTransactions,
  StockSplitRequest,
  StockSplitResponse,
  TransferPositionRequest,
  TransferPositionResponse,
  UpdateAccountNameRequest,
  UpdateAccountNameResponse,
} from '@fleece/shared';
import { HttpClient, HttpClientProps } from './http-client';

/**
 * A typed client for the Fleece API.
 *
 * Every method takes the same Request and returns the same Response as the service
 * method behind it, so a caller that compiles is a caller that will not get a runtime
 * 400.
 *
 * **Responses are revived, not cast.** A decimal crosses the wire as a string — a JSON
 * number is a double and would discard the precision the ledger exists to keep — so the
 * JSON that arrives does not have the shape its `Response` type describes, and no cast
 * would give it one. Each method rebuilds its response with the revivers in
 * `@fleece/shared`, which also retires the sanctioned `as` this boundary used to carry.
 *
 * This covers the read and management surface only. Applying fills, recording dividends
 * and recording broker orders are not here because they are not HTTP endpoints: the
 * injector and the corporate-action job hold `@fleece/core` directly.
 */
export class FleeceClient {
  private readonly http: HttpClient;

  constructor(props: HttpClientProps) {
    this.http = new HttpClient(props);
  }

  // ---- health ----

  async ping(_request: PingRequest = {}): Promise<PingResponse> {
    const payload = assertRecord(await this.http.request('GET', '/ping'), 'response');
    return {
      status: assertOneOf(payload['status'], 'status', ['ok'] as const),
      version: assertNonEmptyString(payload['version'], 'version'),
      uptimeSeconds: assertInteger(payload['uptimeSeconds'], 'uptimeSeconds'),
    };
  }

  // ---- accounts ----

  async createAccount(request: CreateAccountRequest): Promise<CreateAccountResponse> {
    const payload = assertRecord(await this.http.request('POST', '/account', { body: request }), 'response');
    return { account: reviveAccount(payload['account']) };
  }

  async getAccount(request: GetAccountRequest): Promise<GetAccountResponse> {
    const payload = assertRecord(await this.http.request('GET', '/account', { query: { accountId: request.accountId } }), 'response');
    return { account: reviveAccount(payload['account']) };
  }

  async listAccounts(request: ListAccountsRequest = {}): Promise<ListAccountsResponse> {
    const payload = assertRecord(await this.http.request('GET', '/accounts', { query: { status: request.status } }), 'response');
    return { accounts: reviveAccounts(payload['accounts']) };
  }

  async updateAccountName(request: UpdateAccountNameRequest): Promise<UpdateAccountNameResponse> {
    await this.http.request('PUT', '/account/name', { query: { accountId: request.accountId }, body: { name: request.name } });
    return {};
  }

  async activateAccount(request: ActivateAccountRequest): Promise<ActivateAccountResponse> {
    await this.http.request('PUT', '/account/activate', { query: { accountId: request.accountId } });
    return {};
  }

  async deactivateAccount(request: DeactivateAccountRequest): Promise<DeactivateAccountResponse> {
    await this.http.request('PUT', '/account/deactivate', { query: { accountId: request.accountId } });
    return {};
  }

  async deleteAccount(request: DeleteAccountRequest): Promise<DeleteAccountResponse> {
    await this.http.request('DELETE', '/account', { query: { accountId: request.accountId, force: request.force } });
    return {};
  }

  // ---- positions ----

  async listPositions(request: ListPositionsRequest): Promise<ListPositionsResponse> {
    const payload = assertRecord(
      await this.http.request('GET', '/positions', { query: { accountId: request.accountId, includeClosed: request.includeClosed, assetClass: request.assetClass } }),
      'response',
    );
    return { positions: revivePositions(payload['positions']) };
  }

  async getPosition(request: GetPositionRequest): Promise<GetPositionResponse> {
    const payload = assertRecord(await this.http.request('GET', '/position', { query: { accountId: request.accountId, symbol: request.symbol } }), 'response');
    return { position: revivePosition(payload['position']) };
  }

  async listHistoricalPositions(request: ListHistoricalPositionsRequest): Promise<ListHistoricalPositionsResponse> {
    const payload = assertRecord(
      await this.http.request('GET', '/historical-positions', {
        query: { accountId: request.accountId, symbol: request.symbol, from: request.from, limit: request.limit, sort: request.sort },
      }),
      'response',
    );
    return { positions: reviveHistoricalPositions(payload['positions']) };
  }

  /**
   * `ratio` and the transfer's `unitCost` and `size` are `Decimal`s, and
   * `JSON.stringify` turns each into its exact string on the way out — which is what
   * the service refuses to accept as a JSON number.
   */
  async stockSplit(request: StockSplitRequest): Promise<StockSplitResponse> {
    await this.http.request('PUT', '/position/split', { body: request });
    return {};
  }

  async transferPosition(request: TransferPositionRequest): Promise<TransferPositionResponse> {
    await this.http.request('POST', '/position/transfer', { body: request });
    return {};
  }

  // ---- profits ----

  async listProfits(request: ListProfitsRequest): Promise<ListProfitsResponse> {
    const payload = assertRecord(await this.http.request('GET', '/profits', { query: { accountId: request.accountId } }), 'response');
    return { profits: reviveProfits(payload['profits']) };
  }

  async getProfit(request: GetProfitRequest): Promise<GetProfitResponse> {
    const payload = assertRecord(await this.http.request('GET', '/profit', { query: { accountId: request.accountId, symbol: request.symbol } }), 'response');
    return { profit: reviveProfit(payload['profit']) };
  }

  // ---- transactions ----

  async listTransactions(request: ListTransactionsRequest): Promise<ListTransactionsResponse> {
    const payload = assertRecord(
      await this.http.request('GET', '/transactions', {
        query: { accountId: request.accountId, symbol: request.symbol, from: request.from, limit: request.limit, sort: request.sort },
      }),
      'response',
    );
    return { transactions: reviveTransactions(payload['transactions']) };
  }

  async listTransactionsByReferenceId(request: ListTransactionsByReferenceIdRequest): Promise<ListTransactionsByReferenceIdResponse> {
    const payload = assertRecord(await this.http.request('GET', '/transactions', { query: { referenceId: request.referenceId } }), 'response');
    return { transactions: reviveTransactions(payload['transactions']) };
  }

  // ---- dividends ----

  async listDividends(request: ListDividendsRequest): Promise<ListDividendsResponse> {
    const payload = assertRecord(await this.http.request('GET', '/dividends', { query: { accountId: request.accountId, symbol: request.symbol } }), 'response');
    return { dividends: reviveDividends(payload['dividends']) };
  }

  // ---- broker orders ----

  async getBrokerOrder(request: GetBrokerOrderRequest): Promise<GetBrokerOrderResponse> {
    const payload = assertRecord(await this.http.request('GET', '/broker-order', { query: { brokerOrderId: request.brokerOrderId } }), 'response');
    return { brokerOrder: reviveBrokerOrder(payload['brokerOrder']) };
  }

  /**
   * At most one search property, plus a time window — the service rejects more, because
   * each property has an index paired with `created_at` and anything else is a table
   * scan.
   *
   * This is also how orders nobody claimed are found: they are the ones the injector
   * booked to a configured catch-all account, so `accountId` is the search property.
   */
  async listBrokerOrders(request: ListBrokerOrdersRequest): Promise<ListBrokerOrdersResponse> {
    const payload = assertRecord(
      await this.http.request('GET', '/broker-orders', {
        query: {
          accountId: request.accountId,
          brokerAccountId: request.brokerAccountId,
          symbol: request.symbol,
          status: request.status,
          assetClass: request.assetClass,
          from: request.from,
          limit: request.limit,
          sort: request.sort,
        },
      }),
      'response',
    );
    return { brokerOrders: reviveBrokerOrders(payload['brokerOrders']) };
  }

  /** The contracts of one spread. The parent need not have a row of its own. */
  async listBrokerOrderLegs(request: ListBrokerOrderLegsRequest): Promise<ListBrokerOrderLegsResponse> {
    const payload = assertRecord(await this.http.request('GET', '/broker-order-legs', { query: { parentBrokerOrderId: request.parentBrokerOrderId } }), 'response');
    return { brokerOrders: reviveBrokerOrders(payload['brokerOrders']) };
  }

  /**
   * What the ledger has booked against an order, in ledger units — which is a different
   * number from the `filledQty` the broker reported, and named differently so that
   * nothing accounts from the wrong one.
   *
   * `reconciled` is false when the stored counter no longer agrees with the transactions
   * it counts.
   */
  async getOrderFillProgress(request: GetOrderFillProgressRequest): Promise<GetOrderFillProgressResponse> {
    const payload = assertRecord(await this.http.request('GET', '/broker-order-fill-progress', { query: { referenceId: request.referenceId } }), 'response');
    return {
      progress: reviveOrderFillProgressList(payload['progress']),
      reconciled: payload['reconciled'] === true,
    };
  }

  async listBrokerOrderRecords(request: ListBrokerOrderRecordsRequest): Promise<ListBrokerOrderRecordsResponse> {
    const payload = assertRecord(await this.http.request('GET', '/broker-order-records', { query: { brokerOrderId: request.brokerOrderId } }), 'response');
    return { records: reviveBrokerOrderRecords(payload['records']) };
  }

  async deleteBrokerOrder(request: DeleteBrokerOrderRequest): Promise<DeleteBrokerOrderResponse> {
    await this.http.request('DELETE', '/broker-order', { query: { brokerOrderId: request.brokerOrderId } });
    return {};
  }
}
