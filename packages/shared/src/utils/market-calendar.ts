/**
 * US equity markets keep Eastern time, and the dates that matter here — an
 * ex-dividend date, a split execution date, "which trading day was that fill on" —
 * are Eastern calendar dates rather than instants.
 *
 * Deriving them from the host's local time is the bug this exists to prevent: the
 * same fill is dated differently depending on where the process runs, and a job run
 * after 20:00 Pacific books everything to tomorrow.
 */
const EASTERN_DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The Eastern calendar date at `timestamp`, as ISO `YYYY-MM-DD`. */
export function easternDate(timestamp: number = Date.now()): string {
  // 'en-CA' formats as YYYY-MM-DD, which is the ISO form these dates are stored in.
  return EASTERN_DATE_FORMAT.format(new Date(timestamp));
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  return ISO_DATE.test(value);
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Shifts an ISO date by whole days.
 *
 * Anchored at noon UTC rather than midnight so that a daylight-saving transition —
 * which moves Eastern midnight by an hour — cannot push the result onto the
 * neighbouring day.
 */
export function shiftIsoDate(date: string, days: number): string {
  if (!isIsoDate(date)) {
    throw new Error(`Expected an ISO YYYY-MM-DD date, got "${date}"`);
  }
  const anchor = Date.parse(`${date}T12:00:00Z`);
  return EASTERN_DATE_FORMAT.format(new Date(anchor + days * ONE_DAY_MS));
}
