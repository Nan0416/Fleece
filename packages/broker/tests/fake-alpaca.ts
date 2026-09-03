import {
  AlpacaOrder,
  AlpacaRestClient,
  AlpacaWsClient,
  AlpacaWsClientStatus,
  CancelOrderInput,
  CancelOrderOutput,
  CreateLimitOrderInput,
  CreateMarketOrderInput,
  CreateOrderOutput,
  CreateOtoOrderInput,
  GetAccountOutput,
  GetAssetInput,
  GetAssetOutput,
  GetOrderInput,
  GetOrderOutput,
  ListOrdersInput,
  ListOrdersOutput,
  ListPositionsOutput,
  OrderEventHandler,
} from '@fleece/alpaca';
import { OrderTrackingClient, TrackBrokerOrdersRequest } from '../src/order-tracking-client';

export function alpacaOrder(overrides: Partial<AlpacaOrder> = {}): AlpacaOrder {
  return {
    id: 'alpaca-order-1',
    client_order_id: '',
    status: 'new',
    time_in_force: 'day',
    order_class: '',
    order_type: 'market',
    type: 'market',
    side: 'buy',
    extended_hours: false,
    asset_id: 'asset-1',
    symbol: 'AAPL',
    asset_class: 'us_equity',
    limit_price: null,
    stop_price: null,
    qty: '10',
    notional: null,
    filled_qty: '0',
    filled_avg_price: null,
    created_at: '2026-09-02T14:30:00Z',
    updated_at: '2026-09-02T14:30:00Z',
    submitted_at: '2026-09-02T14:30:00Z',
    filled_at: null,
    expired_at: null,
    canceled_at: null,
    failed_at: null,
    replaced_at: null,
    replaced_by: null,
    replaces: null,
    legs: null,
    trail_percent: null,
    trail_price: null,
    hwm: null,
    ...overrides,
  };
}

export class FakeAlpacaRestClient implements AlpacaRestClient {
  buyingPower = '100000';
  positions: ListPositionsOutput['positions'] = [];
  openOrders: ReadonlyArray<AlpacaOrder> = [];
  readonly created: Array<CreateMarketOrderInput | CreateLimitOrderInput | CreateOtoOrderInput> = [];
  readonly cancelled: string[] = [];
  /** Set to make the next create throw, standing in for a rejected request. */
  failNextCreate?: Error;
  nextOrder: AlpacaOrder = alpacaOrder();

  async getOrder(_input: GetOrderInput): Promise<GetOrderOutput> {
    return { order: null };
  }

  async listOrders(_input: ListOrdersInput): Promise<ListOrdersOutput> {
    return { orders: this.openOrders };
  }

  async getAccount(): Promise<GetAccountOutput> {
    return { account: { id: 'a', account_number: 'PA1', status: 'ACTIVE', cash: '1000', equity: '1000', buying_power: this.buyingPower } };
  }

  async listPositions(): Promise<ListPositionsOutput> {
    return { positions: this.positions };
  }

  async getAsset(input: GetAssetInput): Promise<GetAssetOutput> {
    return {
      asset: {
        id: 'asset-1',
        symbol: input.symbol,
        name: input.symbol,
        exchange: 'NASDAQ',
        class: 'us_equity',
        status: 'active',
        tradable: true,
        marginable: true,
        shortable: true,
        easy_to_borrow: true,
      },
    };
  }

  async createMarketOrder(input: CreateMarketOrderInput): Promise<CreateOrderOutput> {
    return this.create(input);
  }

  async createLimitOrder(input: CreateLimitOrderInput): Promise<CreateOrderOutput> {
    return this.create(input);
  }

  async createOtoOrder(input: CreateOtoOrderInput): Promise<CreateOrderOutput> {
    return this.create(input);
  }

  async cancelOrder(input: CancelOrderInput): Promise<CancelOrderOutput> {
    this.cancelled.push(input.brokerOrderId);
    return {};
  }

  private create(input: CreateMarketOrderInput): CreateOrderOutput {
    if (this.failNextCreate !== undefined) {
      const err = this.failNextCreate;
      this.failNextCreate = undefined;
      throw err;
    }
    this.created.push(input);
    return { order: { ...this.nextOrder, client_order_id: input.clientOrderId ?? '' } };
  }
}

export class FakeAlpacaWsClient implements AlpacaWsClient {
  private handlers = new Map<string, OrderEventHandler>();
  private nextId = 1;

  async init(): Promise<void> {}
  async terminate(): Promise<void> {}
  getStatus(): AlpacaWsClientStatus {
    return { connected: true, authorization: 'passed' };
  }

  addOrderEventHandler(handler: OrderEventHandler): string {
    const id = `handler-${this.nextId++}`;
    this.handlers.set(id, handler);
    return id;
  }

  removeOrderEventHandler(id: string): void {
    this.handlers.delete(id);
  }

  get handlerCount(): number {
    return this.handlers.size;
  }

  /** Pushes an event as the stream would. */
  emit(order: AlpacaOrder): void {
    for (const handler of this.handlers.values()) {
      handler(order);
    }
  }
}

export class RecordingOrderTrackingClient implements OrderTrackingClient {
  readonly requests: TrackBrokerOrdersRequest[] = [];
  failNext?: Error;

  async trackBrokerOrders(request: TrackBrokerOrdersRequest): Promise<void> {
    if (this.failNext !== undefined) {
      const err = this.failNext;
      this.failNext = undefined;
      throw err;
    }
    this.requests.push(request);
  }
}
