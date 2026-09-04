import { convertAlpacaOrderToBrokerOrderEvents, AlpacaAccountIdentifier, AlpacaActiveSynchronization, AlpacaOrder, AlpacaWsClient } from '@fleece/alpaca';
import { BrokerOrderEvent, LoggerFactory } from '@fleece/shared';
import { OrderTrackingFacade } from './order-tracking-facade';

const logger = LoggerFactory.getLogger('AlpacaInjector');

/** One converted order paired with the raw Alpaca payload it was converted from. */
interface ConvertedOrder {
  readonly event: BrokerOrderEvent;
  readonly originalEvent: AlpacaOrder;
}

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

  /**
   * One Alpaca payload becomes one job per order it describes. A spread yields a job per
   * leg and none for the parent, which trades nothing.
   *
   * Each job carries the payload of *its own* order rather than the one that arrived,
   * because `broker_order_record` is keyed by broker order id and holds the event
   * verbatim for replay. Giving every leg the parent's payload would file, against each
   * leg, a record whose own id is a different order.
   */
  private inject(order: AlpacaOrder, feed: AlpacaFeed): void {
    let converted: ReadonlyArray<ConvertedOrder>;
    try {
      // Everything is converted before anything is enqueued, so a spread whose second
      // leg is unreadable does not leave its first leg applied and the rest lost.
      const rawById = new Map([order, ...(order.legs ?? [])].map((entry) => [entry.id, entry]));
      converted = convertAlpacaOrderToBrokerOrderEvents(order, feed.account).map((event) => ({ event, originalEvent: rawById.get(event.id) ?? order }));
    } catch (err) {
      // One unconvertible event must not take down the feed for every other order. The
      // websocket calls its handlers in a bare loop, so a throw escaping here would
      // reach `ws.on('message')` and take the process with it.
      logger.error(`Could not convert Alpaca order ${order.id} from account ${feed.account.accountId}.`, err);
      return;
    }

    for (const job of converted) {
      this.props.orderTracking.enqueue({
        ...job,
        broker: 'alpaca',
        brokerAccountId: feed.account.accountId,
        live: feed.account.live,
      });
    }
  }
}
