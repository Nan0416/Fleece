/**
 * Counting days to an expiration and ordering expirations by how near they are to a target,
 * shared by the strategies that pick a contract and the caches that measure one.
 */
import { utcClock } from '@fleece/utilities';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface DaysToExpirationWindow {
  readonly target: number;
  readonly min: number;
  readonly max: number;
}

/**
 * Calendar days from `date` to `expiration`, both ISO dates. Measured between their UTC
 * midnights, which are always exactly a day apart: Eastern midnights are 23 or 25 hours
 * apart across a daylight-saving change, so dividing those spans by a day is a fraction.
 */
export function daysToExpiration(date: string, expiration: string): number {
  return (utcClock.timestamp(expiration) - utcClock.timestamp(date)) / MS_PER_DAY;
}

/**
 * The expirations from `min` to `max` days out, nearest `target` first. Of two equally
 * near, the earlier comes first: less time is less exposure for the same distance.
 */
export function expirationsByPreference(expirations: Iterable<string>, date: string, window: DaysToExpirationWindow): ReadonlyArray<string> {
  return [...new Set(expirations)]
    .map((expiration) => ({ expiration, days: daysToExpiration(date, expiration) }))
    .filter(({ days }) => days >= window.min && days <= window.max)
    .sort((left, right) => Math.abs(left.days - window.target) - Math.abs(right.days - window.target) || left.days - right.days)
    .map(({ expiration }) => expiration);
}
