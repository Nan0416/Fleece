import type { DateOrTimestamp, Timespan } from './rest-client';
import type { Bar } from './types';
import type { OptionSnapshot, OptionTrade, OptionType } from './option-types';

/**
 * A chain is a listing, and a large one: a full AAPL chain is around 3,100 contracts and
 * SPY's is around 12,000, so the filters are how a caller asks a question rather than
 * downloads a market. Every one of them is optional and they combine.
 */
export interface OptionChainRequest {
  /** The underlying ticker, not a contract symbol. */
  readonly underlying: string;
  readonly type?: OptionType;
  /** Inclusive, ISO `YYYY-MM-DD`. Set both to the same date for one expiry. */
  readonly expirationFrom?: string;
  readonly expirationTo?: string;
  /** Inclusive, in dollars. */
  readonly strikeFrom?: number;
  readonly strikeTo?: number;
  /**
   * The OCC root, which is the underlying for an ordinary contract and something else
   * for one a split or a merger re-issued — the only way to keep adjusted contracts,
   * whose multiplier is not 100, out of an answer.
   */
  readonly rootSymbol?: string;
  readonly limit?: number;
  /** Exclusive, and what a previous response's `resumeFrom` is for. */
  readonly startAfter?: string;
}

/**
 * `resumeFrom` is set when the listing stopped before running out, and follows
 * `TickersResponse` for the same reason: a chain is more pages than one call should walk
 * on the caller's behalf.
 */
export interface OptionChainResponse {
  readonly contracts: ReadonlyArray<OptionSnapshot>;
  readonly resumeFrom?: string;
}

/**
 * No `adjustForSplit`, unlike `BarsRequest`, and not by omission: a split does not restate
 * an option's history, it re-issues the contract under a new symbol with a new strike and
 * multiplier. The prints under the old symbol stand as they printed.
 */
export interface OptionBarsRequest {
  /** The OCC contract symbol. */
  readonly symbol: string;
  readonly from: DateOrTimestamp;
  readonly to: DateOrTimestamp;
  readonly multiplier: number;
  readonly timespan: Timespan;
  /**
   * Defaults to false, where the equity default is true. Options have no pre- or
   * post-market session, so this filters only late-reported prints and the index
   * contracts that run past 16:00 — and leaving it off means a far-dated expiry does not
   * trip the session table's coverage guard for a filter that would remove nothing.
   */
  readonly marketHoursOnly?: boolean;
}

export interface OptionBarsResponse {
  readonly bars: ReadonlyArray<Bar>;
}

/** Either a whole trading day by `date`, or a `from`/`to` window, as `TradesRequest`. */
export interface OptionTradesRequest {
  /** The OCC contract symbol. */
  readonly symbol: string;
  readonly date?: string;
  readonly from?: number;
  /** Defaults to now. */
  readonly to?: number;
  readonly itemsPerRequest?: number;
}

export interface OptionTradesResponse {
  readonly trades: ReadonlyArray<OptionTrade>;
}
