import { InternalServiceError, LoggerFactory, ServiceUnreachableError } from '@fleece/shared';
import {
  AlpacaRestClient,
  CancelOrderInput,
  CancelOrderOutput,
  CreateLimitOrderInput,
  CreateMarketOrderInput,
  CreateOrderOutput,
  CreateOtoOrderInput,
  GetAccountInput,
  GetAccountOutput,
  GetAssetInput,
  GetAssetOutput,
  GetOrderInput,
  GetOrderOutput,
  ListOrdersInput,
  ListOrdersOutput,
  ListPositionsInput,
  ListPositionsOutput,
} from './alpaca-rest-client';
import { restUrl } from './constants';
import { AlpacaAccount, AlpacaAccountIdentifier, AlpacaAsset, AlpacaCredentialsProvider, AlpacaOrder, AlpacaPosition, resolveCredentials } from './models';
import { RateLimiter } from './rate-limiter';

const logger = LoggerFactory.getLogger('AlpacaRestClient');

export interface HttpAlpacaRestClientProps {
  readonly account: AlpacaAccountIdentifier;
  readonly credentialsProvider: AlpacaCredentialsProvider;
  readonly timeoutMs?: number;
  /** Overrides the URL derived from `account.live`. For tests. */
  readonly baseUrl?: string;
  /**
   * Calls per minute. Alpaca's published cap is 200; the default leaves headroom for
   * anything else sharing the credential. Negative disables limiting.
   */
  readonly maxCallsPerMinute?: number;
}

export class HttpAlpacaRestClient implements AlpacaRestClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  private readonly rateLimiter: RateLimiter;

  constructor(private readonly props: HttpAlpacaRestClientProps) {
    this.baseUrl = props.baseUrl ?? restUrl(props.account.live);
    this.timeoutMs = props.timeoutMs ?? 10_000;
    this.rateLimiter = new RateLimiter(props.maxCallsPerMinute ?? 180);
  }

  async getOrder(input: GetOrderInput): Promise<GetOrderOutput> {
    const response = await this.request('GET', `/v2/orders/${encodeURIComponent(input.brokerOrderId)}`);
    if (response.status === 404) {
      return { order: null };
    }
    return { order: this.narrowOrder(await this.readJson(response, `order ${input.brokerOrderId}`)) };
  }

  async listOrders(input: ListOrdersInput): Promise<ListOrdersOutput> {
    const query = new URLSearchParams();
    if (input.status !== undefined) {
      query.set('status', input.status);
    }
    if (input.limit !== undefined) {
      query.set('limit', String(input.limit));
    }
    if (input.after !== undefined) {
      query.set('after', input.after);
    }
    if (input.direction !== undefined) {
      query.set('direction', input.direction);
    }
    // Without this, the legs of a bracket or OTO order come back as separate top-level
    // orders instead of nested inside their parent.
    query.set('nested', String(input.nested ?? true));

    const response = await this.request('GET', `/v2/orders?${query.toString()}`);
    const payload = await this.readJson(response, 'order list');
    if (!Array.isArray(payload)) {
      throw new InternalServiceError('Alpaca returned a non-array response when listing orders.');
    }
    return { orders: payload.map((entry) => this.narrowOrder(entry)) };
  }

  async getAccount(_input: GetAccountInput = {}): Promise<GetAccountOutput> {
    const response = await this.request('GET', '/v2/account');
    const payload = await this.readJson(response, 'account');
    if (typeof payload !== 'object' || payload === null || typeof Reflect.get(payload, 'buying_power') !== 'string') {
      throw new InternalServiceError('Alpaca returned an account with no buying_power.');
    }
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the boundary with Alpaca's schema; buying_power is checked above and parsed by the caller.
    return { account: payload as AlpacaAccount };
  }

  async listPositions(_input: ListPositionsInput = {}): Promise<ListPositionsOutput> {
    const response = await this.request('GET', '/v2/positions');
    const payload = await this.readJson(response, 'positions');
    if (!Array.isArray(payload)) {
      throw new InternalServiceError('Alpaca returned a non-array response when listing positions.');
    }
    return {
      positions: payload.map((entry) => {
        if (typeof entry !== 'object' || entry === null || typeof Reflect.get(entry, 'symbol') !== 'string') {
          throw new InternalServiceError('Alpaca returned a position with no symbol.');
        }
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the boundary with Alpaca's schema; symbol is checked above and the numeric fields are parsed by the caller.
        return entry as AlpacaPosition;
      }),
    };
  }

  async getAsset(input: GetAssetInput): Promise<GetAssetOutput> {
    const response = await this.request('GET', `/v2/assets/${encodeURIComponent(input.symbol.toUpperCase())}`);
    if (response.status === 404) {
      return { asset: null };
    }
    const payload = await this.readJson(response, `asset ${input.symbol}`);
    if (typeof payload !== 'object' || payload === null || typeof Reflect.get(payload, 'symbol') !== 'string') {
      throw new InternalServiceError(`Alpaca returned an asset for ${input.symbol} with no symbol.`);
    }
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the boundary with Alpaca's schema; symbol is checked above.
    return { asset: payload as AlpacaAsset };
  }

  async createMarketOrder(input: CreateMarketOrderInput): Promise<CreateOrderOutput> {
    return await this.createOrder({ ...this.baseOrderBody(input), type: 'market' });
  }

  async createLimitOrder(input: CreateLimitOrderInput): Promise<CreateOrderOutput> {
    return await this.createOrder({ ...this.baseOrderBody(input), type: 'limit', limit_price: input.limitPrice.toString() });
  }

  async createOtoOrder(input: CreateOtoOrderInput): Promise<CreateOrderOutput> {
    return await this.createOrder({
      ...this.baseOrderBody(input),
      type: 'limit',
      limit_price: input.limitPrice.toString(),
      order_class: 'oto',
      take_profit: { limit_price: input.takeProfitLimitPrice.toString() },
    });
  }

  async cancelOrder(input: CancelOrderInput): Promise<CancelOrderOutput> {
    // 404 is not an error here: cancelling an order that is already gone is the
    // outcome the caller wanted.
    await this.request('DELETE', `/v2/orders/${encodeURIComponent(input.brokerOrderId)}`);
    return {};
  }

  /**
   * `day` and no extended hours, matching the legacy client.
   *
   * Every number is sent as a string, which is Alpaca's convention for prices and
   * quantities in both directions.
   */
  private baseOrderBody(input: CreateMarketOrderInput): Record<string, unknown> {
    const body: Record<string, unknown> = {
      symbol: input.symbol,
      qty: input.size.toString(),
      side: input.side,
      time_in_force: 'day',
      extended_hours: false,
    };
    if (input.clientOrderId !== undefined) {
      body['client_order_id'] = input.clientOrderId;
    }
    return body;
  }

  private async createOrder(body: Record<string, unknown>): Promise<CreateOrderOutput> {
    const response = await this.request('POST', '/v2/orders', body);
    return { order: this.narrowOrder(await this.readJson(response, 'created order')) };
  }

  private async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<Response> {
    // Before the credential is resolved, so waiting for a slot cannot hold a key in
    // memory longer than the call itself.
    await this.rateLimiter.acquire();
    const credentials = await resolveCredentials(this.props.credentialsProvider);

    const headers: Record<string, string> = {
      'APCA-API-KEY-ID': credentials.accessKey,
      'APCA-API-SECRET-KEY': credentials.secretKey,
      accept: 'application/json',
    };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok && response.status !== 404) {
        const body = await response.text();
        logger.warn(`Alpaca ${method} ${path} returned ${response.status}: ${body.slice(0, 500)}`);
        throw new InternalServiceError(`Alpaca ${method} ${path} returned ${response.status}.`);
      }
      return response;
    } catch (err) {
      if (err instanceof InternalServiceError) {
        throw err;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ServiceUnreachableError(`Alpaca ${method} ${path} timed out after ${this.timeoutMs}ms.`);
      }
      throw new ServiceUnreachableError(`Alpaca ${method} ${path} could not be reached: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readJson(response: Response, what: string): Promise<unknown> {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new InternalServiceError(`Alpaca returned a non-JSON response for ${what}.`);
    }
  }

  /**
   * Checked only as far as the fields the converter reads. Alpaca is the authority on
   * its own format, so validating every field would mean reimplementing their schema
   * and breaking whenever they add to it — but an `id` and a `status` that are not
   * strings mean something is fundamentally wrong, and that should surface here rather
   * than as an undefined halfway through the ledger.
   */
  private narrowOrder(payload: unknown): AlpacaOrder {
    if (typeof payload !== 'object' || payload === null) {
      throw new InternalServiceError('Alpaca returned an order that is not an object.');
    }
    const record: Record<string, unknown> = { ...payload };
    if (typeof record['id'] !== 'string' || typeof record['status'] !== 'string' || typeof record['symbol'] !== 'string') {
      throw new InternalServiceError('Alpaca returned an order without an id, status or symbol.');
    }
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the boundary with Alpaca's schema; the fields the converter reads are checked above and in strictParseFloat.
    return payload as AlpacaOrder;
  }
}
