import { InvalidRequestError, isIsoDate } from '@fleece/utilities';

import type { OccSymbol } from './data-models';

/**
 * `AAPL260918C00230000`: a root, the expiry as `YYMMDD`, `C` or `P`, then the strike in
 * thousandths of a dollar padded to eight digits.
 *
 * The fields anchor from the right — the type and strike are a fixed nine-character tail
 * and the expiry is the six digits before it — so the root is whatever is left, and a
 * root carrying a trailing digit parses to the same expiry and strike as one without.
 *
 * That digit is how OCC writes an **adjusted** contract, one a split, a spinoff or a
 * special dividend re-issued, and it is why Alpaca validates against `\d{6,7}` rather
 * than `\d{6}`. An adjusted contract does not deliver 100 shares, which this system
 * models in `@fleece/models`'s asset classes and prices for in `@fleece/broker`, so
 * refusing to read one would be refusing to read exactly the contract that needs care.
 */
const OCC = /^([A-Z]{1,5})(\d?)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

/** Thousandths of a dollar, which is how OCC writes a strike. */
const MILS_PER_DOLLAR = 1000;

export function parseOccSymbol(symbol: string): OccSymbol | undefined {
  const match = OCC.exec(symbol);
  if (match === null) {
    return undefined;
  }
  const [, underlying, suffix, year, month, day, type, strike] = match;
  // The two-digit year is read as 20xx, which every listed option is: the format cannot
  // express 1999 and Alpaca's option history begins in 2024.
  const expiration = `20${year}-${month}-${day}`;
  if (!isIsoDate(expiration)) {
    return undefined;
  }
  const strikeMils = Number(strike);
  return {
    symbol,
    underlying,
    root: `${underlying}${suffix}`,
    expiration,
    type: type === 'C' ? 'call' : 'put',
    strike: strikeMils / MILS_PER_DOLLAR,
    strikeMils,
  };
}

/** For a symbol a caller supplied, where a bad one is their mistake to hear about. */
export function requireOccSymbol(symbol: string, what: string): OccSymbol {
  const parsed = parseOccSymbol(symbol);
  if (parsed === undefined) {
    throw new InvalidRequestError(
      `${JSON.stringify(symbol)} is not an OCC contract symbol, so there is nothing to ${what}. They look like AAPL260918C00230000: root, YYMMDD, C or P, then the strike in thousandths of a dollar.`,
    );
  }
  return parsed;
}
