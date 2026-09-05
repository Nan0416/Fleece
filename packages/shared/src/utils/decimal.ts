import { Decimal as DecimalJs } from 'decimal.js';
import { InternalServiceError } from '../errors';

/**
 * Exact decimal arithmetic. The only numeric type the ledger accounts in.
 *
 * **Why not `number`.** A ledger's failure mode is a number that is quietly wrong, and
 * IEEE 754 supplies them for free: `0.1 + 0.2` is not `0.3`, and a cost basis averaged
 * repeatedly drifts until a position that should close flat reports a fraction of a
 * cent of profit. The old `roundPrice` existed to bound that drift. Nothing bounds it
 * here because nothing produces it.
 *
 * **What exact decimals do and do not buy.** They do not abolish rounding — average
 * cost is a division, and `(100 x 4.13 + 50 x 4.27) / 150` does not terminate in base
 * ten either. What they buy is that rounding becomes a decision made in one place at a
 * stated scale, rather than an artefact of binary representation appearing wherever two
 * numbers happen to meet. Addition and subtraction become exact, sums stop drifting,
 * and Postgres and TypeScript agree on the same total.
 *
 * **Why a facade rather than `decimal.js` directly.** `decimal.js` is configured on the
 * constructor, and `Decimal.set(...)` anywhere in the process changes the arithmetic
 * everywhere in it. `clone` below takes a private constructor with its own settings, so
 * a dependency that configures the shared one cannot reach the ledger's. Nothing
 * outside this file sees a `decimal.js` type.
 */

/**
 * Decimal places carried by every stored quantity, and the default scale for a
 * division.
 *
 * Nine covers what the instruments need — Alpaca quotes fractional shares to nine
 * places and crypto needs the room — and money is stored at the same scale even though
 * it is conceptually two. The spare digits are not there to be displayed: they absorb
 * the residue when a cost basis is apportioned across a partial sale, which is what
 * lets the residue be conserved by subtraction instead of quietly lost.
 */
export const LEDGER_SCALE = 9;

/**
 * A private `decimal.js` constructor. `clone` rather than `set` so this configuration
 * is ours alone and no other importer of `decimal.js` shares or overwrites it.
 *
 * `ROUND_HALF_EVEN` — banker's rounding — because the ledger rounds an apportioned cost
 * basis thousands of times and half-up would bias realised profit in one direction
 * every time a tie came up. Ties are broken toward the even digit instead, which has no
 * long-run bias.
 *
 * `toExpNeg`/`toExpPos` are pushed out of reach so nothing ever renders as `1e-7`: these
 * values are written into `NUMERIC` columns as text, and exponent notation would be a
 * parse error at the far end.
 */
const D = DecimalJs.clone({
  precision: 40,
  rounding: DecimalJs.ROUND_HALF_EVEN,
  toExpNeg: -9e15,
  toExpPos: 9e15,
});

/**
 * What a `Decimal` can be built from.
 *
 * `number` is accepted for literals and whole counts — `Decimal.of(100)`, a multiplier
 * of `1` — and is exact for those. Do not pass a number that is itself the result of
 * floating-point arithmetic: it arrives carrying whatever error produced it, and this
 * type cannot tell the difference.
 */
export type DecimalInput = string | number | bigint;

/**
 * Builds the underlying value, turning both ways it can fail into one `InternalServiceError`
 * that names where the bad value came from.
 *
 * `decimal.js` throws a `DecimalError` of its own for a string it cannot parse and
 * returns a non-finite value for `Infinity` or `NaN`, so checking `isFinite` alone lets
 * the first case escape as a bare `Error` — which guideline 28 reserves for a bug, and
 * which surfaces as a 500 saying nothing about which row could not be read.
 */
function construct(value: string | number, context: string): InstanceType<typeof D> {
  let inner: InstanceType<typeof D>;
  try {
    inner = new D(value);
  } catch {
    throw new InternalServiceError(`${context} is not a decimal.`);
  }
  if (!inner.isFinite()) {
    throw new InternalServiceError(`${context} is not a finite decimal.`);
  }
  return inner;
}

export class Decimal {
  static readonly ZERO = new Decimal(new D(0));
  static readonly ONE = new Decimal(new D(1));

  private constructor(private readonly inner: InstanceType<typeof D>) {}

  /** Builds from a literal. Throws rather than producing a NaN that spreads silently. */
  static of(value: DecimalInput): Decimal {
    return new Decimal(construct(typeof value === 'bigint' ? value.toString() : value, `"${String(value)}"`));
  }

  /**
   * Reads a value back out of a `NUMERIC` column.
   *
   * node-postgres hands `NUMERIC` back as a string precisely so that no precision is
   * lost on the way, which is the whole reason the columns are `NUMERIC` and this
   * function takes a string.
   */
  static parse(text: string, context: string): Decimal {
    return new Decimal(construct(text, context));
  }

  /** Exact: no rounding, at any scale. */
  add(other: Decimal): Decimal {
    return new Decimal(this.inner.plus(other.inner));
  }

  /** Exact: no rounding, at any scale. */
  sub(other: Decimal): Decimal {
    return new Decimal(this.inner.minus(other.inner));
  }

  /**
   * Exact up to `precision` significant digits, which no realistic size times price
   * comes close to. Round explicitly afterwards if the result is to be stored.
   */
  mul(other: Decimal): Decimal {
    return new Decimal(this.inner.times(other.inner));
  }

  /**
   * The only operation that must lose information, so the scale is not optional.
   *
   * There are three call sites in the whole ledger: apportioning a cost basis across a
   * partial reduction, splitting one transaction's cost across a position flip, and
   * deriving a unit price for display. Every one of them names its scale here, and the
   * first two conserve the residue by deriving the other half with `sub` rather than a
   * second division.
   */
  div(divisor: Decimal, scale: number): Decimal {
    if (divisor.isZero()) {
      throw new InternalServiceError('Division by zero in ledger arithmetic.');
    }
    return new Decimal(this.inner.dividedBy(divisor.inner).toDecimalPlaces(scale, D.ROUND_HALF_EVEN));
  }

  neg(): Decimal {
    return new Decimal(this.inner.negated());
  }

  abs(): Decimal {
    return new Decimal(this.inner.absoluteValue());
  }

  round(scale: number): Decimal {
    return new Decimal(this.inner.toDecimalPlaces(scale, D.ROUND_HALF_EVEN));
  }

  cmp(other: Decimal): -1 | 0 | 1 {
    const result = this.inner.comparedTo(other.inner);
    return result < 0 ? -1 : result > 0 ? 1 : 0;
  }

  eq(other: Decimal): boolean {
    return this.inner.equals(other.inner);
  }

  lt(other: Decimal): boolean {
    return this.inner.lessThan(other.inner);
  }

  lte(other: Decimal): boolean {
    return this.inner.lessThanOrEqualTo(other.inner);
  }

  gt(other: Decimal): boolean {
    return this.inner.greaterThan(other.inner);
  }

  gte(other: Decimal): boolean {
    return this.inner.greaterThanOrEqualTo(other.inner);
  }

  isZero(): boolean {
    return this.inner.isZero();
  }

  isNegative(): boolean {
    return this.inner.isNegative() && !this.inner.isZero();
  }

  isPositive(): boolean {
    return this.inner.isPositive() && !this.inner.isZero();
  }

  /** 0 for zero, whatever sign the zero carries. */
  signum(): -1 | 0 | 1 {
    if (this.inner.isZero()) {
      return 0;
    }
    return this.inner.isNegative() ? -1 : 1;
  }

  /**
   * Plain decimal notation, never exponent notation, and never `-0`.
   *
   * This is what goes into a `NUMERIC` parameter and what comes back out of `toJSON`,
   * so it has to round-trip exactly. `-0` is collapsed because closing a position at
   * exactly its cost basis computes it, it compares equal to zero so nothing catches
   * it, and it renders as a realised profit of "-0" wherever a number is shown.
   */
  toString(): string {
    if (this.inner.isZero()) {
      return '0';
    }
    return this.inner.toFixed();
  }

  /**
   * A **string** on the wire, never a JSON number.
   *
   * `JSON.parse` produces a double, so serialising a decimal as a JSON number would
   * undo every guarantee in this file at the process boundary — silently, and only for
   * the values too precise to survive, which are exactly the ones worth having.
   */
  toJSON(): string {
    return this.toString();
  }

  /** Lossy by construction. For display and for arithmetic that is not accounting. */
  toNumber(): number {
    return this.inner.toNumber();
  }

  /** Fixed decimal places, for rendering. */
  toFixed(scale: number): string {
    return this.inner.toFixed(scale, D.ROUND_HALF_EVEN);
  }
}

/** Exact, whatever the length. Addition never rounds. */
export function sumDecimals(values: ReadonlyArray<Decimal>): Decimal {
  return values.reduce((total, value) => total.add(value), Decimal.ZERO);
}
