import { InvalidRequestError } from '@fleece/shared';

import { parseOccSymbol, requireOccSymbol } from '../src/occ-symbol';

describe('parsing an OCC contract symbol', () => {
  it('takes apart the underlying, the expiry, the type and the strike', () => {
    expect(parseOccSymbol('AAPL260918C00230000')).toEqual({
      symbol: 'AAPL260918C00230000',
      underlying: 'AAPL',
      expiration: '2026-09-18',
      type: 'call',
      strike: 230,
      strikeMils: 230000,
    });
  });

  it('reads P as a put', () => {
    expect(parseOccSymbol('SPY240216P00490000')?.type).toBe('put');
  });

  it('keeps the strike in mils, which is the exact number the dollar value is not', () => {
    const parsed = parseOccSymbol('F260116C00000105');
    expect(parsed?.strikeMils).toBe(105);
    expect(parsed?.strike).toBeCloseTo(0.105, 10);
  });

  it('takes a root shorter than four letters', () => {
    expect(parseOccSymbol('F260116C00012500')?.underlying).toBe('F');
  });

  it('reads the two-digit year as 20xx', () => {
    expect(parseOccSymbol('AAPL240119C00100000')?.expiration).toBe('2024-01-19');
  });

  it('refuses an expiry that is not a real date', () => {
    // Well-shaped and impossible: the format cannot say that February has 30 days.
    expect(parseOccSymbol('AAPL260230C00230000')).toBeUndefined();
  });

  it('refuses the seven-digit date Alpaca permits, rather than shifting every field after it', () => {
    // Alpaca validates against `\d{6,7}`; OCC defines six. A seventh digit would be read
    // as part of the strike, and a mis-parsed strike is worse than no answer.
    expect(parseOccSymbol('AAPL2609181C00230000')).toBeUndefined();
  });

  it.each(['AAPL', 'AAPL260918X00230000', 'aapl260918c00230000', 'AAPL260918C0023000', 'TOOLONG260918C00230000', ''])('refuses %s', (symbol) => {
    expect(parseOccSymbol(symbol)).toBeUndefined();
  });
});

describe('requiring an OCC contract symbol', () => {
  it('names the format and what could not be done, not just that it failed', () => {
    expect(() => requireOccSymbol('AAPL', 'fetch bars')).toThrow(InvalidRequestError);
    expect(() => requireOccSymbol('AAPL', 'fetch bars')).toThrow(/nothing to fetch bars.*AAPL260918C00230000/s);
  });
});
