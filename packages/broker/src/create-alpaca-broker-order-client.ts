import { AlpacaAccountIdentifier, AlpacaActiveSynchronization, AlpacaRestClient, AlpacaWsClient } from '@fleece/alpaca';
import { TrackingClient } from '@fleece/client';
import { LoggerFactory } from '@fleece/shared';
import { BrokerOrderClient } from './l1';
import { L1BrokerOrderClient } from './l1';
import { L2BrokerOrderClient } from './l2';
import { L3BrokerOrderClient } from './l3';
import { AccountReservations } from './reservations';

const logger = LoggerFactory.getLogger('CreateAlpacaBrokerOrderClient');

export interface CreateAlpacaBrokerOrderClientProps {
  readonly account: AlpacaAccountIdentifier;
  readonly restClient: AlpacaRestClient;
  readonly wsClient: AlpacaWsClient;
  readonly activeSync: AlpacaActiveSynchronization;
  /**
   * Omit to run without L2. Nothing stands in for it — not wrapping is how a process
   * with no tracking service places orders, and it says so once at startup.
   */
  readonly trackingClient?: TrackingClient;
  readonly now?: () => number;
}

/**
 * The whole stack, assembled the way it is meant to be run:
 *
 *     L3BrokerOrderClient       L3  signed decimals, handles, event delivery
 *       L2BrokerOrderClient     L2  claims the order for its virtual account
 *         L1BrokerOrderClient   L1  encodes that account, sends
 *           AlpacaRestClient    L0  Alpaca's API, one to one
 *     + AccountReservations         holds buying power and shares around a placement
 *
 * Deliberately without knobs. Every layer is a constructor argument of the one above, so
 * a caller wanting a different stack — no reservations, a placer of its own — builds
 * `L3BrokerOrderClient` directly and passes what it wants. A factory with a flag per
 * layer would be a second place the assembly is decided.
 *
 * The one omission it does handle is L2, because leaving a layer out is not a flag: with
 * no tracking service to talk to there is nothing for that layer to do, and a
 * do-nothing client standing in for it would be a class whose whole body is a warning.
 */
export function createAlpacaBrokerOrderClient(props: CreateAlpacaBrokerOrderClientProps): L3BrokerOrderClient {
  const correlating = new L1BrokerOrderClient({ restClient: props.restClient });

  let placer: BrokerOrderClient = correlating;
  if (props.trackingClient === undefined) {
    // Said out loud on every start rather than only in a document. Nothing placed here
    // needs it — an order carries its virtual account in the correlation, and a
    // composite order's legs inherit their parent's — so what is lost is the orders this
    // process did not place: they fall through the tracking service's holding pen and are
    // booked to the catch-all account.
    logger.warn(`No tracking service is configured for Alpaca ${props.account.accountId}; orders will be claimed by their correlation alone.`);
  } else {
    placer = new L2BrokerOrderClient({ placer: correlating, trackingClient: props.trackingClient });
  }

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
