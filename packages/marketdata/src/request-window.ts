import { InternalServiceError, InvalidRequestError, easternClock, isIsoDate } from '@fleece/utilities';

import type { Bar, DateOrTimestamp, Timespan } from './data-models';
import { marketHoursCoverage, marketState } from './market-hours';

/**
 * The rules every provider client applies to a caller's window before it asks anyone
 * anything: that the dates are real, that they run forwards, and that the session table
 * actually covers them.
 *
 * Shared rather than copied because each of these started as a bug — a date that passed a
 * shape check and had no session, a range whose ends were the wrong way round, a table
 * that quietly reported every recent day as a holiday. A second client with its own copy
 * would get its own versions of them back.
 */

/**
 * Checked before the table is consulted, because the coverage test compares strings: a
 * typo sorts after the last date in the table and would tell an operator to go and
 * refresh a data file. Real, not merely well-shaped — 2024-02-30 has no session either.
 */
export function requireIsoDate(value: string, what: string): void {
  if (!isIsoDate(value)) {
    throw new InvalidRequestError(`Cannot ${what}: expected a real ISO YYYY-MM-DD calendar date, got "${value}".`);
  }
}

/**
 * `InternalServiceError`, not a provider error: nothing has been asked of a provider when
 * this throws, and nothing a caller sends can fix it. It is our shipped table disagreeing
 * with the dates we are asked about, which only refreshing the file clears.
 */
export function requireMarketHoursCover(date: string, what: string): void {
  requireIsoDate(date, what);
  if (date > marketHoursCoverage.to) {
    throw new InternalServiceError(`Cannot ${what} on ${date}: the market-hours table stops at ${marketHoursCoverage.to}. Refresh packages/marketdata/src/market-hours-data.json.`);
  }
  if (date < marketHoursCoverage.from) {
    throw new InternalServiceError(`Cannot ${what} on ${date}: the market-hours table starts at ${marketHoursCoverage.from}.`);
  }
}

export function startOfDay(value: DateOrTimestamp): number {
  if (typeof value === 'number') {
    return value;
  }
  requireIsoDate(value, 'read the start of the range');
  return easternClock.timestamp(value, '00:00:00');
}

export function endOfDay(value: DateOrTimestamp): number {
  if (typeof value === 'number') {
    return value;
  }
  requireIsoDate(value, 'read the end of the range');
  return easternClock.timestamp(value, '23:59:59');
}

export function requireForwardRange(from: number, to: number, what: string): void {
  if (from >= to) {
    throw new InvalidRequestError(`A ${what} request must start before it ends, got ${easternClock.datetime(from)} to ${easternClock.datetime(to)}.`);
  }
}

/**
 * Both ends of the range, because outside the table every bar reads as closed — a range
 * before the table starts empties exactly as silently as one after it ends. Checked
 * before the requests go out, since a two-decade minute range is hundreds of calls
 * against a paid API and refusing it afterwards spends every one of them first.
 */
export function requireCoveredRange(from: number, to: number, what: string): void {
  requireMarketHoursCover(easternClock.date(from), what);
  requireMarketHoursCover(easternClock.date(to), what);
}

/**
 * A bar of a day or longer already spans the whole session, so regular hours neither
 * apply to it nor need the table consulted — a weekly bar is stamped at the start of its
 * week, which is not a moment the market is open, and filtering by that empties the
 * result.
 */
const DAILY_OR_COARSER: ReadonlyArray<Timespan> = ['day', 'week', 'month', 'quarter', 'year'];

export function spansWholeSessions(timespan: Timespan): boolean {
  return DAILY_OR_COARSER.includes(timespan);
}

export function regularHoursOnly(bars: ReadonlyArray<Bar>): Bar[] {
  return bars.filter((bar) => marketState(bar.t) === 'open');
}
