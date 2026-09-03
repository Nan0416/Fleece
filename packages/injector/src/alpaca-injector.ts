import { convertAlpacaOrderToBrokerOrderEvent, AlpacaAccountIdentifier, AlpacaActiveSynchronization, AlpacaOrder, AlpacaWsClient } from '@fleece/alpaca';
import { LoggerFactory } from '@fleece/shared';
import { OrderTrackingFacade } from './order-tracking-facade';

const logger = LoggerFactory.getLogger('AlpacaInjector');

export interface AlpacaFeed {
  readonly account: AlpacaAccountIdentifier;
  readonly wsClient: AlpacaWsClient;
  readonly activeSync: AlpacaActiveSynchronization;
}

export interface AlpacaInjectorProps {
  readonly orderTracking: OrderTrackingFacade;
  readonly feeds: ReadonlyArray<AlpacaFeed>;
}

/**
 * Connects Alpaca's order feeds to the ledger.
 *
 * Each account has two sources of the same events — the websocket, and the REST poll
 * that backfills what the websocket dropped — and both go through the same enqueue
 * path. Nothing here deduplicates them: the ledger's fill path is idempotent, and
 * doing it here instead would mean the deduplication was lost on every restart.
 */
export class AlpacaInjector {
  private readonly handlerIds = new Map<AlpacaWsClient, string>();

  constructor(private readonly props: AlpacaInjectorProps) {}

  start(): void {
    for (const feed of this.props.feeds) {
      const handlerId = feed.wsClient.addOrderEventHandler((order) => {
        logger.info(`Alpaca ${feed.account.accountId} reported order ${order.id} ${order.status} on the stream.`);
        // Told to the poller as well as the ledger, so it knows this order is worth
        // watching and how far along it already is.
        feed.activeSync.track(order);
        this.inject(order, feed);
      });
      this.handlerIds.set(feed.wsClient, handlerId);

      feed.activeSync.onEvent = (order) => {
        logger.warn(`Recovered order ${order.id} ${order.status} for Alpaca ${feed.account.accountId} by polling; the stream did not deliver it.`);
        this.inject(order, feed);
      };

      feed.activeSync.start();
    }
    logger.info(`Injecting order events from ${this.props.feeds.length} Alpaca account(s).`);
  }

  stop(): void {
    for (const feed of this.props.feeds) {
      const handlerId = this.handlerIds.get(feed.wsClient);
      if (handlerId !== undefined) {
        feed.wsClient.removeOrderEventHandler(handlerId);
      }
      feed.activeSync.stop();
    }
    this.handlerIds.clear();
  }

  private inject(order: AlpacaOrder, feed: AlpacaFeed): void {
    try {
      this.props.orderTracking.enqueue({
        event: convertAlpacaOrderToBrokerOrderEvent(order, feed.account),
        originalEvent: order,
        broker: 'alpaca',
        brokerAccountId: feed.account.accountId,
        live: feed.account.live,
      });
    } catch (err) {
      // One unconvertible event must not take down the feed for every other order.
      logger.error(`Could not convert Alpaca order ${order.id} from account ${feed.account.accountId}.`, err);
    }
  }
}
