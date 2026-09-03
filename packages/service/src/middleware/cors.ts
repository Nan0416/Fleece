import { LoggerFactory } from '@fleece/shared';
import { NextFunction, Request, RequestHandler, Response } from 'express';

const logger = LoggerFactory.getLogger('Cors');

/** Methods the API actually serves. Anything else is rejected at the preflight. */
const ALLOWED_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';

/** Headers a browser client sends. `Authorization` is here for the shared-token setup. */
const ALLOWED_HEADERS = 'Authorization, Content-Type';

/** One day. Preflights are pure overhead, and the policy only changes on restart. */
const MAX_AGE_SECONDS = '86400';

export interface CorsOptions {
  /** Exact origins to allow, e.g. `http://localhost:5173`. A single `*` allows any. */
  readonly origins: ReadonlyArray<string>;
}

/**
 * Cross-origin access for the web UI, which is served from its own origin rather
 * than by this process.
 *
 * The allow-list is exact-match on the `Origin` header and the header is echoed back
 * rather than answered with `*`, because `*` is incompatible with credentialed
 * requests and would silently stop working the day the UI needs cookies. `*` is
 * still accepted as configuration for a throwaway setup, and then genuinely means
 * "any origin".
 *
 * This must be installed *before* `bearerTokenAuth`. A browser sends the preflight
 * `OPTIONS` without an `Authorization` header, so auth-first ordering rejects every
 * preflight with a 401 and the real request is never sent — which surfaces in the
 * browser as an unexplained CORS error rather than as an authentication failure.
 */
export function corsMiddleware(options: CorsOptions): RequestHandler {
  const allowAny = options.origins.includes('*');
  const allowed = new Set(options.origins);

  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;

    if (typeof origin === 'string' && (allowAny || allowed.has(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      // Without this a shared cache could serve one origin's response to another.
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else if (typeof origin === 'string') {
      logger.warn(`Rejected cross-origin ${req.method} ${req.path} from "${origin}": not in FLEECE_CORS_ORIGINS.`);
    }

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
      res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
      res.setHeader('Access-Control-Max-Age', MAX_AGE_SECONDS);
      // 204 rather than passing the request on: no route serves OPTIONS, so
      // continuing would end in the 404 handler and fail the preflight.
      res.status(204).end();
      return;
    }

    next();
  };
}
