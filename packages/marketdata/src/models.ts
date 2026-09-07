import type { DividendQueryDateType } from './equity-data-models';

export type { Dividend, DividendFrequency, DividendType, StockSplit } from './equity-data-models';

/** Which of a dividend's four dates a query's range applies to. */
export type DividendDateType = DividendQueryDateType;

export interface ListDividendsInput {
  readonly symbol: string;
  readonly dateType: DividendDateType;
  /** Inclusive, ISO `YYYY-MM-DD`. */
  readonly fromDate: string;
  /** Inclusive, ISO `YYYY-MM-DD`. */
  readonly toDate: string;
}

export interface ListDividendsOutput {
  readonly dividends: ReadonlyArray<import('./equity-data-models').Dividend>;
}

export interface ListStockSplitsInput {
  readonly symbol: string;
  /** Restrict to splits executing on exactly this date. */
  readonly executionDate?: string;
}

export interface ListStockSplitsOutput {
  readonly splits: ReadonlyArray<import('./equity-data-models').StockSplit>;
}

/**
 * The corporate actions the ledger needs, which is the slice `corporate-actions` depends
 * on. Bars, trades and quotes are on `PolygonStockRestClient`.
 *
 * A dividend is earned by holding at the close of the day *before* its ex-dividend date,
 * which is why the job looks up the position on the preceding day rather than on that one.
 */
export interface MarketDataClient {
  listDividends(input: ListDividendsInput): Promise<ListDividendsOutput>;
  listStockSplits(input: ListStockSplitsInput): Promise<ListStockSplitsOutput>;
}
