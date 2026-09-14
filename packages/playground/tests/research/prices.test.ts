import { requireOccSymbol } from '@fleece/marketdata';

import { findPrice, type MarketMinute } from '../../src/research/prices';

const CONTRACT = requireOccSymbol('SPY250411C00592000', 'build a fixture');

function minute(timestamp: number): MarketMinute {
  return { timestamp, stockSpotPrice: 100, optionPrices: new Map([[CONTRACT.symbol, { occSymbol: CONTRACT, price: 1, at: timestamp }]]) };
}

const SERIES = [minute(1_000), minute(2_000), minute(3_000)];

describe('findPrice', () => {
  it('answers with the minute asked for when one printed then', () => {
    expect(findPrice(2_000, SERIES)?.timestamp).toBe(2_000);
  });

  it('answers with the last minute before one that printed nothing', () => {
    // The series only has a row where something traded, so "the price at 2,500" is the
    // 2,000 print — the 3,000 one has not happened yet.
    expect(findPrice(2_500, SERIES)?.timestamp).toBe(2_000);
  });

  it('answers with the last minute of the session for any time after it', () => {
    expect(findPrice(9_999, SERIES)?.timestamp).toBe(3_000);
  });

  it('has nothing before the first print, rather than reaching forward to it', () => {
    expect(findPrice(999, SERIES)).toBeUndefined();
  });

  it('has nothing in an empty session', () => {
    expect(findPrice(2_000, [])).toBeUndefined();
  });
});
