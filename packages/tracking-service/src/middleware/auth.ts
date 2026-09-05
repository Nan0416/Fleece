import { LoggerFactory, UnauthenticatedError } from '@fleece/shared';
import { NextFunction, Request, RequestHandler, Response } from 'express';

const logger = LoggerFactory.getLogger('Auth');

/** Reachable without a token, so a load balancer or `curl` can probe the service. */
const PUBLIC_PATHS = new Set(['/ping', '/health']);

/**
 * Shared-token authentication, the same single token the API uses.
 *
 * It is a copy of `@fleece/service`'s rather than a shared package, because the two
 * services have one middleware in common and a package holding forty lines would be a
 * dependency to justify on every future change to either. The cost is that a change to
 * the scheme has to be made twice, which is why it is written the same way in both.
 *
 * What it protects here is narrower than the API's but not small: a claim decides which
 * virtual account an order's fills are booked to, and an order's account is written
 * once. Anything that can reach this port unauthenticated can book somebody else's fills
 * to an account of its choosing.
 */
export function bearerTokenAuth(token: string): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (PUBLIC_PATHS.has(req.path)) {
      next();
      return;
    }

    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      logger.warn(`Rejected ${req.method} ${req.path}: missing bearer token.`);
      next(new UnauthenticatedError('A bearer token is required.'));
      return;
    }

    if (header.slice('Bearer '.length) !== token) {
      logger.warn(`Rejected ${req.method} ${req.path}: invalid bearer token.`);
      next(new UnauthenticatedError('The supplied token is not valid.'));
      return;
    }

    next();
  };
}
