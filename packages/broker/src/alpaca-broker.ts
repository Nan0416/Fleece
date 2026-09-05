import {
  AlpacaAccountIdentifier,
  AlpacaActiveSynchronization,
  AlpacaOrder,
  AlpacaRestClient,
  AlpacaWsClient,
  alpacaOrderAssetClass,
  convertAlpacaOrderToBrokerOrderEvents,
  encodeAlpacaOrderCorrelation,
} from '@fleece/alpaca';
import { BrokerOrderEvent, Decimal, defaultContractMultiplier, InvalidRequestError, LoggerFactory } from '@fleece/shared';
import { AccountBrokerTracker } from './account-broker-tracker';
import { AlpacaOrderHandle } from './alpaca-order-handle';
import { EventDispatcher } from './event-dispatcher';
import { Asset, Broker } from './models/broker';
import { BrokerUnavailableError } from './models/errors';
import { OrderObj, OtoOrderObj } from './models/order-obj';
import { LimitOrderRequest, MarketOrderRequest, OrderRequest, OtoRequest } from './models/requests';
import { BrokerPosition, PendingOrder, ReservationRequest } from './models/trackers';
import { OrderTrackingClient } from './order-tracking-client';

const logger = LoggerFactory.getLogger('AlpacaBroker');

export interface AlpacaBrokerProps {
  readonly account: AlpacaAccountIdentifier;
  readonly restClient: AlpacaRestClient;
  readonly wsClient: AlpacaWsClient;
  readonly activeSync: AlpacaActiveSynchronization;
  readonly orderTrackingClient: OrderTrackingClient;
  readonly now?: () => number;
}

/**
 * Places orders at one Alpaca account.
 *
 * Every order follows the same five steps, and the order of them is the point:
 *
 * 1. **Reserve** the buying power or shares, before anything is sent. A rejected
 *    reservation is cheap; an oversubscribed account is not.
 * 2. **Encode** the virtual account into `client_order_id`, so every event Alpaca sends
 *    back says whose the order is.
 * 3. **Send** it. If the request fails, release the reservation — nothing was placed.
 * 4. **Register** with the poller and the dispatcher, so an order Alpaca accepts and
 *    then never mentions is still noticed.
 * 5. **Tell the ledger** which account the resulting broker orders belong to, which is
 *    the only way an order Fleece could not stamp a correlation onto is attributed.
 *
 * The legacy also ran an order-correction layer that synthesised missing `new` events
 * and deduplicated. It is not ported: the legacy's own last commit removed it "in order
 * to display the true events received from broker", and deduplication now happens where
 * it belongs — in the position tracker's session comparison, and again in the ledger's
 * idempotent fill path.
 */
export class AlpacaBroker implements Broker {
  readonly tracker: AccountBrokerTracker;
  private readonly dispatcher: EventDispatcher;
  private orderEventHandlerId?: string;

  constructor(private readonly props: AlpacaBrokerProps) {
    this.tracker = new AccountBrokerTracker({ brokerAccountId: props.account.accountId, now: props.now });
    this.dispatcher = new EventDispatcher(props.account.accountId);
  }

  get brokerAccountId(): string {
    return this.props.account.accountId;
  }

  get live(): boolean {
    return this.props.account.live;
  }

  get source(): string {
    return 'alpaca';
  }

  /**
   * Seeds the tracker from the broker's own view, then starts listening.
   *
   * Both halves matter. Without the positions and open orders, the first order placed
   * after a restart would be measured against an account believed to be empty.
   */
  async init(): Promise<void> {
    const { account } = await this.props.restClient.getAccount();
    const buyingPower = this.parseAmount(account.buying_power, `buying power for account ${this.brokerAccountId}`);
    if (!buyingPower.isPositive()) {
      throw new BrokerUnavailableError(`Alpaca reported buying power of "${account.buying_power}" for account ${this.brokerAccountId}, which cannot be traded against.`);
    }

    const { positions } = await this.props.restClient.listPositions();
    const bySymbol = new Map<string, { positionSize: Decimal; totalCost: Decimal; pendingOrders: PendingOrder[] }>();

    for (const position of positions) {
      // `cost_basis` rather than size times price: Alpaca has already multiplied an
      // option's premium out into dollars, and taking it as given avoids both a
      // multiplication and the question of what the contract's multiplier is.
      bySymbol.set(position.symbol, {
        positionSize: this.parseAmount(position.qty, `${position.symbol} position size`),
        totalCost: this.parseAmount(position.cost_basis, `${position.symbol} cost basis`),
        pendingOrders: [],
      });
    }

    const { orders } = await this.props.restClient.listOrders({ status: 'open', nested: true });
    const openOrders = positionHoldingOrders(orders);
    for (const order of openOrders) {
      let entry = bySymbol.get(order.symbol);
      if (entry === undefined) {
        // An open order in a symbol not held: a buy that has not filled, or a short
        // that has not opened.
        entry = { positionSize: Decimal.ZERO, totalCost: Decimal.ZERO, pendingOrders: [] };
        bySymbol.set(order.symbol, entry);
      }
      entry.pendingOrders.push(this.toPendingOrder(order));
    }

    const brokerPositions: BrokerPosition[] = [...bySymbol.entries()].map(([symbol, entry]) => ({ symbol, ...entry }));
    this.tracker.setup(buyingPower, brokerPositions);

    // The poller feeds the same path as the websocket. Nothing deduplicates between
    // them here, because everything downstream already tolerates a repeat.
    this.props.activeSync.onEvent = (order) => {
      logger.warn(`Recovered order ${order.id} for Alpaca ${this.brokerAccountId} by polling; the stream did not deliver it.`);
      this.consume(order);
    };
    this.props.activeSync.start();

    this.orderEventHandlerId = this.props.wsClient.addOrderEventHandler((order) => {
      this.props.activeSync.track(order);
      this.consume(order);
    });

    logger.info(
      `Alpaca broker ${this.brokerAccountId} ready: ${buyingPower.toString()} buying power, ${positions.length} position(s), ${openOrders.length} open order(s) holding one.`,
    );
  }

  async terminate(): Promise<void> {
    this.props.activeSync.stop();
    if (this.orderEventHandlerId !== undefined) {
      this.props.wsClient.removeOrderEventHandler(this.orderEventHandlerId);
      this.orderEventHandlerId = undefined;
    }
    this.dispatcher.clear();
    logger.info(`Alpaca broker ${this.brokerAccountId} terminated.`);
  }

  async asset(symbol: string): Promise<Asset | undefined> {
    const { asset } = await this.props.restClient.getAsset({ symbol });
    if (asset === null) {
      return undefined;
    }
    return {
      symbol: asset.symbol,
      // Tradable *and* active: Alpaca keeps delisted assets with `tradable` still true.
      tradable: asset.tradable && asset.status === 'active',
      shortable: asset.shortable && asset.easy_to_borrow,
      marginable: asset.marginable,
      lastUpdatedAt: (this.props.now ?? Date.now)(),
    };
  }

  order(request: MarketOrderRequest): Promise<OrderObj>;
  order(request: LimitOrderRequest): Promise<OrderObj>;
  order(request: OtoRequest): Promise<OtoOrderObj>;
  async order(request: OrderRequest): Promise<OrderObj | OtoOrderObj> {
    // Non-zero is the whole rule. A whole number is not required: Alpaca fills
    // fractional shares, and refusing them here would reject an order the broker would
    // have accepted.
    if (request.size.isZero()) {
      throw new InvalidRequestError(`Order size must be non-zero, got ${request.size.toString()}.`);
    }

    switch (request.type) {
      case 'market':
        return await this.placeMarket(request);
      case 'limit':
        return await this.placeLimit(request);
      case 'oto':
        return await this.placeOto(request);
    }
  }

  private async placeMarket(request: MarketOrderRequest): Promise<OrderObj> {
    return await this.place(request, async (clientOrderId) => {
      const { order } = await this.props.restClient.createMarketOrder({
        symbol: request.symbol,
        size: toWireSize(request.size),
        side: request.size.isPositive() ? 'buy' : 'sell',
        clientOrderId,
      });
      return order;
    });
  }

  private async placeLimit(request: LimitOrderRequest): Promise<OrderObj> {
    return await this.place(request, async (clientOrderId) => {
      const { order } = await this.props.restClient.createLimitOrder({
        symbol: request.symbol,
        size: toWireSize(request.size),
        side: request.size.isPositive() ? 'buy' : 'sell',
        limitPrice: request.limitPrice.toNumber(),
        clientOrderId,
      });
      return order;
    });
  }

  /**
   * A one-triggers-other pair.
   *
   * Alpaca returns the exit leg nested inside the entry order's response, and assigns
   * it a client order id of its own — so the exit cannot be attributed from a
   * correlation, and the tracking request covering both ids is what places it in the
   * right account.
   */
  private async placeOto(request: OtoRequest): Promise<OtoOrderObj> {
    const reservationId = this.tracker.reserve(this.reservationFor(request, request.limitPrice));
    let entry: AlpacaOrder;
    try {
      const clientOrderId = encodeAlpacaOrderCorrelation({ virtualAccountId: request.accountId, reservationId });
      const { order } = await this.props.restClient.createOtoOrder({
        symbol: request.symbol,
        size: toWireSize(request.size),
        side: request.size.isPositive() ? 'buy' : 'sell',
        limitPrice: request.limitPrice.toNumber(),
        takeProfitLimitPrice: request.takeProfitLimitPrice.toNumber(),
        clientOrderId,
      });
      entry = order;
    } catch (err) {
      this.tracker.cancel(reservationId);
      throw err;
    }

    const exit = entry.legs?.[0];
    if (exit === undefined) {
      throw new BrokerUnavailableError(`Alpaca accepted OTO order ${entry.id} but returned no take-profit leg, so the exit cannot be tracked.`);
    }

    const entryHandle = this.attach(entry.id, request, request.onEvent);
    const exitHandle = this.attach(exit.id, request, request.onTakeProfitEvent);
    await this.announce(request, [entry.id, exit.id]);

    return { entryOrder: entryHandle, exitOrder: exitHandle };
  }

  /** The shape every single-order placement shares. */
  private async place(request: MarketOrderRequest | LimitOrderRequest, send: (clientOrderId: string) => Promise<AlpacaOrder>): Promise<OrderObj> {
    const unitPrice = request.type === 'limit' ? request.limitPrice : request.unitPrice;
    const reservationId = this.tracker.reserve(this.reservationFor(request, unitPrice));

    let placed: AlpacaOrder;
    try {
      placed = await send(encodeAlpacaOrderCorrelation({ virtualAccountId: request.accountId, reservationId }));
    } catch (err) {
      // Nothing reached the broker, so nothing should stay held.
      this.tracker.cancel(reservationId);
      throw err;
    }

    const handle = this.attach(placed.id, request, request.onEvent);
    await this.announce(request, [placed.id]);
    return handle;
  }

  private reservationFor(request: OrderRequest, unitPrice: Decimal | undefined): ReservationRequest {
    return { symbol: request.symbol, size: request.size, assetClass: request.assetClass, unitPrice, multiplier: request.multiplier };
  }

  private attach(brokerOrderId: string, request: OrderRequest, onEvent: OrderRequest['onEvent']): AlpacaOrderHandle {
    const handle = new AlpacaOrderHandle(
      { symbol: request.symbol, brokerOrderId, accountId: request.accountId, brokerAccountId: this.brokerAccountId, onEvent },
      this.props.restClient,
    );
    // Registered with the dispatcher first: events queued while the placement response
    // was in flight are released the moment the handle exists.
    this.dispatcher.register(handle);
    this.props.activeSync.register(brokerOrderId);
    return handle;
  }

  /**
   * Failure here is logged, not thrown: the order is placed, and the shares are moving
   * whether or not the ledger has been told which account they belong to. Throwing
   * would leave the caller believing the order failed.
   */
  private async announce(request: OrderRequest, brokerOrderIds: ReadonlyArray<string>): Promise<void> {
    try {
      await this.props.orderTrackingClient.trackBrokerOrders({ brokerOrderIds, accountId: request.accountId });
    } catch (err) {
      logger.error(`Placed ${brokerOrderIds.join(', ')} but could not tell the ledger they belong to account ${request.accountId}.`, err);
    }
  }

  /**
   * A composite order now arrives as a parent event plus one per leg, and every one of
   * them is tracked and dispatched. That is the honest consequence of flattening: a leg
   * is a real order, and hiding it here would make this class look option-aware when its
   * reservations are not.
   *
   * The parent carries no instrument, and `AccountBrokerTracker.track` drops it for that
   * reason — a spread holds no position of its own, and its legs are what moved.
   */
  private consume(order: AlpacaOrder): void {
    let events: ReadonlyArray<BrokerOrderEvent>;
    try {
      events = convertAlpacaOrderToBrokerOrderEvents(order, this.props.account);
    } catch (err) {
      logger.error(`Could not convert Alpaca order ${order.id} on account ${this.brokerAccountId}.`, err);
      return;
    }
    for (const event of events) {
      this.tracker.track(event);
      this.dispatcher.dispatch(event);
    }
  }

  /**
   * Reads an already-open order into the shape the tracker seeds from.
   *
   * The limit price is carried through, which the legacy did not: it parsed and
   * validated `order.limit_price` and then hard-coded `limitPrice: 0` into the pending
   * order. The effect was that after a restart, every open limit buy reserved zero
   * buying power — so the account could be oversubscribed by exactly the orders it
   * already had working.
   */
  private toPendingOrder(order: AlpacaOrder): PendingOrder {
    const requested = this.parseAmount(order.qty, `open order ${order.id} qty`);
    const filled = this.parseAmount(order.filled_qty, `open order ${order.id} filled_qty`);
    if (filled.isNegative()) {
      throw new BrokerUnavailableError(`Alpaca reported open order ${order.id} with a filled quantity of ${order.filled_qty}.`);
    }

    const sign = order.side === 'buy' ? Decimal.ONE : Decimal.ONE.neg();
    const multiplier = defaultContractMultiplier(alpacaOrderAssetClass(order));
    const partialFilledSize = sign.mul(filled);
    const filledPrice = order.filled_avg_price === null ? undefined : this.parseAmount(order.filled_avg_price, `open order ${order.id} filled_avg_price`);
    const limitPrice = order.limit_price === null ? undefined : this.parseAmount(order.limit_price, `open order ${order.id} limit_price`);

    return {
      brokerOrderId: order.id,
      unfilledSize: sign.mul(requested.sub(filled)),
      partialFilledSize,
      partialTotalCost: filledPrice === undefined ? Decimal.ZERO : partialFilledSize.mul(filledPrice).mul(multiplier),
      limitPrice: limitPrice !== undefined && limitPrice.isPositive() ? limitPrice : undefined,
      multiplier,
    };
  }

  /**
   * Alpaca sends every quantity and price as a string. A number that cannot be read is
   * the broker being unusable rather than a bug here, so it surfaces as a retryable
   * `BrokerUnavailableError` rather than as the `InternalServiceError` `Decimal.of`
   * raises.
   */
  private parseAmount(value: string, context: string): Decimal {
    try {
      return Decimal.of(value);
    } catch {
      throw new BrokerUnavailableError(`Alpaca reported "${value}" as the ${context} on account ${this.brokerAccountId}, which is not a number.`);
    }
  }
}

/**
 * Alpaca's size is unsigned, and this is where the sign becomes a `side`.
 *
 * Going through `number` is lossy in principle and not in practice: `@fleece/alpaca`
 * writes it back out with `toString()`, which produces the shortest decimal that
 * round-trips, and a share count needs nowhere near the digits that costs. The honest
 * fix is for the placement API to take strings, which is a change to that package.
 */
function toWireSize(size: Decimal): number {
  return size.abs().toNumber();
}

/**
 * Every open order that holds a position, with composite parents left out.
 *
 * A spread's parent trades no instrument of its own: Alpaca leaves its symbol empty and
 * gives it a side that means nothing. Seeding a tracker from one creates a position
 * keyed on the empty string whose size is signed from that meaningless side — the same
 * shape of wrong number the converter's `undefined` symbol exists to prevent. Its legs
 * are real orders in real contracts, and they are what the account has actually
 * committed.
 *
 * Bracket and OTO parents are kept: they trade an instrument, and so do their legs.
 */
function positionHoldingOrders(orders: ReadonlyArray<AlpacaOrder>): ReadonlyArray<AlpacaOrder> {
  const flattened: AlpacaOrder[] = [];
  for (const order of orders) {
    if (order.symbol !== '') {
      flattened.push(order);
    }
    flattened.push(...positionHoldingOrders(order.legs ?? []));
  }
  return flattened;
}
