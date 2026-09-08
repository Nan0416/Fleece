import type { Bar, DataSource, Quote } from './types';

/**
 * The option data model. Separate from the equity types in `types.ts` because an option
 * print carries less than an equity one, not more: OPRA sends no trade id and no tape,
 * and a `Trade` requires both.
 *
 * Bars and quotes are not repeated here — an option bar is `{o, h, l, c, v, t}` and an
 * option quote is `{bx, bp, bs, ax, ap, as, t, c}`, which is what `Bar` and `Quote`
 * already are.
 */

export type OptionType = 'call' | 'put';

/**
 * An OCC contract symbol taken apart: `AAPL260918C00230000` is a September 18th 2026
 * AAPL 230 call.
 *
 * Parsed rather than carried alongside because the chain endpoint answers with nothing
 * but the symbol — no strike, no expiry, no type — so a caller cannot tell one contract
 * from another without this.
 */
export interface OccSymbol {
  readonly symbol: string;
  readonly underlying: string;
  /** ISO `YYYY-MM-DD`. */
  readonly expiration: string;
  readonly type: OptionType;
  /** In dollars, so `230` for a 230 strike. Derived from `strikeMils`. */
  readonly strike: number;
  /**
   * The strike as OCC states it, in thousandths of a dollar. Kept because it is the
   * exact value: `strike` is that number divided by 1000, and a strike like 0.105 has
   * no exact double.
   */
  readonly strikeMils: number;
}

/** Alpaca's, computed from its own volatility surface rather than reported by OPRA. */
export interface OptionGreeks {
  readonly delta: number;
  readonly gamma: number;
  readonly theta: number;
  readonly vega: number;
  readonly rho: number;
}

export interface OptionTrade {
  /** The OCC contract symbol. */
  readonly S: string;
  /** Exchange code, a letter. */
  readonly x: string;
  /** Premium per share, so a contract costs this times its multiplier. */
  readonly p: number;
  /** Contracts, not shares. */
  readonly s: number;
  readonly t: number;
  /**
   * Condition codes. An array although OPRA sends exactly one, because the equity model
   * is an array and a classifier over the two should not need two shapes.
   *
   * These decide whether a print means what it appears to. `f` and `g` — multi-leg
   * autoelectronic and multi-leg auction — mark a leg of a spread, whose price is that
   * leg's share of a package rather than a price anyone paid for the contract alone;
   * `A`, `C`, `E` and `G` mark a trade that was subsequently cancelled.
   */
  readonly c?: ReadonlyArray<string>;
}

/**
 * One contract's corner of an option chain.
 *
 * Every section is optional, which is not defensiveness: Alpaca omits `prevDailyBar` for
 * a contract that did not trade the day before, and omits the greeks and the implied
 * volatility wherever it could not solve them — around four contracts in ten of a large
 * chain.
 */
export interface OptionSnapshot {
  readonly S: string;
  readonly f: DataSource;
  readonly contract: OccSymbol;
  /** Latest trade. */
  readonly lt?: OptionTrade;
  /** Latest quote. */
  readonly lq?: Quote;
  /** Latest minute bar. */
  readonly mb?: Bar;
  /** Today's bar. */
  readonly db?: Bar;
  /** The previous trading day's bar. */
  readonly pdb?: Bar;
  readonly greeks?: OptionGreeks;
  /** Implied volatility, as a fraction: `0.69` is 69%. */
  readonly iv?: number;
}
