import { LoggerFactory } from '@fleece/shared';
import { ErrorRequestHandler, RequestHandler } from 'express';
import { bearerTokenAuth, errorHandler, requestLogger } from '../middleware';
import { BrokerOrderClaims, Endpoints, HealthEndpoints, TrackingEndpoints } from '../routes';
import { TrackingConfig } from '../tracking-config';
import { trackingServiceVersion } from '../utils/version';

const logger = LoggerFactory.getLogger('DependencyFactory');

export interface Dependencies {
  readonly middleware: ReadonlyArray<RequestHandler>;
  readonly endpoints: ReadonlyArray<Endpoints>;
  readonly errorHandler: ErrorRequestHandler;
}

export interface DependencyFactoryProps {
  readonly config: TrackingConfig;
  readonly orderTracking: BrokerOrderClaims;
  readonly startedAt: number;
}

/**
 * Builds the HTTP object graph. The only place that knows how the pieces fit together.
 *
 * **No CORS.** The API has it because a console runs in a browser; nothing here is called
 * from one. A claim comes from a process that places orders, and adding the middleware
 * "just in case" would widen what can reach an endpoint that decides where fills are
 * booked.
 */
export class DependencyFactory {
  constructor(private readonly props: DependencyFactoryProps) {}

  build(): Dependencies {
    const { config, orderTracking } = this.props;

    const middleware: RequestHandler[] = [requestLogger()];

    if (typeof config.authToken === 'string' && config.authToken.length > 0) {
      middleware.push(bearerTokenAuth(config.authToken));
    } else {
      // Said out loud on every start rather than only in a document: a claim decides
      // which account an order's fills land in, and that account is written once.
      logger.warn('Authentication is disabled. Set FLEECE_TRACKING_TOKEN to require a bearer token on /track.');
    }

    const endpoints: Endpoints[] = [new HealthEndpoints({ version: trackingServiceVersion(), startedAt: this.props.startedAt }), new TrackingEndpoints({ orderTracking })];

    return { middleware, endpoints, errorHandler };
  }
}
