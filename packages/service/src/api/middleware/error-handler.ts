import { AppError, ErrorResponse, LoggerFactory } from '@fleece/shared';
import { NextFunction, Request, Response } from 'express';

const logger = LoggerFactory.getLogger('ErrorHandler');

/**
 * Maps `AppError` subclasses onto HTTP responses. Anything else is a bug rather than
 * an expected failure, so it is logged in full and reported as a bare 500 — internal
 * messages are not echoed to callers.
 *
 * Must be registered after every route: Express identifies error handlers by the
 * four-argument signature, so `_next` has to stay even though it is unused.
 */
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    logger.warn(`${err.name}: ${err.message}`);
    const response: ErrorResponse = { error: err.message, errorCode: err.errorCode };
    res.status(err.statusCode).json(response);
    return;
  }

  logger.error('Unhandled error while serving a request.', err);
  const response: ErrorResponse = { error: 'Internal server error', errorCode: 'INTERNAL' };
  res.status(500).json(response);
}
