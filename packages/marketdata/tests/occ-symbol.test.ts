import { InvalidRequestError } from '@fleece/utilities';

import { parseOccSymbol, requireOccSymbol } from '../src/occ-symbol';

describe('parsing an OCC contract symbol', () => {
  it('takes apart the underlying, the expiry, the type and the strike', () => {
    expect(parseOccSymbol('AAPL260918C00230000')).toEqual({
      symbol: 'AAPL260918C00230000',
      underlying: 'AAPL',
      root: 'AAPL',
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

  it('reads a trailing root digit as an adjusted contract, not as part of the date', () => {
    // The fields anchor from the right, so the suffix cannot shift the expiry or the
    // strike. This is the form a split or a spinoff re-issues a contract under, and it is
    // why Alpaca validates against `\d{6,7}`.
    expect(parseOccSymbol('AAPL1260918C00230000')).toEqual({
      symbol: 'AAPL1260918C00230000',
      underlying: 'AAPL',
      root: 'AAPL1',
      expiration: '2026-09-18',
      type: 'call',
      strike: 230,
      strikeMils: 230000,
    });
  });

  it('reads a leading root digit as an adjusted contract, which is how Alpaca writes one', () => {
    // Alpaca serves AAPL's re-issued December 2025 puts under root `1AAPL`, not `AAPL1`.
    expect(parseOccSymbol('1AAPL251219P00193000')).toEqual({
      symbol: '1AAPL251219P00193000',
      underlying: 'AAPL',
      root: '1AAPL',
      expiration: '2025-12-19',
      type: 'put',
      strike: 193,
      strikeMils: 193000,
    });
  });

  it('reads either adjustment form to the same contract, which is the point of reading both', () => {
    const leading = parseOccSymbol('1AAPL251219P00193000');
    const trailing = parseOccSymbol('AAPL1251219P00193000');

    expect(leading?.underlying).toBe(trailing?.underlying);
    expect(leading?.expiration).toBe(trailing?.expiration);
    expect(leading?.strikeMils).toBe(trailing?.strikeMils);
    expect([leading?.root, trailing?.root]).toEqual(['1AAPL', 'AAPL1']);
  });

  it('reads an adjusted contract to the same expiry and strike as its ordinary twin', () => {
    const ordinary = parseOccSymbol('GOOGL260918P00230000');
    const adjusted = parseOccSymbol('GOOGL1260918P00230000');

    expect(adjusted?.expiration).toBe(ordinary?.expiration);
    expect(adjusted?.strikeMils).toBe(ordinary?.strikeMils);
    expect(adjusted?.type).toBe(ordinary?.type);
    expect([ordinary?.root, adjusted?.root]).toEqual(['GOOGL', 'GOOGL1']);
  });

  it('says an ordinary contract is unadjusted by giving it a root equal to its underlying', () => {
    const parsed = parseOccSymbol('F260116C00012500');
    expect(parsed?.root).toBe(parsed?.underlying);
  });

  it('refuses two trailing root digits, which OCC does not define', () => {
    expect(parseOccSymbol('AAPL12260918C00230000')).toBeUndefined();
  });

  it.each(['AAPL', 'AAPL260918X00230000', 'aapl260918c00230000', 'AAPL260918C0023000', 'TOOLONG260918C00230000', ''])('refuses %s', (symbol) => {
    expect(parseOccSymbol(symbol)).toBeUndefined();
  });
});

describe('requiring an OCC contract symbol', () => {
  it('takes an adjusted contract, which Alpaca serves history for', () => {
    expect(requireOccSymbol('AAPL1260918C00230000', 'fetch bars').root).toBe('AAPL1');
  });

  it('names the format and what could not be done, not just that it failed', () => {
    expect(() => requireOccSymbol('AAPL', 'fetch bars')).toThrow(InvalidRequestError);
    expect(() => requireOccSymbol('AAPL', 'fetch bars')).toThrow(/nothing to fetch bars.*AAPL260918C00230000/s);
  });
});
