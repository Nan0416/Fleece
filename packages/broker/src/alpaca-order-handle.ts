import { BrokerOrderEvent, eventToString, LoggerFactory } from '@fleece/shared';
import { AlpacaRestClient } from '@fleece/alpaca';
import { OrderObj } from './models/order-obj';
import { OrderEventHandler } from './models/requests';

const logger = LoggerFactory.getLogger('AlpacaOrderHandle');

/** All this needs of the client. It cancels its own order and nothing else. */
export type OrderCanceller = Pick<AlpacaRestClient, 'cancelOrder'>;

export interface AlpacaOrderHandleProps {
  readonly symbol: string;
  readonly brokerOrderId: string;
  readonly accountId: string;
  readonly brokerAccountId: string;
  readonly onEvent: OrderEventHandler;
}

/**
 * The caller's handle on one placed order.
 *
 * Only the happy path lives here: ordering, deduplication and recovery are the broker's
 * job, and by the time an event reaches `processEvent` it has already been through
 * them.
 */
export class AlpacaOrderHandle implements OrderObj {
  readonly symbol: string;
  readonly brokerOrderId: string;
  readonly accountId: string;
  private readonly received: BrokerOrderEvent[] = [];

  constructor(
    private readonly props: AlpacaOrderHandleProps,
    private readonly canceller: OrderCanceller,
  ) {
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

  async cancel(): Promise<void> {
    logger.info(`Cancelling broker order ${this.brokerOrderId}.`);
    await this.canceller.cancelOrder({ brokerOrderId: this.brokerOrderId });
  }

  /**
   * Called by the broker, never by the holder.
   *
   * The caller's handler can run before `order()` has returned: the broker still has
   * work to do after the placement response — registering with the poller, sending the
   * tracking request — and an event can arrive during it.
   *
   * A handler that throws is logged and swallowed. It belongs to whoever placed the
   * order, and letting it abort the dispatch loop would stop every *other* order's
   * events being delivered too.
   */
  async processEvent(event: BrokerOrderEvent): Promise<void> {
    this.received.push(event);
    try {
      await this.props.onEvent(event, this);
    } catch (err) {
      logger.error(`The handler for broker order ${this.brokerOrderId} threw on ${eventToString(event)}.`, err);
    }
  }
}
