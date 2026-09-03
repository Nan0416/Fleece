/**
 * Sort direction for the paged listings.
 *
 * The legacy wire value for descending was `dec`, a misspelling of `desc` that every
 * caller had to reproduce exactly. Spelled correctly here; it is the one wire-visible
 * rename in the port.
 */
export type SortDirection = 'asc' | 'desc';

/**
 * A window into a time-ordered listing. `from` is an epoch-millisecond bound —
 * inclusive lower bound when ascending, inclusive upper bound when descending — so a
 * caller pages by passing back the timestamp of the last row it saw.
 */
export interface TimeWindowPage {
  readonly from: number;
  readonly limit: number;
  readonly sort: SortDirection;
}
