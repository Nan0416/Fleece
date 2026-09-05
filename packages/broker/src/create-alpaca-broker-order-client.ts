import { AlpacaAccountIdentifier, AlpacaActiveSynchronization, AlpacaRestClient, AlpacaWsClient } from '@fleece/alpaca';
import { L1BrokerOrderClient } from './l1';
import { L2BrokerOrderClient, NoopOrderTrackingClient, OrderTrackingClient } from './l2';
import { L3BrokerOrderClient } from './l3';
import { AccountReservations } from './reservations';

export interface CreateAlpacaBrokerOrderClientProps {
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
 *     L3BrokerOrderClient            L3  signed decimals, handles, event delivery
 *       L2BrokerOrderClient L2  tells the tracking service whose the order is
 *         L1BrokerOrderClient L1  encodes the virtual account, sends
 *           AlpacaRestClient    L0  Alpaca's API, one to one
 *     + AccountReservations       holds buying power and shares around a placement
 *
 * Deliberately without knobs. Every layer is a constructor argument of the one above, so
 * a caller wanting a different stack — no announcement, no reservations, a placer of its
 * own — builds `L3BrokerOrderClient` directly and passes what it wants. A factory with a flag
 * per layer would be a second place the assembly is decided.
 */
export function createAlpacaBrokerOrderClient(props: CreateAlpacaBrokerOrderClientProps): L3BrokerOrderClient {
  const placer = new L2BrokerOrderClient({
    placer: new L1BrokerOrderClient({ restClient: props.restClient }),
    trackingClient: props.trackingClient ?? new NoopOrderTrackingClient(),
  });

  return new L3BrokerOrderClient({
    account: props.account,
    placer,
    assets: props.restClient,
    wsClient: props.wsClient,
    activeSync: props.activeSync,
    reservations: new AccountReservations({ account: props.account, reader: props.restClient, now: props.now }),
    now: props.now,
  });
}
