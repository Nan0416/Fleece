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

export interface StockRestClient {
  bars(request: BarsRequest): Promise<Bar[]>;
  minuteBars(request: MinuteBarsRequest): Promise<Bar[]>;
  dailyBars(request: DailyBarsRequest): Promise<Bar[]>;
  trades(request: TradesRequest): Promise<Trade[]>;
  quotes(request: QuotesRequest): Promise<Quote[]>;
  snapshot(request: SnapshotRequest): Promise<LatestSnapshot | undefined>;
  snapshots(request: SnapshotsRequest): Promise<LatestSnapshot[]>;
}

export interface PolygonStockRestClient extends StockRestClient {
  tickers(request: TickersRequest): Promise<Ticker[]>;
  tickerDetails(request: TickerDetailsRequest): Promise<TickerDetails | undefined>;
  stockSplits(request: StockSplitsRequest): Promise<StockSplit[]>;
  dividends(request: DividendsRequest): Promise<Dividend[]>;
  historicalBars(request: HistoricalBarsRequest): Promise<Map<string, Bar[]>>;
}
