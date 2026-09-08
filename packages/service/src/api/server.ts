import { LoggerFactory } from '@fleece/utilities';
import { createPool, migrate } from '../core';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { DependencyFactory } from './dependencies/dependency-factory';
import { HttpApp } from '../http';
import { ServiceConfig } from './stage-config';

const logger = LoggerFactory.getLogger('FleeceServer');

export interface StartServerOptions {
  /** Apply pending migrations on startup. Defaults to true. */
  readonly runMigrations?: boolean;
}

/** The Fleece HTTP API over the account ledger. */
export class FleeceServer {
  private constructor(
    private readonly httpServer: http.Server,
    private readonly pool: Pool,
  ) {}

  static async start(config: ServiceConfig, options: StartServerOptions = {}): Promise<FleeceServer> {
    const startedAt = Date.now();
    const pool = createPool({ connectionString: config.databaseUrl });

    if (options.runMigrations !== false) {
      await migrate(pool);
    }

    const dependencies = new DependencyFactory({ config, pool, startedAt }).build();
    const app = new HttpApp({
      ...dependencies,
      name: 'Service',
      // Request bodies here are small; a cap keeps a malformed client from buffering
      // arbitrary memory.
      jsonBodyLimit: '256kb',
      urlencoded: true,
    }).init();

    const httpServer = http.createServer(app);

    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(config.port, config.host, () => {
        httpServer.removeListener('error', reject);
        resolve();
      });
    });

    const address = httpServer.address();
    const port = address !== null && typeof address !== 'string' ? address.port : config.port;
    logger.info(`Fleece is listening on http://${config.host}:${port} (stage ${config.stage}).`);

    return new FleeceServer(httpServer, pool);
  }

  get port(): number {
    const address: AddressInfo | string | null = this.httpServer.address();
    return address !== null && typeof address !== 'string' ? address.port : 0;
  }

  async stop(): Promise<void> {
    logger.info('Shutting down.');
    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
    await this.pool.end();
    logger.info('Shutdown complete.');
  }
}
