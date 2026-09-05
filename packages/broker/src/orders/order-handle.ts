import { BrokerOrderEvent, eventToString, isTerminalStatus, LoggerFactory } from '@fleece/shared';
import { OrderPlacer } from '../models/order-placer';
import { SingleOrderObj } from '../models/order-obj';
import { SingleOrderEventHandler } from '../models/requests';
import { EventSink } from './event-dispatcher';

const logger = LoggerFactory.getLogger('SingleOrderHandle');

/** All a handle needs of the placer: it cancels its own order and nothing else. */
export type OrderCanceller = Pick<OrderPlacer, 'cancelOrder'>;

export interface SingleOrderHandleProps {
  readonly symbol: string;
  readonly brokerOrderId: string;
  readonly accountId: string;
  readonly onEvent: SingleOrderEventHandler;
  readonly canceller: OrderCanceller;
}

/**
 * The caller's handle on one placed order in one instrument.
 *
 * Only the happy path lives here: ordering, deduplication and recovery are the layers
 * below, and by the time an event reaches `absorb` it has been through them.
 *
 * It cancels through the `OrderPlacer` rather than through Alpaca directly, so a
 * cancellation goes down the same stack the placement came up.
 */
export class SingleOrderHandle implements SingleOrderObj, EventSink {
  readonly kind = 'single';
  readonly symbol: string;
  readonly brokerOrderId: string;
  readonly accountId: string;
  private readonly received: BrokerOrderEvent[] = [];

  constructor(private readonly props: SingleOrderHandleProps) {
    this.symbol = props.symbol;
    this.brokerOrderId = props.brokerOrderId;
    this.accountId = props.accountId;
  }

  get events(): ReadonlyArray<BrokerOrderEvent> {
    return this.received;
  }

  get latestEvent(): BrokerOrderEvent | undefined {
    return this.received[this.received.length - 1];
  }

  get brokerOrderIds(): ReadonlyArray<string> {
    return [this.brokerOrderId];
  }

  get settled(): boolean {
    const latest = this.latestEvent;
    return latest !== undefined && isTerminalStatus(latest.status);
  }

  async cancel(): Promise<void> {
    await this.props.canceller.cancelOrder(this.brokerOrderId);
  }

  /**
   * Called by the broker, never by the holder.
   *
   * A payload can describe more than this order — an OTO's arrives carrying both legs —
   * so everything not addressed to it is skipped rather than assumed.
   */
  async absorb(events: ReadonlyArray<BrokerOrderEvent>): Promise<void> {
    for (const event of events) {
      if (event.id === this.brokerOrderId) {
        await this.processEvent(event);
      }
    }
  }

  /**
   * The caller's handler can run before `order()` has returned: the broker still has work
   * to do after the placement response — registering with the poller, telling the
   * tracking service — and an event can arrive during it.
   *
   * A handler that throws is logged and swallowed. It belongs to whoever placed the
   * order, and letting it abort the dispatch loop would stop every *other* order's
   * events being delivered too.
   */
  private async processEvent(event: BrokerOrderEvent): Promise<void> {
    this.received.push(event);
    try {
      await this.props.onEvent(event, this);
    } catch (err) {
      logger.error(`The handler for broker order ${this.brokerOrderId} threw on ${eventToString(event)}.`, err);
    }
  }
}

/**
 * An OTO's two handles, absorbing one payload together.
 *
 * Alpaca returns the exit nested inside the entry and — over the websocket — sends no
 * event for the exit at all, so both handles are fed from the same message. They stay
 * separate objects because an OTO's exit is a real order that can be worked, filled and
 * cancelled on its own; only the delivery is shared.
 */
export class OtoPlacement implements EventSink {
  constructor(
    readonly entryOrder: SingleOrderHandle,
    readonly exitOrder: SingleOrderHandle,
  ) {}

  get brokerOrderIds(): ReadonlyArray<string> {
    return [...this.entryOrder.brokerOrderIds, ...this.exitOrder.brokerOrderIds];
  }

  get settled(): boolean {
    return this.entryOrder.settled && this.exitOrder.settled;
  }

  async absorb(events: ReadonlyArray<BrokerOrderEvent>): Promise<void> {
    await this.entryOrder.absorb(events);
    await this.exitOrder.absorb(events);
  }
}
