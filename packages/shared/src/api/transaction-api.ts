import { Transaction } from '../models/account';
import { TimeWindowPage } from './common';

/**
 * The legacy service had two of these. The first took an account and a symbol and
 * returned every transaction ever recorded for them, unbounded — it was marked
 * `@deprecated` in its own source with the note "The api is not scale". Only the
 * paged form survives the port.
 */
export interface ListTransactionsRequest extends TimeWindowPage {
  readonly accountId: string;
  /** Omit for every symbol in the account. */
  readonly symbol?: string;
}

export interface ListTransactionsResponse {
  readonly transactions: ReadonlyArray<Transaction>;
}

/**
 * Every transaction a single broker order produced. A partially filled order fills in
 * several pieces and writes one transaction per fill, so this returns a list.
 */
export interface ListTransactionsByReferenceIdRequest {
  readonly referenceId: string;
}

export interface ListTransactionsByReferenceIdResponse {
  readonly transactions: ReadonlyArray<Transaction>;
}
