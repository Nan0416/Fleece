import { BrokerOrderEvent, Decimal, eventToString, LoggerFactory } from '@fleece/shared';
import { BuyingPowerLedger } from './buying-power';
import { BrokerPosition, BrokerTracker, ReservationRequest, TestResult } from '../models/trackers';
import { SymbolPositionTracker } from './symbol-position-tracker';

const logger = LoggerFactory.getLogger('AccountBrokerTracker');

export interface AccountBrokerTrackerProps {
  readonly brokerAccountId: string;
  readonly now?: () => number;
}

/**
 * One broker account: its buying power, and a position tracker per symbol.
 *
 * Buying power lives here rather than being summed from the symbol trackers because it
 * is genuinely shared — a buy in AAPL reduces what is available for MSFT. The symbol
 * trackers hold units, which are not.
 */
export class AccountBrokerTracker implements BrokerTracker, BuyingPowerLedger {
  private readonly trackers = new Map<string, SymbolPositionTracker>();
  private readonly reservationOwners = new Map<string, SymbolPositionTracker>();
  private _availableBuyingPower = Decimal.ZERO;
  private initialised = false;

  constructor(private readonly props: AccountBrokerTrackerProps) {}

  get availableBuyingPower(): Decimal {
    return this._availableBuyingPower;
  }

  setup(buyingPower: Decimal, positions: ReadonlyArray<BrokerPosition>): void {
    if (this.initialised) {
      throw new Error(`The tracker for broker account ${this.props.brokerAccountId} is already set up.`);
    }
    this.initialised = true;
    this._availableBuyingPower = buyingPower;

    for (const position of positions) {
      if (this.trackers.has(position.symbol)) {
        throw new Error(`The broker reported ${position.symbol} twice for account ${this.props.brokerAccountId}.`);
      }
      const tracker = this.trackerFor(position.symbol);
      tracker.setup(position.positionSize, position.totalCost, position.pendingOrders);
    }

    logger.info(`Broker account ${this.props.brokerAccountId}: ${buyingPower.toString()} buying power, ${positions.length} position(s).`);
  }

  test(request: ReservationRequest): TestResult | undefined {
    return this.trackerFor(request.symbol).test(request);
  }

  reserve(request: ReservationRequest): string {
    const tracker = this.trackerFor(request.symbol);
    const reservationId = tracker.reserve(request);
    // Remembered so `cancel` can find the owner from the id alone — the caller holds a
    // reservation id and nothing else.
    this.reservationOwners.set(reservationId, tracker);
    return reservationId;
  }

  expectOrder(symbol: string, brokerOrderId: string): void {
    this.trackerFor(symbol).expectOrder(brokerOrderId);
  }

  cancel(reservationId: string): void {
    this.reservationOwners.get(reservationId)?.cancel(reservationId);
  }

  track(event: BrokerOrderEvent): void {
    // A composite order's parent trades no instrument of its own: its size counts
    // spreads rather than contracts, and its price is the package's signed net. There
    // is no position for it to move. Booking it would open one keyed on nothing, at a
    // price no contract traded at — and its legs arrive as events of their own, each
    // naming a real instrument, so nothing is lost by ignoring it.
    const { symbol } = event;
    if (symbol === undefined) {
      logger.debug(`Ignoring ${eventToString(event)} on account ${this.props.brokerAccountId}: a composite parent holds no position, and its legs carry the fills.`);
      return;
    }

    // No setup required: an event for a symbol never seen is not an error, it is an
    // externally placed order, and dropping it would leave the account's own view of
    // itself wrong.
    this.initialised = true;
    this.trackerFor(symbol).track(event);
  }

  onAvailableBuyingPowerChange(delta: Decimal): void {
    this._availableBuyingPower = this._availableBuyingPower.add(delta);
    if (this._availableBuyingPower.isNegative()) {
      // Reachable when a market order fills above the price it reserved against, or
      // when it reserved nothing because no estimate was given. Worth saying: the next
      // order will be refused, and the reason is here rather than at that call site.
      logger.warn(`Broker account ${this.props.brokerAccountId} buying power is ${this._availableBuyingPower.toString()}: a fill cost more than was reserved for it.`);
    }
  }

  onReservationComplete(reservationId: string): void {
    this.reservationOwners.delete(reservationId);
  }

  /** For inspection and tests; the account does not otherwise expose its symbols. */
  positionTracker(symbol: string): SymbolPositionTracker | undefined {
    return this.trackers.get(symbol);
  }

  private trackerFor(symbol: string): SymbolPositionTracker {
    const existing = this.trackers.get(symbol);
    if (existing !== undefined) {
      return existing;
    }
    const tracker = new SymbolPositionTracker({ symbol, brokerAccountId: this.props.brokerAccountId, buyingPower: this, now: this.props.now });
    this.trackers.set(symbol, tracker);
    return tracker;
  }
}
