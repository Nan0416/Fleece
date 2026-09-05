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
  CreateMultiLegOrderInput,
  CreateOtoOrderInput,
  GetAccountOutput,
  GetAssetInput,
  GetAssetOutput,
  GetOptionContractInput,
  GetOptionContractOutput,
  GetOrderInput,
  GetOrderOutput,
  ListOrdersInput,
  ListOrdersOutput,
  ListPositionsOutput,
  OrderEventHandler,
} from '@fleece/alpaca';
import { TrackBrokerOrdersRequest } from '@fleece/shared';
import { OrderTrackingClient } from '../src/l2/order-tracking-client';

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

/**
 * A spread, in the shape Alpaca really returns one: a parent with **no symbol and no
 * price of its own**, and the contracts nested inside it.
 *
 * The parent's `side` is `'buy'` and means nothing — a spread has no direction — which is
 * exactly what makes seeding a tracker from it produce a position keyed on `''` with a
 * size signed from a coin toss. Its `limit_price` is negative because this vertical is
 * sold for a credit.
 */
export function multiLegOrder(parent: Partial<AlpacaOrder> = {}, shortLeg: Partial<AlpacaOrder> = {}, longLeg: Partial<AlpacaOrder> = {}): AlpacaOrder {
  const leg = (overrides: Partial<AlpacaOrder>): AlpacaOrder =>
    alpacaOrder({ asset_class: 'us_option', order_class: 'mleg', order_type: 'limit', type: 'limit', qty: '1', ratio_qty: '1', limit_price: null, ...overrides });

  return alpacaOrder({
    id: 'mleg-parent',
    symbol: '',
    asset_class: '',
    order_class: 'mleg',
    order_type: 'limit',
    type: 'limit',
    limit_price: '-0.85',
    qty: '1',
    legs: [
      leg({ id: 'mleg-leg-short', symbol: SHORT_LEG_SYMBOL, side: 'sell', position_intent: 'sell_to_open', ...shortLeg }),
      leg({ id: 'mleg-leg-long', symbol: LONG_LEG_SYMBOL, side: 'buy', position_intent: 'buy_to_open', ...longLeg }),
    ],
    ...parent,
  });
}

export const SHORT_LEG_SYMBOL = 'AMZN261016C00280000';
export const LONG_LEG_SYMBOL = 'AMZN261016C00285000';

/** The same spread, filled: a net credit of 0.9 made of 3.85 sold and 2.95 paid. */
export function filledMultiLegOrder(): AlpacaOrder {
  return multiLegOrder(
    { status: 'filled', filled_qty: '1', filled_avg_price: '-0.9' },
    { status: 'filled', filled_qty: '1', filled_avg_price: '3.85' },
    { status: 'filled', filled_qty: '1', filled_avg_price: '2.95' },
  );
}

export class FakeAlpacaRestClient implements AlpacaRestClient {
  buyingPower = '100000';
  positions: ListPositionsOutput['positions'] = [];
  openOrders: ReadonlyArray<AlpacaOrder> = [];
  readonly created: Array<CreateMarketOrderInput | CreateLimitOrderInput | CreateOtoOrderInput | CreateMultiLegOrderInput> = [];
  readonly cancelled: string[] = [];

  /**
   * The placements in a single instrument, narrowed.
   *
   * A spread's input has no `symbol` and no `side` — the contracts carry them — so the
   * union has to be split before either can be read. A predicate rather than a cast:
   * guideline 18, and the property tested is the one the narrowing claims.
   */
  get createdSingle(): ReadonlyArray<CreateMarketOrderInput | CreateLimitOrderInput | CreateOtoOrderInput> {
    return this.created.filter(isSingleInstrumentInput);
  }
  /** Set to make the next create throw, standing in for a rejected request. */
  failNextCreate?: Error;
  nextOrder: AlpacaOrder = alpacaOrder();
  /** What a spread placement comes back as. Legs included, as Alpaca returns them. */
  nextMultiLegOrder: AlpacaOrder = multiLegOrder();

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

  async createMultiLegOrder(input: CreateMultiLegOrderInput): Promise<CreateOrderOutput> {
    if (this.failNextCreate !== undefined) {
      const err = this.failNextCreate;
      this.failNextCreate = undefined;
      throw err;
    }
    this.created.push(input);
    return { order: { ...this.nextMultiLegOrder, client_order_id: input.clientOrderId ?? '' } };
  }

  async getOptionContract(input: GetOptionContractInput): Promise<GetOptionContractOutput> {
    return {
      contract: {
        id: 'contract-1',
        symbol: input.symbolOrId.toUpperCase(),
        name: input.symbolOrId.toUpperCase(),
        status: 'active',
        tradable: true,
        expiration_date: '2026-10-16',
        root_symbol: 'AMZN',
        underlying_symbol: 'AMZN',
        underlying_asset_id: 'underlying-1',
        type: 'call',
        style: 'american',
        strike_price: '280',
        multiplier: '100',
        size: '100',
      },
    };
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

function isSingleInstrumentInput(
  input: CreateMarketOrderInput | CreateLimitOrderInput | CreateOtoOrderInput | CreateMultiLegOrderInput,
): input is CreateMarketOrderInput | CreateLimitOrderInput | CreateOtoOrderInput {
  return 'symbol' in input;
}
