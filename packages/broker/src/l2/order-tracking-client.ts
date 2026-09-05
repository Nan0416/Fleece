import { TrackingClient } from '@fleece/client';
import { LoggerFactory, TrackBrokerOrdersRequest } from '@fleece/shared';

const logger = LoggerFactory.getLogger('OrderTrackingClient');

/**
 * L2's port: something that can tell the tracking service whose an order is.
 *
 * An interface rather than the client itself, so that the layer can be tested without a
 * server and run without one — `NoopOrderTrackingClient` is what a process gets when no
 * tracking service is configured, and it is a supported configuration rather than a
 * broken one. What it costs is described there.
 */
export interface OrderTrackingClient {
  trackBrokerOrders(request: TrackBrokerOrdersRequest): Promise<void>;
}

/**
 * Sends the claim over HTTP.
 *
 * A thin adapter rather than L2 holding `TrackingClient` directly: the client returns a
 * response object and this port returns nothing, and keeping the port narrow is what
 * lets `NoopOrderTrackingClient` and a recording fake stand in for it.
 */
export class HttpOrderTrackingClient implements OrderTrackingClient {
  constructor(private readonly client: TrackingClient) {}

  async trackBrokerOrders(request: TrackBrokerOrdersRequest): Promise<void> {
    await this.client.trackBrokerOrders(request);
  }
}

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
  async trackBrokerOrders(request: TrackBrokerOrdersRequest): Promise<void> {
    logger.warn(
      `Not claiming broker order(s) ${request.brokerOrderIds.join(', ')} for account ${request.accountId}: no tracking service is configured. An order this process did not place would be booked to the default account.`,
    );
  }
}
