import { blackScholesGreeks, blackScholesPrice, impliedVolatility } from '../../src/research/black-scholes';

const base = { spot: 100, strike: 100, tYears: 0.25, rate: 0.05, type: 'call' as const };

describe('black-scholes pricing', () => {
  it('satisfies put-call parity, which is the one identity that needs no model', () => {
    const input = { ...base, vol: 0.2, dividendYield: 0.01 };
    const call = blackScholesPrice(input);
    const put = blackScholesPrice({ ...input, type: 'put' });
    const forward = input.spot * Math.exp(-input.dividendYield * input.tYears) - input.strike * Math.exp(-input.rate * input.tYears);

    expect(call - put).toBeCloseTo(forward, 9);
  });

  it('prices a contract at expiry as its intrinsic value', () => {
    expect(blackScholesPrice({ ...base, vol: 0.2, tYears: 0, spot: 110 })).toBe(10);
    expect(blackScholesPrice({ ...base, vol: 0.2, tYears: 0, spot: 90 })).toBe(0);
    expect(blackScholesPrice({ ...base, vol: 0.2, tYears: 0, spot: 90, type: 'put' })).toBe(10);
  });

  it('is worth more with more volatility, and more time', () => {
    const cheap = blackScholesPrice({ ...base, vol: 0.15 });
    expect(blackScholesPrice({ ...base, vol: 0.3 })).toBeGreaterThan(cheap);
    expect(blackScholesPrice({ ...base, vol: 0.15, tYears: 1 })).toBeGreaterThan(cheap);
  });

  it.each([
    ['spot', { spot: 0 }],
    ['strike', { strike: -1 }],
    ['vol', { vol: 0 }],
    ['tYears', { tYears: -0.1 }],
    ['a non-finite rate', { rate: Number.NaN }],
  ])('refuses an impossible %s rather than answering with NaN', (_case, override) => {
    expect(() => blackScholesPrice({ ...base, vol: 0.2, ...override })).toThrow(RangeError);
  });
});

describe('greeks', () => {
  it('puts an at-the-money call just above a half delta, and its put just below zero', () => {
    const call = blackScholesGreeks({ ...base, vol: 0.2 });
    const put = blackScholesGreeks({ ...base, vol: 0.2, type: 'put' });

    expect(call.delta).toBeGreaterThan(0.5);
    expect(call.delta).toBeLessThan(0.6);
    // Parity again: the two deltas differ by one, discounted for the yield.
    expect(call.delta - put.delta).toBeCloseTo(1, 9);
  });

  it('charges theta and pays vega, in the units the names promise', () => {
    const greeks = blackScholesGreeks({ ...base, vol: 0.2 });
    const oneDayOn = blackScholesPrice({ ...base, vol: 0.2, tYears: base.tYears - 1 / 365 });
    const onePointUp = blackScholesPrice({ ...base, vol: 0.21 });

    expect(greeks.thetaPerDay).toBeLessThan(0);
    expect(greeks.thetaPerDay).toBeCloseTo(oneDayOn - blackScholesPrice({ ...base, vol: 0.2 }), 3);
    expect(greeks.vegaPerPoint).toBeCloseTo(onePointUp - blackScholesPrice({ ...base, vol: 0.2 }), 3);
  });

  it('has an expired contract at a delta of one or nothing, and no other risk', () => {
    expect(blackScholesGreeks({ ...base, vol: 0.2, tYears: 0, spot: 110 })).toEqual({ delta: 1, gamma: 0, thetaPerDay: 0, vegaPerPoint: 0 });
    expect(blackScholesGreeks({ ...base, vol: 0.2, tYears: 0, spot: 90 })).toEqual({ delta: 0, gamma: 0, thetaPerDay: 0, vegaPerPoint: 0 });
    expect(blackScholesGreeks({ ...base, vol: 0.2, tYears: 0, spot: 90, type: 'put' }).delta).toBe(-1);
  });
});

describe('the implied volatility solver', () => {
  it.each([0.08, 0.2, 0.65, 1.8])('recovers a volatility of %p from the price it produces', (vol) => {
    const price = blackScholesPrice({ ...base, vol });
    expect(impliedVolatility(price, base)).toBeCloseTo(vol, 4);
  });

  it('recovers one for a put and for a contract far from the money', () => {
    expect(impliedVolatility(blackScholesPrice({ ...base, vol: 0.35, type: 'put' }), { ...base, type: 'put' })).toBeCloseTo(0.35, 4);
    expect(impliedVolatility(blackScholesPrice({ ...base, vol: 0.35, strike: 140 }), { ...base, strike: 140 })).toBeCloseTo(0.35, 4);
  });

  it.each([
    ['a price below intrinsic', 0.01],
    ['a price above the underlying', 200],
    ['a negative price', -1],
  ])('says nothing rather than inventing a number for %s', (_case, price) => {
    expect(impliedVolatility(price, { ...base, strike: 50 })).toBeUndefined();
  });

  it('says nothing for a contract with no time left, which has no volatility to imply', () => {
    expect(impliedVolatility(10, { ...base, tYears: 0, spot: 110 })).toBeUndefined();
  });
});
