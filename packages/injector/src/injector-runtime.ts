import { AlpacaActiveSynchronization, HttpAlpacaRestClient, WsAlpacaWsClient } from '@fleece/alpaca';
import { createLedgerServices, createPool, migrate } from '@fleece/core';
import { Broker, LoggerFactory } from '@fleece/shared';
import path from 'node:path';
import { Pool } from 'pg';
import { AlpacaFeed, AlpacaInjector } from './alpaca-injector';
import { InjectorConfig } from './injector-config';
import { OrderTrackingFacade } from './order-tracking-facade';

const logger = LoggerFactory.getLogger('InjectorRuntime');

function coreMigrationsDir(): string {
  return path.resolve(path.dirname(require.resolve('@fleece/core/package.json')), 'migrations');
}

export interface StartInjectorOptions {
  /** Apply pending migrations on startup. Defaults to false — the API usually has. */
  readonly runMigrations?: boolean;
}

/**
 * The injector process: broker feeds in, ledger entries out.
 *
 * It holds `@fleece/core` directly rather than calling the API over HTTP, which is the
 * topology the legacy system ran — three processes against one database. The write
 * path locks, so they do not need to coordinate with each other.
 */
export class InjectorRuntime {
  private constructor(
    private readonly injector: AlpacaInjector,
    private readonly orderTracking: OrderTrackingFacade,
    private readonly feeds: ReadonlyArray<AlpacaFeed>,
    private readonly pool: Pool,
  ) {}

  static async start(config: InjectorConfig, options: StartInjectorOptions = {}): Promise<InjectorRuntime> {
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

    logger.info(`Injector is running against ${config.databaseUrl.replace(/:[^:@/]*@/, ':***@')}.`);
    return new InjectorRuntime(injector, orderTracking, feeds, pool);
  }

  /**
   * Stops taking new events, applies what is already queued, then closes.
   *
   * Draining before closing matters: an event already accepted but not yet written is
   * a fill the ledger would otherwise never learn about, and the broker will not send
   * it again.
   */
  async stop(): Promise<void> {
    logger.info('Shutting down the injector.');
    this.injector.stop();
    for (const feed of this.feeds) {
      await feed.wsClient.terminate();
    }
    await this.orderTracking.drain();
    this.orderTracking.stop();
    await this.pool.end();
    logger.info('Injector shutdown complete.');
  }
}
