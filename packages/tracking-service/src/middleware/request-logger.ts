import { LoggerFactory } from '@fleece/shared';
import { NextFunction, Request, RequestHandler, Response } from 'express';

const logger = LoggerFactory.getLogger('Request');

/** Paths logged at debug rather than info, because they fire on a timer. */
const CHATTY_PATHS = new Set(['/ping', '/health']);

export function requestLogger(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = Date.now();
    res.on('finish', () => {
      const line = `${req.method} ${req.originalUrl} -> ${res.statusCode} in ${Date.now() - startedAt}ms`;
      if (CHATTY_PATHS.has(req.path) && res.statusCode < 400) {
        logger.debug(line);
      } else if (res.statusCode >= 500) {
        logger.error(line);
      } else if (res.statusCode >= 400) {
        logger.warn(line);
      } else {
        logger.info(line);
      }
    });
    next();
  };
}
