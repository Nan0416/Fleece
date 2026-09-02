export type ErrorCode = 'INVALID_REQUEST' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL';

/**
 * Base class for every expected failure. The service's error handler maps these to
 * HTTP responses; a bare `Error` is reserved for genuinely unexpected failures and
 * always surfaces as a 500.
 *
 * The legacy service threw plain object literals carrying a `_source` discriminator
 * and an 18-member `AccountErrorCode` union, which meant every throw site restated
 * the status code and the handler branched on `err._source`. The codes collapse to
 * the six below without losing anything a caller acts on: which resource was missing
 * is in the message, not the code.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly errorCode: ErrorCode;

  constructor(message: string, statusCode: number, errorCode: ErrorCode) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}

/** 400 — malformed request, missing fields, invalid values. */
export class InvalidRequestError extends AppError {
  constructor(message: string) {
    super(message, 400, 'INVALID_REQUEST');
  }
}

/** 401 — missing or invalid credentials. */
export class UnauthenticatedError extends AppError {
  constructor(message: string = 'Unauthorized') {
    super(message, 401, 'UNAUTHENTICATED');
  }
}

/** 403 — authenticated but not allowed. Deleting a live account without `force` lands here. */
export class ForbiddenError extends AppError {
  constructor(message: string = 'Forbidden') {
    super(message, 403, 'FORBIDDEN');
  }
}

/** 404 — the account, position, profit, dividend, order group or broker order does not exist. */
export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, 404, 'NOT_FOUND');
  }
}

/** 409 — the request conflicts with current state: a duplicate id, or an illegal transition. */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, 'CONFLICT');
  }
}

/** 500 — an invariant the service is responsible for upholding was violated. */
export class InternalServiceError extends AppError {
  constructor(message: string) {
    super(message, 500, 'INTERNAL');
  }
}

/**
 * The service could not be reached at all — connection refused, DNS failure, or a
 * timeout.
 *
 * Produced by clients, never by the service, and so never seen on the wire. It is
 * still an `AppError` because callers branch on it the same way they branch on the
 * rest: "the ledger said no" and "there was no ledger to ask" need different words,
 * and folding both into `InternalServiceError` leaves a caller unable to tell a
 * control plane that is down from one that is up and broken.
 */
export class ServiceUnreachableError extends AppError {
  constructor(message: string) {
    super(message, 503, 'INTERNAL');
  }
}

export interface ErrorResponse {
  readonly error: string;
  readonly errorCode: ErrorCode;
}
