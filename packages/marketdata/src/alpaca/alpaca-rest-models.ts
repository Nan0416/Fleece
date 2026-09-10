/** Alpaca's market-data wire shapes, as they arrive. Normalised in `normalizers.ts`. */

/** RFC 3339 with nanoseconds — `2024-12-19T15:00:00.000052256Z` — not an epoch number. */
export type AlpacaTimestamp = string;

export interface AlpacaBar {
  readonly t: AlpacaTimestamp;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
  readonly v: number;
  /** Trade count in the window. */
  readonly n?: number;
  /** Volume-weighted average price. */
  readonly vw?: number;
}

export interface AlpacaTrade {
  readonly t: AlpacaTimestamp;
  /** Exchange code, a letter rather than Polygon's number. */
  readonly x: string;
  readonly p: number;
  readonly s: number;
  readonly c?: ReadonlyArray<string>;
  /** Trade id, unique per exchange per day. */
  readonly i: number;
  /** Tape: A, B or C. */
  readonly z?: string;
}

export interface AlpacaQuote {
  readonly t: AlpacaTimestamp;
  readonly ax: string;
  readonly ap: number;
  readonly as: number;
  readonly bx: string;
  readonly bp: number;
  readonly bs: number;
  readonly c?: ReadonlyArray<string>;
  readonly z?: string;
}

/**
 * Every multi-symbol response is keyed by symbol, and a symbol with nothing in the window
 * is absent from the map rather than present and empty.
 */
export interface AlpacaBarsResponse {
  readonly bars?: Record<string, ReadonlyArray<AlpacaBar> | null> | null;
  readonly next_page_token?: string | null;
}

export interface AlpacaTradesResponse {
  readonly trades?: Record<string, ReadonlyArray<AlpacaTrade> | null> | null;
  readonly next_page_token?: string | null;
}

export interface AlpacaQuotesResponse {
  readonly quotes?: Record<string, ReadonlyArray<AlpacaQuote> | null> | null;
  readonly next_page_token?: string | null;
}

/** From the trading API's `/v2/calendar`, which is a different host to the data API. */
export interface AlpacaCalendarDay {
  readonly date: string;
  /** `HH:mm` Eastern. */
  readonly open: string;
  readonly close: string;
  /** `HHmm` Eastern, with no colon — `0400`. */
  readonly session_open: string;
  readonly session_close: string;
  readonly settlement_date?: string;
}

/**
 * A split, forward or reverse. The rates read the same way round as Polygon's: a 1-for-4
 * forward split is `old_rate: 1, new_rate: 4`, and GE's reverse is `old_rate: 8,
 * new_rate: 1`.
 */
export interface AlpacaSplit {
  readonly symbol: string;
  readonly ex_date: string;
  readonly old_rate: number;
  readonly new_rate: number;
  readonly record_date?: string;
  readonly payable_date?: string;
  readonly process_date?: string;
}

export interface AlpacaCashDividend {
  readonly symbol: string;
  readonly ex_date: string;
  readonly rate: number;
  /** Alpaca's only statement about the kind of dividend this is. */
  readonly special: boolean;
  readonly foreign: boolean;
  readonly record_date?: string;
  readonly payable_date?: string;
  readonly process_date?: string;
}

/** Keyed by kind rather than by symbol, unlike every other multi-item response. */
export interface AlpacaCorporateActions {
  readonly forward_splits?: ReadonlyArray<AlpacaSplit> | null;
  readonly reverse_splits?: ReadonlyArray<AlpacaSplit> | null;
  readonly cash_dividends?: ReadonlyArray<AlpacaCashDividend> | null;
}

export interface AlpacaCorporateActionsResponse {
  readonly corporate_actions?: AlpacaCorporateActions | null;
  readonly next_page_token?: string | null;
}

/**
 * An option trade carries less than an equity one: OPRA reports no trade id and no tape,
 * and the condition is a single character where an equity trade sends an array.
 */
export interface AlpacaOptionTrade {
  readonly t: AlpacaTimestamp;
  /** Exchange code, a letter. */
  readonly x: string;
  readonly p: number;
  /** Contracts. */
  readonly s: number;
  readonly c?: string | null;
}

/** Same shape as `AlpacaQuote` but for the single-character condition. */
export interface AlpacaOptionQuote {
  readonly t: AlpacaTimestamp;
  readonly ax: string;
  readonly ap: number;
  readonly as: number;
  readonly bx: string;
  readonly bp: number;
  readonly bs: number;
  readonly c?: string | null;
}

export interface AlpacaGreeks {
  readonly delta: number;
  readonly gamma: number;
  readonly theta: number;
  readonly vega: number;
  readonly rho: number;
}

/**
 * Every section is optional. Alpaca omits `prevDailyBar` for a contract that did not
 * trade the day before, and omits the greeks and the implied volatility wherever it could
 * not solve them.
 */
export interface AlpacaOptionSnapshot {
  readonly dailyBar?: AlpacaBar | null;
  readonly minuteBar?: AlpacaBar | null;
  readonly prevDailyBar?: AlpacaBar | null;
  readonly latestTrade?: AlpacaOptionTrade | null;
  readonly latestQuote?: AlpacaOptionQuote | null;
  readonly greeks?: AlpacaGreeks | null;
  readonly impliedVolatility?: number | null;
}

/** Keyed by contract symbol, and in the order the chain is paged in. */
export interface AlpacaOptionSnapshotsResponse {
  readonly snapshots?: Record<string, AlpacaOptionSnapshot | null> | null;
  readonly next_page_token?: string | null;
}

export interface AlpacaOptionBarsResponse {
  readonly bars?: Record<string, ReadonlyArray<AlpacaBar> | null> | null;
  readonly next_page_token?: string | null;
}

export interface AlpacaOptionTradesResponse {
  readonly trades?: Record<string, ReadonlyArray<AlpacaOptionTrade> | null> | null;
  readonly next_page_token?: string | null;
}

/** From `/v2/options/contracts`, and only when `show_deliverables` asked for them. */
export interface AlpacaOptionDeliverable {
  readonly type?: string | null;
  readonly symbol?: string | null;
  readonly asset_id?: string | null;
  readonly amount?: string | null;
  readonly allocation_percentage?: string | null;
  readonly settlement_type?: string | null;
  readonly settlement_method?: string | null;
  readonly delayed_settlement?: boolean | null;
}

/**
 * From `/v2/options/contracts`, on the trading host rather than the data host — the same
 * reach across that `marketHours` makes for the calendar. Numbers arrive as strings.
 */
export interface AlpacaOptionContract {
  readonly id?: string | null;
  readonly symbol: string;
  readonly name?: string | null;
  readonly status?: string | null;
  readonly tradable?: boolean | null;
  readonly expiration_date?: string | null;
  readonly root_symbol?: string | null;
  readonly underlying_symbol?: string | null;
  readonly underlying_asset_id?: string | null;
  readonly type?: string | null;
  readonly style?: string | null;
  readonly strike_price?: string | null;
  readonly multiplier?: string | null;
  readonly size?: string | null;
  readonly open_interest?: string | null;
  readonly open_interest_date?: string | null;
  readonly close_price?: string | null;
  readonly close_price_date?: string | null;
  readonly deliverables?: ReadonlyArray<AlpacaOptionDeliverable> | null;
}

/** A list rather than a map, unlike the option routes on the data host. */
export interface AlpacaOptionContractsResponse {
  readonly option_contracts?: ReadonlyArray<AlpacaOptionContract> | null;
  readonly next_page_token?: string | null;
}
