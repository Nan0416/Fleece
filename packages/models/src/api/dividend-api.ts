import { Dividend } from '../account';

export interface ListDividendsRequest {
  readonly accountId: string;
  /** Omit for every symbol in the account. */
  readonly symbol?: string;
}

export interface ListDividendsResponse {
  readonly dividends: ReadonlyArray<Dividend>;
}
