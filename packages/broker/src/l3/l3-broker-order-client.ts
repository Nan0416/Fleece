import { AlpacaAccountIdentifier, AlpacaActiveSynchronization, AlpacaOrder, AlpacaRestClient, AlpacaWsClient, convertAlpacaOrderToBrokerOrderEvents } from '@fleece/alpaca';
import { BrokerOrderEvent, Decimal, InvalidRequestError, LoggerFactory } from '@fleece/shared';
import { Asset, Broker } from './broker';
import { BrokerUnavailableError } from '../errors';
import { MultiLegOrderObj, OtoOrderObj, SingleOrderObj } from './order-obj';
import { BrokerOrderClient, CreatedOrder } from '../l1/broker-order-client';
import { LimitOrderRequest, MarketOrderRequest, MultiLegOrderRequest, OrderRequest, OtoRequest, SingleOrderEventHandler } from './requests';
import { BrokerTracker, ReservationRequest } from '../reservations/trackers';
import { AccountReservations } from '../reservations/account-reservations';
import { EventDispatcher } from './event-dispatcher';
import { MultiLegOrderHandle, OrderLegHandle } from './multi-leg-order-handle';
import { OtoPlacement, SingleOrderHandle } from './order-handle';

const logger = LoggerFactory.getLogger('L3BrokerOrderClient');

/** All this needs of the client beyond placing: whether an instrument can be traded. */
export type AssetReader = Pick<AlpacaRestClient, 'getAsset'>;

export interface L3BrokerOrderClientProps {
  readonly account: AlpacaAccountIdentifier;
  /** L1, or L2 wrapping it, or a reserving decorator wrapping either. */
  readonly placer: BrokerOrderClient;
  readonly assets: AssetReader;
  readonly wsClient: AlpacaWsClient;
  readonly activeSync: AlpacaActiveSynchronization;
  /** Omit to place without holding anything. See `AccountReservations`. */
  readonly reservations?: AccountReservations;
  readonly now?: () => number;
}

/**
 * **L3.** Fleece's own vocabulary, and a live handle on every order placed.
 *
 * Everything below is the broker's: unsigned sizes, a `side`, prices as numbers, one
 * order per call and nothing remembered about it. Here a size is a signed `Decimal`, a
 * spread is one request rather than four, and what comes back is an object that keeps
 * receiving events until the order is done.
 *
 * The order of the steps in `order` is the point:
 *
 * 1. **Hold** the buying power or shares, before anything is sent. A rejected hold is
 *    cheap; an oversubscribed account is not. Skipped entirely when no `reservations` is
 *    installed, which is how a spread — whose requirement nothing here can compute — is
 *    placeable at all.
 * 2. **Send**, through the placer stack, which encodes the virtual account and announces
 *    it. If the request fails, the hold is released — nothing was placed.
 * 3. **Attach** a handle, register it with the dispatcher and the poller, and hand it
 *    back. The dispatcher first: events queued while the placement response was in
 *    flight are released the moment the handle exists.
 *
 * The legacy also ran an order-correction layer that synthesised missing `new` events
 * and deduplicated. It is not ported: the legacy's own last commit removed it "in order
 * to display the true events received from broker", and deduplication now happens where
 * it belongs — in the position tracker's session comparison, and again in the ledger's
 * idempotent fill path.
 */
export class L3BrokerOrderClient implements Broker {
  private readonly dispatcher: EventDispatcher;
  private orderEventHandlerId?: string;

  constructor(private readonly props: L3BrokerOrderClientProps) {
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

  /** Undefined when nothing holds anything against this account. */
  get tracker(): BrokerTracker | undefined {
    return this.props.reservations?.tracker;
  }

  /**
   * Seeds the reservations from the broker's own view, then starts listening.
   *
   * Both halves matter, and the seeding half is skipped along with the reservations it
   * belongs to: an account that holds nothing back needs no view of what it holds.
   */
  async init(): Promise<void> {
    await this.props.reservations?.seed();

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

    logger.info(`Alpaca broker ${this.brokerAccountId} ready${this.props.reservations === undefined ? ', holding nothing against placements' : ''}.`);
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
    const { asset } = await this.props.assets.getAsset({ symbol });
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

  order(request: MarketOrderRequest): Promise<SingleOrderObj>;
  order(request: LimitOrderRequest): Promise<SingleOrderObj>;
  order(request: OtoRequest): Promise<OtoOrderObj>;
  order(request: MultiLegOrderRequest): Promise<MultiLegOrderObj>;
  async order(request: OrderRequest): Promise<SingleOrderObj | OtoOrderObj | MultiLegOrderObj> {
    validate(request);

    const reservationId = this.hold(request);
    let placed: CreatedOrder;
    try {
      placed = await this.send(request, reservationId);
    } catch (err) {
      // Nothing reached the broker, so nothing should stay held. Without this a run of
      // failed placements silently exhausts the account.
      if (reservationId !== undefined) {
        this.props.reservations?.release(reservationId);
      }
      throw err;
    }

    return this.attach(request, placed.order);
  }

  /**
   * Turns an order request into the hold it needs, and takes it.
   *
   * The translation lives here rather than in `AccountReservations` so the dependency
   * runs one way: reservations know about a symbol, a signed size and a price, and
   * nothing about order types or event handlers.
   *
   * A spread has no hold to ask for. Its requirement is the width rather than the sum of
   * its legs, and no model here computes that — so it goes out unheld, and says so,
   * because an unheld order can oversubscribe the account and nothing downstream will
   * mention it. See `md/OPEN-ITEMS.md` item 2b.
   */
  private hold(request: OrderRequest): string | undefined {
    if (this.props.reservations === undefined) {
      return undefined;
    }
    if (request.type === 'mleg') {
      logger.warn(
        `Placing a ${request.legs.length}-leg spread for account ${request.accountId} with nothing held against it: a spread's requirement is the width rather than the sum of its legs, and no model here computes that. See md/OPEN-ITEMS.md item 2b.`,
      );
      return undefined;
    }

    const reservation: ReservationRequest = {
      symbol: request.symbol,
      size: request.size,
      assetClass: request.assetClass,
      unitPrice: request.type === 'market' ? request.unitPrice : request.limitPrice,
      multiplier: request.multiplier,
    };
    return this.props.reservations.hold(reservation);
  }

  private async send(request: OrderRequest, reservationId: string | undefined): Promise<CreatedOrder> {
    const identity = { accountId: request.accountId, reservationId };

    switch (request.type) {
      case 'market':
        return await this.props.placer.createMarketOrder({
          ...identity,
          symbol: request.symbol,
          size: toWireSize(request.size),
          side: sideOf(request.size),
          positionIntent: request.positionIntent,
        });
      case 'limit':
        return await this.props.placer.createLimitOrder({
          ...identity,
          symbol: request.symbol,
          size: toWireSize(request.size),
          side: sideOf(request.size),
          limitPrice: request.limitPrice.toNumber(),
          positionIntent: request.positionIntent,
        });
      case 'oto':
        return await this.props.placer.createOtoOrder({
          ...identity,
          symbol: request.symbol,
          size: toWireSize(request.size),
          side: sideOf(request.size),
          limitPrice: request.limitPrice.toNumber(),
          takeProfitLimitPrice: request.takeProfitLimitPrice.toNumber(),
          positionIntent: request.positionIntent,
        });
      case 'mleg':
        return await this.props.placer.createMultiLegOrder({
          ...identity,
          size: toWireSize(request.size),
          netLimitPrice: request.netLimitPrice?.toNumber(),
          legs: request.legs.map((leg) => ({ symbol: leg.symbol, ratioQty: leg.ratioQty.toNumber(), side: leg.side, positionIntent: leg.positionIntent })),
        });
    }
  }

  private attach(request: OrderRequest, placed: AlpacaOrder): SingleOrderObj | OtoOrderObj | MultiLegOrderObj {
    switch (request.type) {
      case 'market':
      case 'limit': {
        const handle = this.singleHandle(request.symbol, placed.id, request.accountId, request.onEvent);
        this.dispatcher.register(handle);
        this.props.activeSync.register(placed.id);
        return handle;
      }

      case 'oto': {
        // Alpaca returns the exit nested inside the entry and assigns it a client order
        // id of its own, so the exit is attributed from its parent's correlation.
        const exit = placed.legs?.[0];
        if (exit === undefined) {
          throw new BrokerUnavailableError(`Alpaca accepted OTO order ${placed.id} but returned no take-profit leg, so the exit cannot be tracked.`);
        }
        const entryHandle = this.singleHandle(request.symbol, placed.id, request.accountId, request.onEvent);
        const exitHandle = this.singleHandle(request.symbol, exit.id, request.accountId, request.onTakeProfitEvent);
        this.dispatcher.register(new OtoPlacement(entryHandle, exitHandle));
        this.props.activeSync.register(placed.id);
        // Registered too, because the websocket sends no event for an OTO's exit at
        // all: the poll is the only thing that will ever report it.
        this.props.activeSync.register(exit.id);
        return { entryOrder: entryHandle, exitOrder: exitHandle };
      }

      case 'mleg': {
        const handle = this.multiLegHandle(request, placed);
        // Nothing was held for the spread, so nothing would recognise its contracts when
        // they fill — and a marketable spread fills at once, which is the one shape
        // `track` refuses to adopt. Naming them here is what makes the account see them.
        for (const leg of handle.legs) {
          this.props.reservations?.expectOrder(leg.symbol, leg.brokerOrderId);
        }
        this.dispatcher.register(handle);
        // The parent only. A poll of it returns the contracts nested inside, so
        // registering each of them would be the same order fetched three times.
        this.props.activeSync.register(placed.id);
        return handle;
      }
    }
  }

  private singleHandle(symbol: string, brokerOrderId: string, accountId: string, onEvent: SingleOrderEventHandler): SingleOrderHandle {
    return new SingleOrderHandle({ symbol, brokerOrderId, accountId, onEvent, canceller: this.props.placer });
  }

  /**
   * Pairs what was asked for with what came back.
   *
   * Built in the order the legs were requested, and matched on symbol rather than on
   * position, because Alpaca does not promise to return them in the order they were
   * sent. A leg that cannot be paired is refused: a spread whose contracts are not the
   * ones asked for is not a spread anybody can reason about.
   */
  private multiLegHandle(request: MultiLegOrderRequest, parent: AlpacaOrder): MultiLegOrderHandle {
    const returned = new Map((parent.legs ?? []).map((leg) => [leg.symbol, leg]));
    if (returned.size !== request.legs.length) {
      throw new BrokerUnavailableError(
        `Alpaca accepted spread ${parent.id} but returned ${returned.size} distinct contract(s) for the ${request.legs.length} requested, so its legs cannot be tracked.`,
      );
    }

    const legs = request.legs.map((leg) => {
      const placed = returned.get(leg.symbol);
      if (placed === undefined) {
        throw new BrokerUnavailableError(`Alpaca accepted spread ${parent.id} but returned no leg in ${leg.symbol}, which it was asked to trade.`);
      }
      return new OrderLegHandle({
        brokerOrderId: placed.id,
        parentBrokerOrderId: parent.id,
        accountId: request.accountId,
        symbol: leg.symbol,
        ratioQty: leg.ratioQty,
      });
    });

    return new MultiLegOrderHandle({ brokerOrderId: parent.id, accountId: request.accountId, legs, onEvent: request.onEvent, canceller: this.props.placer });
  }

  /**
   * One Alpaca payload becomes one converted list, and the whole list travels together.
   *
   * A composite order arrives as a parent plus one event per leg, and every one of them
   * is tracked and dispatched. That is the honest consequence of flattening: a leg is a
   * real order. The parent carries no instrument, and `AccountBrokerTracker.track` drops
   * it for that reason — a spread holds no position of its own, and its legs are what
   * moved.
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
      this.props.reservations?.track(event);
    }
    this.dispatcher.dispatch(events);
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

function sideOf(size: Decimal): 'buy' | 'sell' {
  return size.isPositive() ? 'buy' : 'sell';
}

function validate(request: OrderRequest): void {
  // Non-zero is the whole rule for a single order. A whole number is not required:
  // Alpaca fills fractional shares, and refusing them here would reject an order the
  // broker would have accepted.
  if (request.size.isZero()) {
    throw new InvalidRequestError(`Order size must be non-zero, got ${request.size.toString()}.`);
  }

  if (request.type !== 'mleg') {
    return;
  }

  if (request.size.isNegative()) {
    throw new InvalidRequestError(`A spread's size counts spreads and is always positive; the direction belongs to each leg. Got ${request.size.toString()}.`);
  }
  if (request.legs.length < 2 || request.legs.length > 4) {
    throw new InvalidRequestError(`A spread has two to four legs, got ${request.legs.length}.`);
  }
  for (const leg of request.legs) {
    if (!leg.ratioQty.isPositive()) {
      throw new InvalidRequestError(`Leg ${leg.symbol} has a ratio quantity of ${leg.ratioQty.toString()}; it counts contracts per spread and is always positive.`);
    }
  }
}
