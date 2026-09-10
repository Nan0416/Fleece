/**
 * Black-Scholes pricing, greeks and an implied-volatility solver, with a continuous
 * dividend yield.
 *
 * Ported from `thetad`'s `packages/engine/src/core/black-scholes.ts`, with `OptionRight`
 * swapped for this repo's `OptionType` so it composes with a parsed `OccSymbol`. The
 * arithmetic is unchanged.
 *
 * Floats throughout, deliberately: these are estimates about the future, not ledger
 * entries. Rates, vols and yields are decimals — `0.05` is 5%.
 */
import type { OptionType } from '@fleece/marketdata';

/** Abramowitz & Stegun 7.1.26, |error| < 1.5e-7. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

export function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

export function normPdf(x: number): number {
  return Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI);
}

export interface BlackScholesInput {
  readonly spot: number;
  readonly strike: number;
  /** Annualised implied volatility as a decimal, so `0.20` is 20 vol. */
  readonly vol: number;
  /** Time to expiration in years. */
  readonly tYears: number;
  /** Annualised risk-free rate as a decimal. */
  readonly rate: number;
  /** Annualised continuous dividend yield as a decimal. Defaults to none. */
  readonly dividendYield?: number;
  readonly type: OptionType;
}

export interface Greeks {
  readonly delta: number;
  /** Per $1 of spot. */
  readonly gamma: number;
  /** Per calendar day. */
  readonly thetaPerDay: number;
  /** Per vol point, so per 0.01 of `vol`. */
  readonly vegaPerPoint: number;
}

const DAYS_PER_YEAR = 365;
const VOL_POINTS_PER_UNIT = 100;

function d1d2({ spot, strike, vol, tYears, rate, dividendYield = 0 }: BlackScholesInput): readonly [number, number] {
  const sqrtT = Math.sqrt(tYears);
  const d1 = (Math.log(spot / strike) + (rate - dividendYield + (vol * vol) / 2) * tYears) / (vol * sqrtT);
  return [d1, d1 - vol * sqrtT];
}

function requireUsable({ spot, strike, vol, tYears, rate, dividendYield = 0 }: BlackScholesInput): void {
  if (![spot, strike, vol, tYears, rate, dividendYield].every(Number.isFinite)) {
    throw new RangeError('Black-Scholes inputs must all be finite.');
  }
  if (spot <= 0) {
    throw new RangeError(`spot must be above zero, got ${spot}.`);
  }
  if (strike <= 0) {
    throw new RangeError(`strike must be above zero, got ${strike}.`);
  }
  if (vol <= 0) {
    throw new RangeError(`vol must be above zero, got ${vol}.`);
  }
  if (tYears < 0) {
    throw new RangeError(`tYears must not be negative, got ${tYears}.`);
  }
}

export function blackScholesPrice(input: BlackScholesInput): number {
  requireUsable(input);
  const { spot, strike, tYears, rate, dividendYield = 0, type } = input;
  if (tYears === 0) {
    return Math.max(type === 'call' ? spot - strike : strike - spot, 0);
  }
  const [d1, d2] = d1d2(input);
  const discountRate = Math.exp(-rate * tYears);
  const discountYield = Math.exp(-dividendYield * tYears);
  return type === 'call' ? spot * discountYield * normCdf(d1) - strike * discountRate * normCdf(d2) : strike * discountRate * normCdf(-d2) - spot * discountYield * normCdf(-d1);
}

export function blackScholesGreeks(input: BlackScholesInput): Greeks {
  requireUsable(input);
  const { spot, strike, vol, tYears, rate, dividendYield = 0, type } = input;
  if (tYears === 0) {
    const inTheMoney = type === 'call' ? spot > strike : spot < strike;
    const sign = type === 'call' ? 1 : -1;
    return { delta: inTheMoney ? sign : 0, gamma: 0, thetaPerDay: 0, vegaPerPoint: 0 };
  }

  const [d1, d2] = d1d2(input);
  const sqrtT = Math.sqrt(tYears);
  const discountRate = Math.exp(-rate * tYears);
  const discountYield = Math.exp(-dividendYield * tYears);
  const delta = type === 'call' ? discountYield * normCdf(d1) : discountYield * (normCdf(d1) - 1);
  const gamma = (discountYield * normPdf(d1)) / (spot * vol * sqrtT);
  const carry =
    type === 'call'
      ? rate * strike * discountRate * normCdf(d2) - dividendYield * spot * discountYield * normCdf(d1)
      : -rate * strike * discountRate * normCdf(-d2) + dividendYield * spot * discountYield * normCdf(-d1);
  const thetaAnnual = (-spot * discountYield * normPdf(d1) * vol) / (2 * sqrtT) - carry;
  const vega = spot * discountYield * normPdf(d1) * sqrtT;

  return { delta, gamma, thetaPerDay: thetaAnnual / DAYS_PER_YEAR, vegaPerPoint: vega / VOL_POINTS_PER_UNIT };
}

/**
 * Bisection, and `undefined` rather than a number when the price has no implied
 * volatility at all — which is not a rare case on real prints. A bar's close below
 * intrinsic or above the underlying is outside the no-arbitrage band, and a multi-leg
 * print carries one leg's share of a package rather than a price for the contract.
 */
export function impliedVolatility(price: number, input: Omit<BlackScholesInput, 'vol'>, tolerance = 1e-6): number | undefined {
  const { spot, strike, tYears, rate, dividendYield = 0, type } = input;
  requireUsable({ ...input, vol: 1 });
  if (!Number.isFinite(price) || price < 0) {
    return undefined;
  }
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    throw new RangeError(`tolerance must be finite and above zero, got ${tolerance}.`);
  }
  if (tYears === 0) {
    return undefined;
  }

  const discountedSpot = spot * Math.exp(-dividendYield * tYears);
  const discountedStrike = strike * Math.exp(-rate * tYears);
  const floor = type === 'call' ? Math.max(discountedSpot - discountedStrike, 0) : Math.max(discountedStrike - discountedSpot, 0);
  const ceiling = type === 'call' ? discountedSpot : discountedStrike;
  const priceTolerance = 1e-12 * Math.max(1, ceiling);
  if (price < floor - priceTolerance || price >= ceiling || Math.abs(price - floor) <= priceTolerance) {
    return undefined;
  }

  let low = 0;
  let high = 1;
  while (blackScholesPrice({ ...input, vol: high }) < price) {
    high *= 2;
    // The approximated normal CDF may never reach the analytic ceiling exactly.
    if (!Number.isFinite(high)) {
      return undefined;
    }
  }
  for (let step = 0; step < 200 && high - low > tolerance; step += 1) {
    const mid = (low + high) / 2;
    if (blackScholesPrice({ ...input, vol: mid }) < price) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return (low + high) / 2;
}
