export type PricePrecision = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const SCALES: ReadonlyArray<number> = [1, 10, 100, 1000, 10000, 100000, 1000000];

/**
 * Rounds a price to a fixed number of decimals.
 *
 * With no explicit precision the scale follows the magnitude — four decimals under
 * $10, three under $15, two above — which is what keeps a fractional cost basis on a
 * penny stock meaningful without carrying noise digits on a $400 one.
 *
 * Every cost basis and realised profit goes through this. Without it, repeatedly
 * averaging a position's entry cost accumulates binary floating-point error until a
 * position that should close flat reports a few thousandths of a cent of profit.
 */
export function roundPrice(price: number, precision?: PricePrecision): number {
  if (typeof precision === 'number') {
    const scale = SCALES[precision];
    if (scale !== undefined) {
      return normaliseZero(Math.round(price * scale) / scale);
    }
  }

  if (Math.abs(price) < 10) {
    return normaliseZero(Math.round(price * 10000) / 10000);
  }
  if (Math.abs(price) < 15) {
    return normaliseZero(Math.round(price * 1000) / 1000);
  }
  return normaliseZero(Math.round(price * 100) / 100);
}

/**
 * Collapses negative zero.
 *
 * Closing a position at exactly its cost basis computes `-4 * (100 - 100)`, which in
 * IEEE 754 is `-0`. It compares equal to zero, so nothing catches it, but it is not
 * the same value: it survives into the database, and anywhere a number is rendered
 * rather than compared it shows up as a realised profit of "-0".
 */
function normaliseZero(value: number): number {
  return value === 0 ? 0 : value;
}
