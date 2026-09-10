/**
 * What each printed contract implies about volatility, and what that implies about risk.
 */
import { easternClock } from '@fleece/utilities';

import { blackScholesGreeks, impliedVolatility, type Greeks } from './black-scholes';
import type { MarketMinute } from './prices';

/** Equity options stop trading at the close on their expiration date. */
const EXPIRY_TIME = '16:00:00';
const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

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
