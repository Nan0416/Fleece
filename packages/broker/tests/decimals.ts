import { Decimal } from '@fleece/shared';

/** Terse enough to keep a table of cases readable. */
export function d(value: string | number): Decimal {
  return Decimal.of(value);
}

/**
 * A `Decimal` for an expectation.
 *
 * Compared as strings rather than with `toEqual`, which reads a `Decimal` as an opaque
 * object and reports "two objects differ" without saying by how much.
 */
export function shows(value: Decimal | undefined): string | undefined {
  return value?.toString();
}
