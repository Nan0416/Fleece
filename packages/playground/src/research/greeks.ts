/**
 * What each printed contract implies about volatility, and what that implies about risk.
 */
import { blackScholesGreeks, impliedVolatility, type Greeks, type OccSymbol } from '@fleece/marketdata';
import { easternClock } from '@fleece/utilities';

/** Equity options stop trading at the close on their expiration date. */
const EXPIRY_TIME = '16:00:00';
const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

export interface OptionPrice {
  readonly occSymbol: OccSymbol;
  /** The minute bar's close, per share. A contract cost this times its multiplier. */
  readonly price: number;
  /**
   * The minute that close printed in, which is at or before the enclosing
   * `MarketMinute.timestamp` — the only way to tell a fresh price from a stale one.
   */
  readonly at: number;
}

/**
 * The market at one minute: what the underlying closed that minute at, and what each
 * contract did.
 *
 * `stockSpotPrice` is absent for a minute the underlying itself did not print in, which
 * happens even in liquid names.
 *
 * `optionPrices` holds contracts at their last close as of this minute, because an option
 * chain is mostly silent minute to minute and a strategy needs its legs quoted at the same
 * instant. A price is therefore not necessarily one anyone traded at this minute — `at`
 * says which minute it came from.
 */
export interface MarketMinute {
  readonly timestamp: number;
  readonly stockSpotPrice?: number;
  /** Keyed by OCC contract symbol. */
  readonly optionPrices: ReadonlyMap<string, OptionPrice>;
}

export interface ContractRisk extends Greeks {
  /** Annualised, as a decimal: `0.31` is 31 vol. */
  readonly impliedVolatility: number;
  /** The price the volatility was solved out of. */
  readonly price: number;
  /** Years to the close on expiration day, counted in calendar time. */
  readonly tYears: number;
}

/**
 * Keyed by OCC contract symbol.
 *
 * A contract is **absent** rather than carrying nulls when nothing can be said about it:
 * no spot to price against, an expiration already past, or a close outside the
 * no-arbitrage band. That last one is not rare — a bar's close can be one leg's share of
 * a spread rather than a price for the contract alone — and a strategy that reads a
 * fabricated delta will size a position on it.
 */
export function findGreek(prices: MarketMinute, riskFreeRate: number, dividendYield = 0): ReadonlyMap<string, ContractRisk> {
  const risks = new Map<string, ContractRisk>();
  const spot = prices.stockSpotPrice;
  if (spot === undefined || spot <= 0) {
    return risks;
  }

  for (const [symbol, quoted] of prices.optionPrices) {
    const { occSymbol, price } = quoted;
    const tYears = (easternClock.timestamp(occSymbol.expiration, EXPIRY_TIME) - prices.timestamp) / MS_PER_YEAR;
    if (tYears <= 0 || price <= 0) {
      continue;
    }

    const input = { spot, strike: occSymbol.strike, tYears, rate: riskFreeRate, dividendYield, type: occSymbol.type };
    const vol = impliedVolatility(price, input);
    if (vol === undefined) {
      continue;
    }
    risks.set(symbol, { ...blackScholesGreeks({ ...input, vol }), impliedVolatility: vol, price, tYears });
  }
  return risks;
}
