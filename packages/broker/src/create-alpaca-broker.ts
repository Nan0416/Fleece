import { AlpacaAccountIdentifier, AlpacaActiveSynchronization, AlpacaRestClient, AlpacaWsClient } from '@fleece/alpaca';
import { AlpacaBroker } from './orders/alpaca-broker';
import { AnnouncingOrderPlacer } from './placement/announcing-order-placer';
import { CorrelatedOrderPlacer } from './placement/correlated-order-placer';
import { NoopOrderTrackingClient, OrderTrackingClient } from './placement/order-tracking-client';
import { AccountReservations } from './reservations/account-reservations';

export interface CreateAlpacaBrokerProps {
  readonly account: AlpacaAccountIdentifier;
  readonly restClient: AlpacaRestClient;
  readonly wsClient: AlpacaWsClient;
  readonly activeSync: AlpacaActiveSynchronization;
  /** Defaults to the client that sends nothing and says so on every placement. */
  readonly trackingClient?: OrderTrackingClient;
  readonly now?: () => number;
}

/**
 * The whole stack, assembled the way it is meant to be run:
 *
 *     AlpacaBroker            L3  signed decimals, handles, event delivery
 *       AnnouncingOrderPlacer L2  tells the tracking service whose the order is
 *         CorrelatedOrderPlacer L1  encodes the virtual account, sends
 *           AlpacaRestClient    L0  Alpaca's API, one to one
 *     + AccountReservations       holds buying power and shares around a placement
 *
 * Deliberately without knobs. Every layer is a constructor argument of the one above, so
 * a caller wanting a different stack — no announcement, no reservations, a placer of its
 * own — builds `AlpacaBroker` directly and passes what it wants. A factory with a flag
 * per layer would be a second place the assembly is decided.
 */
export function createAlpacaBroker(props: CreateAlpacaBrokerProps): AlpacaBroker {
  const placer = new AnnouncingOrderPlacer({
    placer: new CorrelatedOrderPlacer({ restClient: props.restClient }),
    trackingClient: props.trackingClient ?? new NoopOrderTrackingClient(),
  });

  return new AlpacaBroker({
    account: props.account,
    placer,
    assets: props.restClient,
    wsClient: props.wsClient,
    activeSync: props.activeSync,
    reservations: new AccountReservations({ account: props.account, reader: props.restClient, now: props.now }),
    now: props.now,
  });
}
