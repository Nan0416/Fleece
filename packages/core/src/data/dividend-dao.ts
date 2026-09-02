import { Dividend } from '@fleece/shared';

export interface DividendIdentifier {
  readonly accountId: string;
  readonly symbol: string;
  readonly exDividendDate: string;
}

export interface GetDividendInput extends DividendIdentifier {
  /** Eastern calendar date used to derive `status`, which is never stored. */
  readonly today: string;
}

export interface GetDividendOutput {
  readonly dividend: Dividend | null;
}

export interface ListDividendsInput {
  readonly accountId: string;
  readonly symbol?: string;
  readonly today: string;
}

export interface ListDividendsOutput {
  readonly dividends: ReadonlyArray<Dividend>;
}

export interface UpsertDividendInput {
  readonly accountId: string;
  readonly symbol: string;
  readonly exDividendDate: string;
  readonly size: number;
  readonly amountPerShare: number;
  readonly declarationDate: string;
  readonly recordDate: string;
  readonly payDate: string;
  readonly today: string;
}

export interface UpsertDividendOutput {
  readonly dividend: Dividend;
}

export interface DividendDao {
  getDividend(input: GetDividendInput): Promise<GetDividendOutput>;
  listDividends(input: ListDividendsInput): Promise<ListDividendsOutput>;
  upsertDividend(input: UpsertDividendInput): Promise<UpsertDividendOutput>;
}
