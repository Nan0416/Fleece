import { InvalidRequestError, isIsoDate } from '@fleece/shared';

import type { OccSymbol } from './data-models';

/**
 * `AAPL260918C00230000`: a root of one to five letters, the expiry as `YYMMDD`, `C` or
 * `P`, then the strike in thousandths of a dollar padded to eight digits.
 *
 * Alpaca validates against `^[A-Z]{1,5}\d{6,7}[CP]\d{8}$`, whose seven-digit date field
 * OCC does not define and no contract observed uses. Rejected rather than guessed at: a
 * seventh digit would shift every field after it, and a mis-parsed strike is worse than
 * no answer.
 */
const OCC = /^([A-Z]{1,5})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

/** Thousandths of a dollar, which is how OCC writes a strike. */
const MILS_PER_DOLLAR = 1000;

export function parseOccSymbol(symbol: string): OccSymbol | undefined {
  const match = OCC.exec(symbol);
  if (match === null) {
    return undefined;
  }
  const [, underlying, year, month, day, type, strike] = match;
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
      `${JSON.stringify(symbol)} is not an OCC contract symbol, so there is nothing to ${what}. They look like AAPL260918C00230000: ticker, YYMMDD, C or P, then the strike in thousandths of a dollar.`,
    );
  }
  return parsed;
}
