import { AlpacaOrder } from '@fleece/alpaca';
import { LoggerFactory } from '@fleece/shared';
import { BrokerOrderClient, PlaceLimitOrderInput, PlaceMarketOrderInput, PlaceMultiLegOrderInput, PlaceOtoOrderInput, PlacedOrder } from '../l1/broker-order-client';
import { OrderTrackingClient } from './order-tracking-client';

const logger = LoggerFactory.getLogger('L2BrokerOrderClient');

export interface L2BrokerOrderClientProps {
  readonly placer: BrokerOrderClient;
  readonly trackingClient: OrderTrackingClient;
}

/**
 * **L2.** Tells the tracking service which virtual account an order belongs to, right
 * after placing it.
 *
 * It implements the same interface as the layer it wraps, so this is a layer you install
 * rather than a step inside one: run without it and orders are still placed, still
 * correlated, still attributed — see below for what is actually lost.
 *
 * **What this is worth, honestly.** For orders placed through here, not much *today*.
 * An order carries its account in `client_order_id`, and the converter passes a parent's
 * correlation down to every leg that arrives nested — which, at Alpaca, is every leg
 * there is. So the announcement is a second answer to a question already answered.
 *
 * It earns its place in three ways, and they are the reasons to keep it:
 *
 * 1. **It is the contract for callers that do not place through this package.** An
 *    execution service holding its own broker client has no way to stamp a correlation
 *    onto an order Fleece never saw.
 * 2. **It does not depend on the correlation surviving.** `client_order_id` is 128
 *    characters of a field Alpaca also uses for its own purposes on legs; the
 *    announcement is a claim made out of band.
 * 3. **It is what a leg arriving *unnested* would need.** Nothing produces one today.
 *    Something might.
 *
 * **Failure is logged, not thrown.** The order is placed and the shares are moving
 * whether or not anything has been told whose they are. Throwing here would leave the
 * caller believing the placement failed, and the worst outcome — a fill in the catch-all
 * account — is recoverable by transferring the position. A caller that thinks it holds
 * nothing when it holds 500 shares is not.
 */
export class L2BrokerOrderClient implements BrokerOrderClient {
  constructor(private readonly props: L2BrokerOrderClientProps) {}

  async placeMarketOrder(input: PlaceMarketOrderInput): Promise<PlacedOrder> {
    return await this.announce(input.accountId, await this.props.placer.placeMarketOrder(input));
  }

  async placeLimitOrder(input: PlaceLimitOrderInput): Promise<PlacedOrder> {
    return await this.announce(input.accountId, await this.props.placer.placeLimitOrder(input));
  }

  async placeOtoOrder(input: PlaceOtoOrderInput): Promise<PlacedOrder> {
    return await this.announce(input.accountId, await this.props.placer.placeOtoOrder(input));
  }

  async placeMultiLegOrder(input: PlaceMultiLegOrderInput): Promise<PlacedOrder> {
    return await this.announce(input.accountId, await this.props.placer.placeMultiLegOrder(input));
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    // Nothing to announce: an order's account is written once and a cancellation does
    // not change it. Saying anything here would be a second chance to say it wrong.
    await this.props.placer.cancelOrder(brokerOrderId);
  }

  /**
   * Every id the placement produced, parent first.
   *
   * The legs are claimed as well as the parent, even though a nested leg already
   * inherits the parent's correlation, because the claim costs one array entry and
   * covers the case the correlation does not: a leg that reaches the tracking service
   * on its own.
   */
  private async announce(accountId: string, placed: PlacedOrder): Promise<PlacedOrder> {
    const brokerOrderIds = [placed.order.id, ...legIds(placed.order)];
    try {
      await this.props.trackingClient.trackBrokerOrders({ brokerOrderIds, accountId });
    } catch (err) {
      logger.error(`Placed ${brokerOrderIds.join(', ')} but could not tell the tracking service they belong to account ${accountId}.`, err);
    }
    return placed;
  }
}

function legIds(order: AlpacaOrder): ReadonlyArray<string> {
  return (order.legs ?? []).flatMap((leg) => [leg.id, ...legIds(leg)]);
}
