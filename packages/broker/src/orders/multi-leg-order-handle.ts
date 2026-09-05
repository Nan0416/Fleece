import { BrokerOrderEvent, Decimal, eventToString, isTerminalStatus, LoggerFactory } from '@fleece/shared';
import { MultiLegOrderObj, OrderLegView } from '../models/order-obj';
import { MultiLegOrderEventHandler } from '../models/requests';
import { EventSink } from './event-dispatcher';
import { OrderCanceller } from './order-handle';

const logger = LoggerFactory.getLogger('MultiLegOrderHandle');

export interface OrderLegHandleProps {
  readonly brokerOrderId: string;
  readonly parentBrokerOrderId: string;
  readonly accountId: string;
  readonly symbol: string;
  readonly ratioQty: Decimal;
}

/**
 * One contract of a spread.
 *
 * A real order at the broker with its own id, instrument and fills, and no `cancel` —
 * Alpaca will not cancel one contract of a spread, and a method that could only fail is
 * worse than no method.
 */
export class OrderLegHandle implements OrderLegView {
  readonly brokerOrderId: string;
  readonly parentBrokerOrderId: string;
  readonly accountId: string;
  readonly symbol: string;
  readonly ratioQty: Decimal;
  private readonly received: BrokerOrderEvent[] = [];

  constructor(props: OrderLegHandleProps) {
    this.brokerOrderId = props.brokerOrderId;
    this.parentBrokerOrderId = props.parentBrokerOrderId;
    this.accountId = props.accountId;
    this.symbol = props.symbol;
    this.ratioQty = props.ratioQty;
  }

  get events(): ReadonlyArray<BrokerOrderEvent> {
    return this.received;
  }

  get latestEvent(): BrokerOrderEvent | undefined {
    return this.received[this.received.length - 1];
  }

  get settled(): boolean {
    const latest = this.latestEvent;
    return latest !== undefined && isTerminalStatus(latest.status);
  }

  /** Called by the parent handle as it absorbs a payload. */
  record(event: BrokerOrderEvent): void {
    this.received.push(event);
  }
}

export interface MultiLegOrderHandleProps {
  readonly brokerOrderId: string;
  readonly accountId: string;
  readonly legs: ReadonlyArray<OrderLegHandle>;
  readonly onEvent: MultiLegOrderEventHandler;
  readonly canceller: OrderCanceller;
}

/**
 * The caller's handle on a spread: the order that was placed, and the contracts it is
 * made of.
 *
 * **The parent is the order, and the legs are what it holds.** That is not a modelling
 * preference, it is what the broker offers. The id a placement returns and a cancel names
 * is the parent's; the instruments, fills and prices are the legs'. Modelling a spread as
 * a handful of peer orders would give each of them a `cancel` that cannot work and leave
 * the net price — the number the spread actually traded at — with nowhere to live.
 *
 * **One notification per payload.** Everything is updated from the message before the
 * handler runs, so a caller asked "what happened?" sees the whole spread as the broker
 * described it, never a parent that has filled beside a contract that has not heard.
 */
export class MultiLegOrderHandle implements MultiLegOrderObj, EventSink {
  readonly kind = 'multi-leg';
  readonly brokerOrderId: string;
  readonly accountId: string;
  readonly legs: ReadonlyArray<OrderLegHandle>;
  private readonly received: BrokerOrderEvent[] = [];

  constructor(private readonly props: MultiLegOrderHandleProps) {
    this.brokerOrderId = props.brokerOrderId;
    this.accountId = props.accountId;
    this.legs = props.legs;
  }

  get events(): ReadonlyArray<BrokerOrderEvent> {
    return this.received;
  }

  get latestEvent(): BrokerOrderEvent | undefined {
    return this.received[this.received.length - 1];
  }

  get brokerOrderIds(): ReadonlyArray<string> {
    return [this.brokerOrderId, ...this.legs.map((leg) => leg.brokerOrderId)];
  }

  /**
   * Settled when the spread is, which is the parent's business: its contracts fill
   * together or not at all, so a leg cannot outlive it.
   */
  get settled(): boolean {
    const latest = this.latestEvent;
    return latest !== undefined && isTerminalStatus(latest.status);
  }

  /** Cancels the spread. There is no way to cancel one contract of it. */
  async cancel(): Promise<void> {
    await this.props.canceller.cancelOrder(this.brokerOrderId);
  }

  async absorb(events: ReadonlyArray<BrokerOrderEvent>): Promise<void> {
    let applied = false;
    for (const event of events) {
      if (event.id === this.brokerOrderId) {
        this.received.push(event);
        applied = true;
        continue;
      }
      const leg = this.legs.find((entry) => entry.brokerOrderId === event.id);
      if (leg !== undefined) {
        leg.record(event);
        applied = true;
      }
    }

    if (!applied) {
      return;
    }

    // A handler that throws is logged and swallowed, for the same reason a single
    // order's is: it belongs to whoever placed the spread, and letting it abort the
    // dispatch loop would stop every other order's events being delivered too.
    try {
      await this.props.onEvent(events, this);
    } catch (err) {
      logger.error(`The handler for spread ${this.brokerOrderId} threw on ${events.map(eventToString).join('; ')}.`, err);
    }
  }
}
