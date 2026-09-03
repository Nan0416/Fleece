import { AppError } from '@fleece/shared';

/**
 * Placing an order can fail for reasons the ledger's error vocabulary has no word for,
 * and the distinction matters to a caller deciding whether to retry, wait, or stop.
 */

/** The account cannot support the order: not enough buying power, or not enough free shares. */
export class NotReservableError extends AppError {
  constructor(message: string) {
    super(message, 409, 'CONFLICT');
  }
}

/** The broker is unreachable or refusing orders. Retryable, unlike the rest. */
export class BrokerUnavailableError extends AppError {
  constructor(message: string) {
    super(message, 503, 'INTERNAL');
  }
}

/** The broker reported something that cannot be reconciled with what we believe. */
export class UnexpectedOrderEventError extends AppError {
  constructor(message: string) {
    super(message, 500, 'INTERNAL');
  }
}
