/** Polygon's wire shapes, snake_case as they arrive. Normalised in `normalizers.ts`. */

import type { Exchange, TickerType } from '../equity-data-models';

/**
 * Bar
 */
export interface PolygonAggregateResponse {
  readonly ticker: string;
  readonly status: string;
  /** The number of aggregates (minute or day) used to generate the response. */
  readonly queryCount: number;
  /** The total number of results for this request. */
  readonly resultsCount: number;
  /**
   * Whether or not this response was adjusted for splits.
   *
   * For example, Apple Inc. split its share on 2020-08-28. If you query the data before 2020-08-28 without adjusting the value,
   * the share price will be the original price (e.g. $400+), however, if you enable adjustment, the price before 2020-08-27 will
   * also be divided by the split.
   * */
  readonly adjusted: boolean;
  /** A request id assigned by the server. */
  readonly request_id: string;

  readonly results?: PolygonAggregateBar[];
}

export interface PolygonAggregateBar {
  /** The trading volume of the symbol in the given time period. */
  readonly v: number;
  /* The volume weighted average price. */
  readonly vw: number;
  readonly o: number;
  readonly c: number;
  readonly h: number;
  readonly l: number;
  /* The Unix Msec timestamp for the start of the aggregate window. */
  readonly t: number;
  /* The number of items in the aggregate window. */
  // n: number;
}

/**
 * Historical quotes
 */
export interface PolygonQuotesResponseV3 {
  readonly request_id: string;
  readonly next_url: string;
  readonly results?: PolygonQuoteV3[] | null;
}

export interface PolygonQuoteV3 {
  /** nanosecond, exchange generates the quote */
  readonly participant_timestamp: number;
  /** nanosecond, SIP receive the trade, the primary timestamp used to query data */
  readonly sip_timestamp: number;

  readonly ask_exchange: number;
  readonly ask_price: number;
  readonly ask_size: number;
  readonly bid_exchange: number;
  readonly bid_price: number;
  readonly bid_size: number;

  readonly sequence_number: number;
  readonly tape?: number;
}

export interface PolygonTradesResponseV3 {
  readonly request_id: string;
  readonly next_url: string;
  readonly status: 'OK' | string;
  readonly results?: PolygonTradeV3[] | null;
}

export interface PolygonTradeV3 {
  /** nanosecond, exchange generates the quote */
  readonly participant_timestamp: number;
  /** nanosecond SIP receive the trade */
  readonly sip_timestamp: number;
  /** The sequence number representing the sequence in which trade events happened. These are increasing and unique per ticker symbol, but will not always be sequential (e.g., 1, 2, 6, 9, 10, 11). */
  readonly sequence_number: number;
  readonly id: string;
  /** Exchange Id */
  readonly exchange: number;
  /** The size of a trade (also known as volume) as a number of whole shares traded. */
  readonly size: number;
  /** trade condition */
  readonly conditions?: number[];
  /** price of the trade */
  readonly price: number;
  readonly tape?: number;
}

/**
 * Snapshot - Ticker
 * https://polygon.io/docs/get_v2_snapshot_locale_us_markets_stocks_tickers__stocksTicker__anchor
 * */

export interface PolygonLatestSnapshotDaySection {
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
  readonly v: number;
  readonly vw: number;
}

export interface PolygonLatestSnapshotLastQuoteSection {
  /** the bid price */
  readonly p: number;
  /** the bid size */
  readonly s: number;
  /** The ask price */
  readonly P: number;
  /** The ask size  */
  readonly S: number;
  /** nanoseconds */
  readonly t: number;
}

export interface PolygonLatestSnapshotLastTradeSection {
  /** trade condition */
  readonly c?: number[];
  /** trade id */
  readonly i: number;
  readonly p: number;
  readonly s: number;
  /* nanoseconds timestamp. */
  readonly t: number;
  /** excahnge id */
  readonly x: number;
  readonly z?: number; // tap
}

export interface PolygonLatestSnapshotMinuteSection {
  readonly av: number;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
  readonly v: number;
  readonly vw: number;
}

export interface PolygonLatestSnapshotPreDaySection {
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
  readonly v: number;
  readonly vw: number;
}

export interface PolygonLatestSnapshot {
  readonly ticker: string;
  readonly todaysChange: number;
  readonly todaysChangePerc: number;

  // nanoseconds timestamp.
  readonly updated: number;
  readonly prevDay: PolygonLatestSnapshotPreDaySection;
  readonly day: PolygonLatestSnapshotDaySection;
  readonly lastQuote: PolygonLatestSnapshotLastQuoteSection;
  readonly lastTrade: PolygonLatestSnapshotLastTradeSection;
  readonly min: PolygonLatestSnapshotMinuteSection;
}

export interface PolygonLatestSnapshotResponse {
  readonly status: string;
  readonly ticker: PolygonLatestSnapshot;
}

export interface PolygonLatestSnapshotsResponse {
  readonly count: number;
  readonly status: string;
  readonly tickers: PolygonLatestSnapshot[];
}

// https://polygon.io/docs/get_v3_reference_tickers_anchor
export interface PolygonTicker {
  readonly ticker: string;
  readonly name: string;
  readonly market: 'stocks' | 'crypto' | 'fx';
  readonly locale: 'us' | string;
  readonly primary_exchange: Exchange;
  readonly type: TickerType;
  readonly active: boolean;
  readonly currency_name: 'usd' | string;
  readonly cik: string;
  readonly composite_figi: string;
  readonly share_class_figi: string;
  readonly last_updated_utc: string;
}

export interface PolygonTickersResponse {
  readonly request_id: string;
  readonly count: number; // total number of results (for stock, it's 38418)
  readonly status: 'OK' | string;
  readonly results: PolygonTicker[] | null;
}

// https://polygon.io/docs/stocks/get_v3_reference_tickers__ticker
export interface PolygonTickerDetailsV3 {
  readonly ticker: string;
  readonly name: string;
  readonly market: 'stocks' | string;
  readonly locale: 'us' | string;
  readonly primary_exchange: Exchange;
  readonly type: TickerType;
  readonly active: boolean;
  readonly currency_name: 'usd' | string;

  /**
   * Central Index Key or CIK is a 10-digit number used on the Securities and Exchange Commission's computer systems
   * to identify corporations and individuals who have filed disclosure with the SEC.
   */
  readonly cik: string;

  /**
   * Financial Instrument Global Identifier is an open standard, unique identifier of financial instruments that can
   * be assigned to instruments including common stock, options, derivatives, futures, corporate and government bonds,
   * municipals, currencies, and mortgage products
   *
   * A FIGI consists of three parts: A two-character prefix, a 'G' as the third character; an eight character alpha-numeric
   * code which does not contain English vowels "A", "E", "I", "O", or "U"; and a single check digit.
   */
  readonly composite_figi: string;
  readonly share_class_figi: string;
  readonly market_cap?: number; // ETF doesn't have market_cap
  readonly phone_number?: string;
  readonly address?: unknown;
  readonly description?: string;
  readonly sic_code?: string;
  readonly sic_description?: string;
  readonly ticker_root: string;
  readonly ticker_suffix?: string;
  readonly homepage_url?: string;
  readonly total_employee?: number;
  readonly list_date: string;
  readonly branding?: unknown;
  readonly share_class_shares_outstanding: number;
  readonly weighted_shares_outstanding?: number; // ETF doesn't have market_cap
}

export interface PolygonTickerDetailsV3Response {
  readonly results: PolygonTickerDetailsV3 | null;
  readonly count: number;
  readonly status: 'OK' | string;
  readonly request_id: string;
}

export interface PolygonStockSplit {
  readonly execution_date: string; // e.g. "2014-06-09",
  readonly split_from: number; // e.g 1,
  readonly split_to: number; // e.g. 4
  readonly ticker: string;
}

export interface PolygonStockSplitV3Response {
  readonly results: PolygonStockSplit[];
  readonly status: 'OK' | string;
  readonly request_id: string;
  readonly next_url?: string;
}

export type PolygonDividendType =
  | 'CD' // consistent scheduled dividends
  | 'SC' // special dividends
  | 'LT' // long term dividends ?
  | 'ST'; // short term dividends ?

export type PolygonDividendFrequency =
  | 0 // one time
  | 1 // annually
  | 2 // bi-annually
  | 4 // quarterly
  | 12; // monthly

export interface PolygonDividend {
  readonly cash_amount: number;
  readonly currency: 'USD' | string;
  readonly dividend_type: PolygonDividendType;
  readonly ticker: string;
  readonly frequency: PolygonDividendFrequency;

  readonly declaration_date: string;
  readonly ex_dividend_date: string;
  readonly record_date: string;
  readonly pay_date: string;
}

export interface PolygonDividendResponse {
  readonly results: PolygonDividend[];
  readonly status: 'OK' | string;
  readonly request_id: string;
  readonly next_url?: string;
}
