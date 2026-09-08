import type { Bar, Dividend, LatestSnapshot, Quote, StockSplit, Ticker, TickerDetails, TickerType, Trade } from './types';

export type Timespan = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year';

/** An Eastern calendar date (`YYYY-MM-DD`) or epoch milliseconds. */
export type DateOrTimestamp = string | number;

export interface BarsRequest {
  readonly symbol: string;
  readonly from: DateOrTimestamp;
  readonly to: DateOrTimestamp;
  readonly multiplier: number;
  /**
   * Providers do not agree on where a week starts: Alpaca buckets from Monday and drops
   * a partial week at the start of a range, Polygon buckets from Sunday and keeps it. The
   * same request over the same quarter is 11 weekly bars from one and 12 from the other,
   * and neither is wrong. Day and coarser-than-week agree.
   */
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
  /** Inclusive: the listing starts at this symbol. */
  readonly startTicker?: string;
  /** Exclusive, and what a previous response's `resumeFrom` is for. */
  readonly startAfter?: string;
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
  /**
   * Set when the listing stopped before running out — the whole US equity universe is
   * more pages than one call will walk. Pass it as the next request's `startAfter`.
   * Absent means these are all of them.
   */
  readonly resumeFrom?: string;
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

/** What every provider serves: prices over a window. */
export interface StockRestClient {
  bars(request: BarsRequest): Promise<BarsResponse>;
  minuteBars(request: MinuteBarsRequest): Promise<BarsResponse>;
  dailyBars(request: DailyBarsRequest): Promise<BarsResponse>;
  trades(request: TradesRequest): Promise<TradesResponse>;
  quotes(request: QuotesRequest): Promise<QuotesResponse>;
  /**
   * How far back a provider's split history reaches is its own business: Polygon has
   * AAPL's 1987 split, Alpaca's corporate actions begin around 2016.
   */
  stockSplits(request: StockSplitsRequest): Promise<StockSplitsResponse>;
}

/** A trading day as the exchange calendar records it, and as the session table stores it. */
export interface MarketSession {
  /** Eastern calendar date, ISO `YYYY-MM-DD`. */
  readonly date: string;
  /** `HH:mm` Eastern, usually 09:30. */
  readonly open: string;
  /** `HH:mm` Eastern — 13:00 on a half day. */
  readonly close: string;
  readonly openAt: number;
  readonly closeAt: number;
  readonly preMarketOpenAt: number;
  readonly afterMarketCloseAt: number;
}

export interface MarketHoursRequest {
  /** Inclusive, ISO `YYYY-MM-DD`. */
  readonly fromDate: string;
  /** Inclusive, ISO `YYYY-MM-DD`. */
  readonly toDate: string;
}

export interface MarketHoursResponse {
  /** Trading days only, ascending. A weekend or a holiday is absent, not empty. */
  readonly sessions: ReadonlyArray<MarketSession>;
}

/**
 * Alpaca additionally serves the exchange calendar, which is where the session table in
 * `market-hours.ts` comes from — including the after-hours close that varies between
 * half days, which no rule derives.
 */
export interface AlpacaStockRestClient extends StockRestClient {
  marketHours(request: MarketHoursRequest): Promise<MarketHoursResponse>;
}

export interface PolygonStockRestClient extends StockRestClient {
  snapshot(request: SnapshotRequest): Promise<SnapshotResponse>;
  snapshots(request: SnapshotsRequest): Promise<SnapshotsResponse>;
  tickers(request: TickersRequest): Promise<TickersResponse>;
  tickerDetails(request: TickerDetailsRequest): Promise<TickerDetailsResponse>;
  /**
   * Polygon only, deliberately. Alpaca serves cash dividends too, but sends no
   * declaration date, frequency or currency — and `declaration_date` is `NOT NULL` on the
   * ledger's `dividend` table and read straight out of this type by the corporate-action
   * job. Supplying one from elsewhere would be inventing a date the ledger then stores.
   */
  dividends(request: DividendsRequest): Promise<DividendsResponse>;
  historicalBars(request: HistoricalBarsRequest): Promise<HistoricalBarsResponse>;
}
