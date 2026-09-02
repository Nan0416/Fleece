import { LoggerFactory } from '@fleece/shared';
import { createLedgerServices } from '@fleece/core';
import { ErrorRequestHandler, RequestHandler } from 'express';
import { Pool } from 'pg';
import { bearerTokenAuth, corsMiddleware, errorHandler, requestLogger } from '../middleware';
import { AccountEndpoints, BrokerOrderEndpoints, DividendEndpoints, Endpoints, HealthEndpoints, LedgerEndpoints, OrderGroupEndpoints } from '../routes';
import { ServiceConfig } from '../stage-config';
import { serviceVersion } from '../utils/version';

const logger = LoggerFactory.getLogger('DependencyFactory');

export interface Dependencies {
  readonly middleware: ReadonlyArray<RequestHandler>;
  readonly endpoints: ReadonlyArray<Endpoints>;
  readonly errorHandler: ErrorRequestHandler;
}

export interface DependencyFactoryProps {
  readonly config: ServiceConfig;
  readonly pool: Pool;
  readonly startedAt: number;
}

/** Builds the object graph. The only place that knows how the pieces fit together. */
export class DependencyFactory {
  constructor(private readonly props: DependencyFactoryProps) {}

  build(): Dependencies {
    const { config, pool } = this.props;
    const ledger = createLedgerServices({ pool });

    const middleware: RequestHandler[] = [requestLogger()];

    // CORS before authentication, always. A browser sends its preflight OPTIONS with
    // no Authorization header, so auth-first ordering rejects every preflight with a
    // 401 and the real request is never sent — which surfaces as an unexplained CORS
    // error rather than as an authentication failure.
    if (config.corsOrigins.length > 0) {
      middleware.push(corsMiddleware({ origins: config.corsOrigins }));
      if (config.corsOrigins.includes('*')) {
        logger.warn('CORS is open to any origin. Set FLEECE_CORS_ORIGINS to narrow it.');
      }
    }

    if (typeof config.authToken === 'string' && config.authToken.length > 0) {
      middleware.push(bearerTokenAuth(config.authToken));
    } else {
      // Said out loud on every start rather than only in a document: this service can
      // move positions between accounts, and anything that can reach it can do so.
      logger.warn('Authentication is disabled. Set FLEECE_TOKEN to require a bearer token.');
    }

    const endpoints: Endpoints[] = [
      new HealthEndpoints({ version: serviceVersion(), startedAt: this.props.startedAt }),
      new AccountEndpoints({ accountService: ledger.accountService }),
      new LedgerEndpoints({ ledgerService: ledger.ledgerService }),
      new DividendEndpoints({ dividendService: ledger.dividendService }),
      new OrderGroupEndpoints({ orderGroupService: ledger.orderGroupService }),
      new BrokerOrderEndpoints({ brokerOrderService: ledger.brokerOrderService }),
    ];

    return { middleware, endpoints, errorHandler };
  }
}
