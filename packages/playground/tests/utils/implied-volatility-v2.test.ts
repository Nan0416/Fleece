import { requireOccSymbol, type OccSymbol } from '@fleece/marketdata';

import {
  atTheMoneyVolatility,
  constantMaturityVolatility,
  ImpliedVolatilityHistoryV2,
  type ExpirationVolatility,
  type SpotPriceWithOptionPrice,
} from '../../src/utils/implied-volatility-v2';
import type { OptionsAvailabilitiesHelper } from '../../src/utils/options-availabilities';

const DAY_YEARS = 1 / 365;

function trade(symbol: string, spotPrice: number, iv: number): SpotPriceWithOptionPrice {
  const occSymbol: OccSymbol = requireOccSymbol(symbol, 'build a fixture');
  return { time: 0, spotPrice, optionPrice: 1, iv, occSymbol };
}

function expiration(days: number, iv: number): ExpirationVolatility {
  const put = trade('AAPL260417P00095000', 100, iv);
  const call = trade('AAPL260417C00105000', 100, iv);
  return { expiration: `in ${days} days`, tYears: days * DAY_YEARS, iv, put, call };
}

describe('atTheMoneyVolatility', () => {
  it('interpolates to the money in log-moneyness between the nearest out-of-the-money put and call', () => {
    const put = trade('AAPL260417P00095000', 100, 0.3);
    const call = trade('AAPL260417C00110000', 100, 0.2);
    const atTheMoney = atTheMoneyVolatility([put, call]);

    // ln(0.95) = -0.0513 and ln(1.10) = 0.0953, so the money is 35% of the way from the put to the call.
    const share = -Math.log(0.95) / (Math.log(1.1) - Math.log(0.95));
    expect(atTheMoney?.iv).toBeCloseTo(0.3 + (0.2 - 0.3) * share, 12);
    expect(atTheMoney?.put).toBe(put);
    expect(atTheMoney?.call).toBe(call);
  });

  it('uses only the nearest strike on each side, whatever else traded further out', () => {
    const nearPut = trade('AAPL260417P00098000', 100, 0.25);
    const nearCall = trade('AAPL260417C00102000', 100, 0.25);
    const wings = [trade('AAPL260417P00090000', 100, 0.45), trade('AAPL260417C00109000', 100, 0.4)];

    expect(atTheMoneyVolatility([...wings, nearPut, nearCall])?.iv).toBeCloseTo(0.25, 12);
  });

  it('judges each side against the stock at the minute that contract traded', () => {
    // At 97, a 98 call is out of the money and a 98 put is not.
    const put = trade('AAPL260417P00095000', 97, 0.3);
    const inTheMoneyPut = trade('AAPL260417P00098000', 97, 0.9);
    const call = trade('AAPL260417C00098000', 97, 0.3);

    expect(atTheMoneyVolatility([put, inTheMoneyPut, call])?.put).toBe(put);
  });

  it('has nothing to say without a put and a call', () => {
    expect(atTheMoneyVolatility([trade('AAPL260417P00095000', 100, 0.3)])).toBeUndefined();
    expect(atTheMoneyVolatility([trade('AAPL260417C00105000', 100, 0.3)])).toBeUndefined();
    expect(atTheMoneyVolatility([])).toBeUndefined();
  });
});

describe('constantMaturityVolatility', () => {
  const target = 30 * DAY_YEARS;

  it('interpolates total variance between the expirations either side of the target', () => {
    const near = expiration(20, 0.3);
    const next = expiration(40, 0.2);
    const measured = constantMaturityVolatility([next, expiration(10, 0.9), near, expiration(60, 0.1)], target);

    // Half the weight on each: (0.5 × 0.09 × 20 + 0.5 × 0.04 × 40) / 30.
    expect(measured?.iv).toBeCloseTo(Math.sqrt((0.5 * 0.09 * 20 + 0.5 * 0.04 * 40) / 30), 12);
    expect(measured?.near).toBe(near);
    expect(measured?.next).toBe(next);
  });

  it('takes an expiration exactly at the target as it is', () => {
    const exact = expiration(30, 0.27);
    const measured = constantMaturityVolatility([expiration(20, 0.3), exact], target);
    expect(measured?.iv).toBeCloseTo(0.27, 12);
  });

  it('uses the one side there is rather than extrapolating past it', () => {
    expect(constantMaturityVolatility([expiration(24, 0.3)], target)).toMatchObject({ iv: 0.3, next: undefined });
    expect(constantMaturityVolatility([expiration(36, 0.2)], target)).toMatchObject({ iv: 0.2, near: undefined });
  });

  it('has nothing to say without an expiration', () => {
    expect(constantMaturityVolatility([], target)).toBeUndefined();
  });
});

describe('ImpliedVolatilityHistoryV2', () => {
  const availabilities: OptionsAvailabilitiesHelper = { cachePath: '/nowhere', save: async () => {}, availableOptions: async () => [], refreshedAt: async () => undefined };

  it('refuses a window whose target is outside what it measures', () => {
    const build = (min: number, target: number, max: number) => () =>
      new ImpliedVolatilityHistoryV2({ symbol: 'AAPL', dividendYield: 0, availabilities, daysToExpiration: { min, target, max } });

    expect(build(23, 30, 37)).not.toThrow();
    expect(build(31, 30, 37)).toThrow('min ≤ target ≤ max');
    expect(build(23, 40, 37)).toThrow('min ≤ target ≤ max');
    expect(build(-1, 30, 37)).toThrow('min ≤ target ≤ max');
  });
});
