/** Corporate actions, normalised away from any one data provider's field names. */

export interface StockSplit {
  readonly ticker: string;
  /** ISO `YYYY-MM-DD`, the Eastern calendar date the split took effect. */
  readonly executionDate: string;
  /** A 1-for-4 split is `splitFrom: 1, splitTo: 4` — one share becomes four. */
  readonly splitFrom: number;
  readonly splitTo: number;
}

/** How many times a year the issuer pays. 0 means a one-off. */
export type DividendFrequency = 0 | 1 | 2 | 4 | 12;

export type DividendType =
  | 'CD' // consistent, scheduled
  | 'SC' // special
  | 'LT' // long-term
  | 'ST'; // short-term

export interface Dividend {
  readonly ticker: string;
  readonly cashAmount: number;
  readonly currency: string;
  readonly dividendType: DividendType;
  readonly frequency: DividendFrequency;
  readonly declarationDate: string;
  /**
   * The date the shares begin trading without the dividend. Holding at the close of
   * the day *before* this is what earns the payment, which is why the corporate-action
   * job looks up the position on the preceding day rather than on this one.
   */
  readonly exDividendDate: string;
  readonly recordDate: string;
  readonly payDate: string;
}

export type DividendDateType = 'declaration_date' | 'ex_dividend_date' | 'record_date' | 'pay_date';

export interface ListDividendsInput {
  readonly symbol: string;
  /** Which of the four dates the range applies to. */
  readonly dateType: DividendDateType;
  /** Inclusive, ISO `YYYY-MM-DD`. */
  readonly fromDate: string;
  /** Inclusive, ISO `YYYY-MM-DD`. */
  readonly toDate: string;
}

export interface ListDividendsOutput {
  readonly dividends: ReadonlyArray<Dividend>;
}

export interface ListStockSplitsInput {
  readonly symbol: string;
  /** Restrict to splits executing on exactly this date. */
  readonly executionDate?: string;
}

export interface ListStockSplitsOutput {
  readonly splits: ReadonlyArray<StockSplit>;
}

/**
 * The corporate actions the ledger needs. Prices, quotes and trades belong to services
 * that are not part of this port.
 */
export interface MarketDataClient {
  listDividends(input: ListDividendsInput): Promise<ListDividendsOutput>;
  listStockSplits(input: ListStockSplitsInput): Promise<ListStockSplitsOutput>;
}
