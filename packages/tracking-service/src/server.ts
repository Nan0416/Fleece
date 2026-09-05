import { LoggerFactory } from '@fleece/shared';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { DependencyFactory } from './dependencies/dependency-factory';
import { BrokerOrderClaims } from './routes';
import { TrackingService } from './service';
import { TrackingConfig } from './tracking-config';

const logger = LoggerFactory.getLogger('TrackingServer');

export interface TrackingServerProps {
  readonly config: TrackingConfig;
  readonly orderTracking: BrokerOrderClaims;
  readonly startedAt: number;
}

/**
 * The HTTP half of the tracking service.
 *
 * It owns a listener and nothing else — no pool, no migrations, no feeds. Those belong
 * to `TrackingServiceRuntime`, which is the process, because the ledger connection is
 * shared with the half that consumes the broker's events and closing it here would take
 * that half down with the port.
 */
export class TrackingServer {
  private constructor(private readonly httpServer: http.Server) {}

  static async start(props: TrackingServerProps): Promise<TrackingServer> {
    const { config } = props;
    const dependencies = new DependencyFactory(props).build();
    const app = new TrackingService({
      middleware: dependencies.middleware,
      endpoints: dependencies.endpoints,
      errorHandler: dependencies.errorHandler,
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
    logger.info(`Tracking claims accepted at http://${config.host}:${port}/track.`);

    return new TrackingServer(httpServer);
  }

  get port(): number {
    const address: AddressInfo | string | null = this.httpServer.address();
    return address !== null && typeof address !== 'string' ? address.port : 0;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
  }
}
