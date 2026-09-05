import { LoggerFactory } from '@fleece/shared';

const logger = LoggerFactory.getLogger('OrderTrackingClient');

/**
 * Tells the ledger which virtual account some broker orders belong to.
 *
 * This is the *only* way a leg order gets attributed. A bracket or OTO order's legs are
 * created by the broker itself with client order ids of its own, so the correlation
 * encoded into the parent's id cannot reach them — nothing but the service that asked
 * for the composite order knows whose they are.
 */
export interface TrackBrokerOrdersRequest {
  readonly brokerOrderIds: ReadonlyArray<string>;
  readonly accountId: string;
}

export interface OrderTrackingClient {
  trackBrokerOrders(request: TrackBrokerOrdersRequest): Promise<void>;
}

/**
 * Sends nothing, and says so.
 *
 * The legacy transport was a message stream: the injector ran a `lite-server` listening
 * on the `OrderTracking.{STAGE}` topic, and that layer is not ported. Until it is
 * replaced, a leg order will fall through the injector's holding pen and be booked to
 * the default virtual account once `FLEECE_UNRESOLVED_ORDER_TIMEOUT_MS` expires.
 *
 * It warns rather than staying silent because the consequence — a fill attributed to
 * the wrong account — is invisible at the point it happens and only shows up later as a
 * strategy's P&L being wrong. See `md/PORTING.md`.
 */
export class NoopOrderTrackingClient implements OrderTrackingClient {
  async trackBrokerOrders(request: TrackBrokerOrdersRequest): Promise<void> {
    logger.warn(
      `Not sending a tracking request for broker order(s) ${request.brokerOrderIds.join(', ')} (account ${request.accountId}): no transport is configured. Leg orders will be booked to the default account.`,
    );
  }
}
