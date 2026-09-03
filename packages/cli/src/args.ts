import { isIsoDate, SortDirection } from '@fleece/shared';
import { InvalidArgumentError } from 'commander';

/**
 * Commander owns the grammar — which commands exist, which options are required, what
 * the help text says. What counts as a valid date, sort direction or positive number
 * lives here and is handed to commander as a parse callback, so a bad value is
 * rejected before any command body runs.
 */

export function parseIsoDate(value: string): string {
  if (!isIsoDate(value)) {
    throw new InvalidArgumentError('must be an Eastern calendar date in YYYY-MM-DD form, for example 2026-02-06');
  }
  return value;
}

export function parseSortDirection(value: string): SortDirection {
  if (value !== 'asc' && value !== 'desc') {
    throw new InvalidArgumentError('must be asc or desc');
  }
  return value;
}

export function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('must be a whole number greater than zero');
  }
  return parsed;
}

export function parsePositiveNumber(value: string): number {
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('must be a number greater than zero');
  }
  return parsed;
}

/**
 * A moment to page from. Accepts an ISO timestamp or epoch milliseconds, because a
 * date is what a person has and epoch millis is what the previous page returned.
 */
export function parseTimestamp(value: string): number {
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new InvalidArgumentError('must be an ISO timestamp or epoch milliseconds');
  }
  return parsed;
}
