import { AlpacaActiveSynchronization, HttpAlpacaRestClient, WsAlpacaWsClient } from '@fleece/alpaca';
import { createLedgerServices, createPool, migrate } from '@fleece/core';
import { Broker, LoggerFactory } from '@fleece/shared';
import path from 'node:path';
import { Pool } from 'pg';
import { AlpacaFeed, AlpacaInjector } from './alpaca-injector';
import { OrderTrackingFacade } from './order-tracking-facade';
import { TrackingServer } from './server';
import { TrackingConfig } from './tracking-config';

const logger = LoggerFactory.getLogger('TrackingServiceRuntime');

function coreMigrationsDir(): string {
  return path.resolve(path.dirname(require.resolve('@fleece/core/package.json')), 'migrations');
}

export interface StartTrackingServiceOptions {
  /** Apply pending migrations on startup. Defaults to false — the API usually has. */
  readonly runMigrations?: boolean;
}

/**
 * The tracking service: broker feeds in, ledger entries out, and one port for the thing
 * the feeds cannot tell it.
 *
 * **Two halves, one queue.** The feeds discover what the broker did; `PUT /track` accepts
 * what only the placing process knows — whose an order is. Both go through
 * `OrderTrackingFacade`'s single queue, which is the point of putting them in one
 * process: an order's events and a claim about that order can never be decided
 * concurrently, so neither needs to lock against the other.
 *
 * It holds `@fleece/core` directly rather than calling the API over HTTP, which is the
 * topology the legacy system ran — three processes against one database. The write
 * path locks, so they do not need to coordinate with each other.
 */
export class TrackingServiceRuntime {
  private constructor(
    private readonly injector: AlpacaInjector,
    private readonly orderTracking: OrderTrackingFacade,
    private readonly feeds: ReadonlyArray<AlpacaFeed>,
    private readonly server: TrackingServer,
    private readonly pool: Pool,
  ) {}

  /** The port the claims endpoint is listening on. Useful when it was configured as 0. */
  get port(): number {
    return this.server.port;
  }

  static async start(config: TrackingConfig, options: StartTrackingServiceOptions = {}): Promise<TrackingServiceRuntime> {
    const startedAt = Date.now();
    const pool = createPool({ connectionString: config.databaseUrl });
    if (options.runMigrations === true) {
      await migrate(pool, coreMigrationsDir());
    }

    const { ledgerService, brokerOrderService } = createLedgerServices({ pool });

    const orderTracking = new OrderTrackingFacade({
      ledgerService,
      brokerOrderService,
      unresolvedTimeoutMs: config.unresolvedTimeoutMs,
      defaultAccountIdProvider: (broker: Broker, brokerAccountId: string, live: boolean): string => {
        if (broker === 'alpaca') {
          return live ? config.defaultLiveAccountId : config.defaultPaperAccountId;
        }
        // `traderq` orders are written by position transfers, which always name their
        // accounts. Reaching here means an event arrived for a broker with no default.
        throw new Error(`No default virtual account is configured for ${live ? 'live' : 'paper'} ${broker} account ${brokerAccountId}.`);
      },
    });

    const feeds: AlpacaFeed[] = [];
    for (const { account, credentials } of config.brokerAccounts) {
      const restClient = new HttpAlpacaRestClient({ account, credentialsProvider: credentials });
      const wsClient = new WsAlpacaWsClient({ account, credentialsProvider: credentials });
      await wsClient.init();
      feeds.push({ account, wsClient, activeSync: new AlpacaActiveSynchronization({ account, restClient }) });
    }

    const injector = new AlpacaInjector({ orderTracking, feeds });
    injector.start();

    // Started last: the port answering is a claim that this process can accept work, and
    // it cannot until the feeds and the ledger behind them are up.
    const server = await TrackingServer.start({ config, orderTracking, startedAt });

    logger.info(`Tracking service is running against ${config.databaseUrl.replace(/:[^:@/]*@/, ':***@')}.`);
    return new TrackingServiceRuntime(injector, orderTracking, feeds, server, pool);
  }

  /**
   * Stops taking new work, applies what is already queued, then closes.
   *
   * The order is the point. The port closes first, so no claim is accepted that will not
   * be applied; then the feeds; then the queue drains. An event or a claim already
   * accepted but not yet written is a fill the ledger would otherwise never learn about,
   * and the broker will not send it again.
   */
  async stop(): Promise<void> {
    logger.info('Shutting down the tracking service.');
    await this.server.stop();
    this.injector.stop();
    for (const feed of this.feeds) {
      await feed.wsClient.terminate();
    }
    await this.orderTracking.drain();
    this.orderTracking.stop();
    await this.pool.end();
    logger.info('Tracking service shutdown complete.');
  }
}
