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
