import { TrackingClient } from '@fleece/client';
import { LoggerFactory, TrackBrokerOrdersRequest, TrackBrokerOrdersResponse } from '@fleece/shared';

const logger = LoggerFactory.getLogger('OrderTrackingClient');

/**
 * All L2 needs of `@fleece/client`'s `TrackingClient`: it claims orders and nothing else.
 *
 * A narrowed view of the real client rather than an interface of our own, so a
 * `TrackingClient` is passed straight in with nothing adapting it — and so the compiler
 * checks that this and the client have not drifted apart, which an independently
 * declared interface would not.
 *
 * It stays a type rather than becoming the concrete class because the two stand-ins
 * below it matter: `NoopOrderTrackingClient` is what a process gets with no tracking
 * service configured, and a recording fake is what the tests use. Neither is an HTTP
 * client, and neither should have to be one.
 */
export type OrderTrackingClient = Pick<TrackingClient, 'trackBrokerOrders'>;

/**
 * Sends nothing, and says so.
 *
 * This is what a process gets when no tracking service is configured. It is not broken:
 * an order placed through this package carries its virtual account in the broker's
 * `client_order_id`, and a composite order's legs inherit their parent's, so everything
 * placed here is attributed without a claim ever being sent.
 *
 * What is lost is the orders this package did not place. One arriving from the broker
 * with no correlation falls through the tracking service's holding pen and is booked to
 * the default account once `FLEECE_UNRESOLVED_ORDER_TIMEOUT_MS` expires. It warns rather
 * than staying silent because that outcome — a fill in the wrong account — is invisible
 * at the point it happens and only shows up later as a strategy's P&L being wrong.
 */
export class NoopOrderTrackingClient implements OrderTrackingClient {
  async trackBrokerOrders(request: TrackBrokerOrdersRequest): Promise<TrackBrokerOrdersResponse> {
    logger.warn(
      `Not claiming broker order(s) ${request.brokerOrderIds.join(', ')} for account ${request.accountId}: no tracking service is configured. An order this process did not place would be booked to the default account.`,
    );
    return {};
  }
}
