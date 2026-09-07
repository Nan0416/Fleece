import type { Bar, Dividend, LatestSnapshot, Quote, StockSplit, Ticker, TickerDetails, TickerType, Trade } from './types';

export type Timespan = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year';

/** An Eastern calendar date (`YYYY-MM-DD`) or epoch milliseconds. */
export type DateOrTimestamp = string | number;

export interface BarsRequest {
  readonly symbol: string;
  readonly from: DateOrTimestamp;
  readonly to: DateOrTimestamp;
  readonly multiplier: number;
  readonly timespan: Timespan;
  /** Defaults to true for intraday timespans, and is ignored for `day` and coarser. */
  readonly marketHoursOnly?: boolean;
  readonly adjustForSplit?: boolean;
}

export interface MinuteBarsRequest {
  readonly symbol: string;
  readonly from: DateOrTimestamp;
  /** Defaults to now, in the same form as `from`. */
  readonly to?: DateOrTimestamp;
  readonly marketHoursOnly?: boolean;
  readonly adjustForSplit?: boolean;
}

export interface DailyBarsRequest {
  readonly symbol: string;
  readonly from: DateOrTimestamp;
  readonly to?: DateOrTimestamp;
  readonly adjustForSplit?: boolean;
}

/**
 * Either a whole trading day by `date` — pre-market open to after-hours close — or a
 * `from`/`to` window within one Eastern day. Polygon pages these by timestamp, so a
 * window spanning days would silently take the first page of each.
 */
export interface TradesRequest {
  readonly symbol: string;
  readonly date?: string;
  readonly from?: number;
  /** Defaults to now. */
  readonly to?: number;
  readonly adjustForSplit?: boolean;
  readonly itemsPerRequest?: number;
}

export interface QuotesRequest {
  readonly symbol: string;
  readonly date?: string;
  readonly from?: number;
  readonly to?: number;
  readonly adjustForSplit?: boolean;
  readonly itemsPerRequest?: number;
}

export interface SnapshotRequest {
  readonly symbol: string;
}

export interface SnapshotsRequest {
  readonly symbols: ReadonlyArray<string>;
}

export interface TickersRequest {
  readonly type?: TickerType;
  readonly active?: boolean;
  readonly limit?: number;
  readonly startTicker?: string;
}

export interface TickerDetailsRequest {
  readonly symbol: string;
  /** The details as of this date, rather than today's. */
  readonly date?: string;
}

export interface StockSplitsRequest {
  readonly symbol: string;
  /** Restrict to splits executing on exactly this date. */
  readonly executionDate?: string;
}

export type DividendQueryDateType = 'declaration_date' | 'ex_dividend_date' | 'record_date' | 'pay_date';

export interface DividendsRequest {
  readonly symbol: string;
  readonly dateType: DividendQueryDateType;
  /** Inclusive. */
  readonly fromDate: string;
  /** Inclusive. */
  readonly toDate: string;
}

/** The trading days ending at `endDate`, most recent first, skipping non-trading days. */
export interface HistoricalBarsRequest {
  readonly symbol: string;
  readonly endDate: string;
  readonly days: number;
  readonly marketHoursOnly?: boolean;
}

/**
 * Every method answers with an object rather than the collection itself. A provider's
 * answer grows fields — a cursor, a count, a note that a window was truncated — and an
 * array has nowhere to put them without changing the signature of every caller.
 */
export interface BarsResponse {
  readonly bars: ReadonlyArray<Bar>;
}

export interface TradesResponse {
  readonly trades: ReadonlyArray<Trade>;
}

export interface QuotesResponse {
  readonly quotes: ReadonlyArray<Quote>;
}

/** `snapshot` is absent when the market is shut: Polygon serves these only intraday. */
export interface SnapshotResponse {
  readonly snapshot?: LatestSnapshot;
}

export interface SnapshotsResponse {
  readonly snapshots: ReadonlyArray<LatestSnapshot>;
}

export interface TickersResponse {
  readonly tickers: ReadonlyArray<Ticker>;
}

/** `details` is absent for a symbol the provider does not know as of that date. */
export interface TickerDetailsResponse {
  readonly details?: TickerDetails;
}

export interface StockSplitsResponse {
  readonly splits: ReadonlyArray<StockSplit>;
}

export interface DividendsResponse {
  readonly dividends: ReadonlyArray<Dividend>;
}

/** Keyed by Eastern date, most recent first. Non-trading days are absent, not empty. */
export interface HistoricalBarsResponse {
  readonly days: ReadonlyMap<string, ReadonlyArray<Bar>>;
}

export interface StockRestClient {
  bars(request: BarsRequest): Promise<BarsResponse>;
  minuteBars(request: MinuteBarsRequest): Promise<BarsResponse>;
  dailyBars(request: DailyBarsRequest): Promise<BarsResponse>;
  trades(request: TradesRequest): Promise<TradesResponse>;
  quotes(request: QuotesRequest): Promise<QuotesResponse>;
  snapshot(request: SnapshotRequest): Promise<SnapshotResponse>;
  snapshots(request: SnapshotsRequest): Promise<SnapshotsResponse>;
}

export interface PolygonStockRestClient extends StockRestClient {
  tickers(request: TickersRequest): Promise<TickersResponse>;
  tickerDetails(request: TickerDetailsRequest): Promise<TickerDetailsResponse>;
  stockSplits(request: StockSplitsRequest): Promise<StockSplitsResponse>;
  dividends(request: DividendsRequest): Promise<DividendsResponse>;
  historicalBars(request: HistoricalBarsRequest): Promise<HistoricalBarsResponse>;
}
