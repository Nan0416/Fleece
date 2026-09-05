import { AlpacaAccountIdentifier, AlpacaOrder, alpacaOrderAssetClass, AlpacaRestClient } from '@fleece/alpaca';
import { BrokerOrderEvent, Decimal, defaultContractMultiplier, LoggerFactory } from '@fleece/shared';
import { BrokerUnavailableError } from '../errors';
import { BrokerPosition, PendingOrder, ReservationRequest } from './trackers';
import { AccountBrokerTracker } from './account-broker-tracker';

const logger = LoggerFactory.getLogger('AccountReservations');

/** All this needs of the client: the account's own view of itself. It places nothing. */
export type AccountSnapshotReader = Pick<AlpacaRestClient, 'getAccount' | 'listPositions' | 'listOrders'>;

export interface AccountReservationsProps {
  readonly account: AlpacaAccountIdentifier;
  readonly reader: AccountSnapshotReader;
  readonly now?: () => number;
}

/**
 * The bookkeeping that keeps concurrent strategies from oversubscribing one real broker
 * account: the tracker, the startup seeding that makes it true, and the hold taken
 * around a placement.
 *
 * **It is optional to the broker, and that is the design.** `L3BrokerOrderClient` takes one or
 * takes none. Without it every order goes out unheld — which is wrong for a strategy
 * sharing an account, and exactly right for an instrument whose requirement nothing here
 * can compute. Isolating it here is what keeps a spread placeable without pretending its
 * margin is known: see `md/OPEN-ITEMS.md` item 2b.
 *
 * Seeding is the other half. Without the positions and open orders the broker already
 * has, the first order placed after a restart would be measured against an account
 * believed to be empty.
 */
export class AccountReservations {
  readonly tracker: AccountBrokerTracker;

  constructor(private readonly props: AccountReservationsProps) {
    this.tracker = new AccountBrokerTracker({ brokerAccountId: props.account.accountId, now: props.now });
  }

  get availableBuyingPower(): Decimal {
    return this.tracker.availableBuyingPower;
  }

  /** Reads the broker's own view of the account into the tracker. Once, at startup. */
  async seed(): Promise<void> {
    const { account } = await this.props.reader.getAccount();
    const buyingPower = this.parseAmount(account.buying_power, `buying power for account ${this.brokerAccountId}`);
    if (!buyingPower.isPositive()) {
      throw new BrokerUnavailableError(`Alpaca reported buying power of "${account.buying_power}" for account ${this.brokerAccountId}, which cannot be traded against.`);
    }

    const { positions } = await this.props.reader.listPositions();
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

    const { orders } = await this.props.reader.listOrders({ status: 'open', nested: true });
    const openOrders = positionHoldingOrders(orders);
    for (const order of openOrders) {
      let entry = bySymbol.get(order.symbol);
      if (entry === undefined) {
        // An open order in a symbol not held: a buy that has not filled, or a short that
        // has not opened.
        entry = { positionSize: Decimal.ZERO, totalCost: Decimal.ZERO, pendingOrders: [] };
        bySymbol.set(order.symbol, entry);
      }
      entry.pendingOrders.push(this.toPendingOrder(order));
    }

    const brokerPositions: BrokerPosition[] = [...bySymbol.entries()].map(([symbol, entry]) => ({ symbol, ...entry }));
    this.tracker.setup(buyingPower, brokerPositions);

    logger.info(
      `Reservations for ${this.brokerAccountId}: ${buyingPower.toString()} buying power, ${positions.length} position(s), ${openOrders.length} open order(s) holding one.`,
    );
  }

  /**
   * Takes the hold an order needs, before it is sent.
   *
   * It takes a `ReservationRequest` rather than L3's order request, and that is what
   * keeps the dependency one-way: this layer knows about a symbol, a signed size and a
   * price, and nothing about market orders, spreads or event handlers. L3 does the
   * translation, and is also where an order this cannot price at all — a spread — is
   * recognised as having no reservation to ask for.
   *
   * It **throws** when the account cannot support the order, and when the order is one
   * the tracker refuses to price: a short option, whose requirement is margin against an
   * unbounded loss.
   */
  hold(request: ReservationRequest): string {
    return this.tracker.reserve(request);
  }

  /**
   * Notes an order that went out without a hold, so the account still learns what it
   * fills. Called with the contracts of a spread, which is the only thing placed unheld.
   */
  expectOrder(symbol: string, brokerOrderId: string): void {
    this.tracker.expectOrder(symbol, brokerOrderId);
  }

  /** Gives back a hold whose order never reached the broker. */
  release(reservationId: string): void {
    this.tracker.cancel(reservationId);
  }

  track(event: BrokerOrderEvent): void {
    this.tracker.track(event);
  }

  private get brokerAccountId(): string {
    return this.props.account.accountId;
  }

  /**
   * Reads an already-open order into the shape the tracker seeds from.
   *
   * The limit price is carried through, which the legacy did not: it parsed and validated
   * `order.limit_price` and then hard-coded `limitPrice: 0` into the pending order. The
   * effect was that after a restart, every open limit buy reserved zero buying power — so
   * the account could be oversubscribed by exactly the orders it already had working.
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
 * Every open order that holds a position, with composite parents left out.
 *
 * A spread's parent trades no instrument of its own: Alpaca leaves its symbol empty and
 * gives it a side that means nothing. Seeding a tracker from one creates a position keyed
 * on the empty string whose size is signed from that meaningless side — the same shape of
 * wrong number the converter's `undefined` symbol exists to prevent. Its legs are real
 * orders in real contracts, and they are what the account has actually committed.
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
