import { AlpacaRestClient, encodeAlpacaOrderCorrelation } from '@fleece/alpaca';
import { InvalidRequestError, LoggerFactory } from '@fleece/shared';
import {
  BrokerOrderClient,
  CreateLimitOrderInput,
  CreateMarketOrderInput,
  CreateMultiLegOrderInput,
  CreateOtoOrderInput,
  CreatedOrder,
  CorrelatedOrderInput,
} from './broker-order-client';

const logger = LoggerFactory.getLogger('L1BrokerOrderClient');

export interface L1BrokerOrderClientProps {
  readonly restClient: AlpacaRestClient;
}

/**
 * **L1.** Alpaca's placement API, with the virtual account encoded into every order.
 *
 * The whole of it: build the `client_order_id`, send, hand back what came out. No
 * reservation, no bookkeeping, no tracking request, no handle. Those are the layers
 * above, and keeping them out of here is what makes each of them optional.
 *
 * The one rule it enforces is that an order must say whose it is. An order placed
 * without a virtual account is an order the injector cannot attribute from the event
 * stream, and it is booked to the catch-all account after
 * `FLEECE_UNRESOLVED_ORDER_TIMEOUT_MS` — a silent misattribution that only shows up
 * later as a strategy's P&L being wrong. Refusing it here costs one comparison.
 */
export class L1BrokerOrderClient implements BrokerOrderClient {
  constructor(private readonly props: L1BrokerOrderClientProps) {}

  async createMarketOrder(input: CreateMarketOrderInput): Promise<CreatedOrder> {
    const clientOrderId = correlate(input);
    const { order } = await this.props.restClient.createMarketOrder({
      symbol: input.symbol,
      size: input.size,
      side: input.side,
      positionIntent: input.positionIntent,
      timeInForce: input.timeInForce,
      clientOrderId,
    });
    return { order, clientOrderId };
  }

  async createLimitOrder(input: CreateLimitOrderInput): Promise<CreatedOrder> {
    const clientOrderId = correlate(input);
    const { order } = await this.props.restClient.createLimitOrder({
      symbol: input.symbol,
      size: input.size,
      side: input.side,
      limitPrice: input.limitPrice,
      positionIntent: input.positionIntent,
      timeInForce: input.timeInForce,
      clientOrderId,
    });
    return { order, clientOrderId };
  }

  async createOtoOrder(input: CreateOtoOrderInput): Promise<CreatedOrder> {
    const clientOrderId = correlate(input);
    const { order } = await this.props.restClient.createOtoOrder({
      symbol: input.symbol,
      size: input.size,
      side: input.side,
      limitPrice: input.limitPrice,
      takeProfitLimitPrice: input.takeProfitLimitPrice,
      positionIntent: input.positionIntent,
      timeInForce: input.timeInForce,
      clientOrderId,
    });
    return { order, clientOrderId };
  }

  /**
   * Only the parent carries the correlation, because only the parent has a client order
   * id we set. Alpaca assigns each leg one of its own — and unlike a bracket's legs, an
   * mleg's arrive nested inside the parent on every event, so the converter passes the
   * parent's correlation down to them and every contract is attributed from it.
   */
  async createMultiLegOrder(input: CreateMultiLegOrderInput): Promise<CreatedOrder> {
    const clientOrderId = correlate(input);
    const { order } = await this.props.restClient.createMultiLegOrder(
      input.netLimitPrice === undefined
        ? { type: 'market', size: input.size, legs: input.legs, timeInForce: input.timeInForce, clientOrderId }
        : { type: 'limit', size: input.size, legs: input.legs, netLimitPrice: input.netLimitPrice, timeInForce: input.timeInForce, clientOrderId },
    );
    return { order, clientOrderId };
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    logger.info(`Cancelling broker order ${brokerOrderId}.`);
    await this.props.restClient.cancelOrder({ brokerOrderId });
  }
}

function correlate(input: CorrelatedOrderInput): string {
  if (input.accountId.length === 0) {
    throw new InvalidRequestError('An order must name the virtual account it trades for; without one its fills are booked to the catch-all account.');
  }
  return encodeAlpacaOrderCorrelation({ virtualAccountId: input.accountId, reservationId: input.reservationId });
}
