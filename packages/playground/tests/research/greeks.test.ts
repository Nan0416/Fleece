import { requireOccSymbol } from '@fleece/marketdata';
import { easternClock } from '@fleece/utilities';

import { blackScholesPrice } from '../../src/research/black-scholes';
import { findGreek } from '../../src/research/greeks';
import type { MarketMinute } from '../../src/research/prices';

const CALL = requireOccSymbol('SPY250411C00592000', 'build a fixture');
const AT = easternClock.timestamp('2025-03-03', '10:00:00');
const EXPIRY = easternClock.timestamp('2025-04-11', '16:00:00');
const T_YEARS = (EXPIRY - AT) / (365 * 24 * 60 * 60 * 1000);
const RATE = 0.043;
const SPOT = 591.93;

function minute(price: number, spot: number | undefined, timestamp: number = AT): MarketMinute {
  return { timestamp, stockSpotPrice: spot, optionPrices: new Map([[CALL.symbol, { occSymbol: CALL, price, at: timestamp }]]) };
}

describe('findGreek', () => {
  it('recovers the volatility a price was made from, and the greeks that go with it', () => {
    const vol = 0.171;
    const price = blackScholesPrice({ spot: SPOT, strike: CALL.strike, vol, tYears: T_YEARS, rate: RATE, type: 'call' });
    const risk = findGreek(minute(price, SPOT), RATE).get(CALL.symbol);

    expect(risk?.impliedVolatility).toBeCloseTo(vol, 4);
    expect(risk?.tYears).toBeCloseTo(T_YEARS, 9);
    expect(risk?.price).toBe(price);
    // At the money with a month to run: just over half a delta, and losing money daily.
    expect(risk?.delta).toBeGreaterThan(0.5);
    expect(risk?.delta).toBeLessThan(0.6);
    expect(risk?.thetaPerDay).toBeLessThan(0);
    expect(risk?.gamma).toBeGreaterThan(0);
  });

  it('takes the dividend yield into account rather than ignoring the argument', () => {
    const price = blackScholesPrice({ spot: SPOT, strike: CALL.strike, vol: 0.171, tYears: T_YEARS, rate: RATE, type: 'call' });
    const without = findGreek(minute(price, SPOT), RATE).get(CALL.symbol);
    const with12Bps = findGreek(minute(price, SPOT), RATE, 0.012).get(CALL.symbol);

    expect(with12Bps?.impliedVolatility).toBeGreaterThan(without?.impliedVolatility ?? 0);
  });

  it('says nothing about a minute the underlying did not print in', () => {
    expect(findGreek(minute(14.18, undefined), RATE).size).toBe(0);
  });

  it('leaves out a contract already expired rather than dividing by no time', () => {
    const afterExpiry = easternClock.timestamp('2025-04-14', '10:00:00');
    expect(findGreek(minute(14.18, SPOT, afterExpiry), RATE).size).toBe(0);
  });

  it('leaves out a print no volatility explains, rather than fabricating one', () => {
    // Below intrinsic: this contract is 592 strike against a 700 spot. A multi-leg print
    // carries one leg's share of a package and lands here all the time.
    expect(findGreek(minute(1, 700), RATE).size).toBe(0);
  });
});
