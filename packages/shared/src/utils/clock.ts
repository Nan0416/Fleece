import moment from 'moment-timezone';

/** Wall-clock time in a named IANA timezone, ported from the legacy `@qinnan/clock`. */

/** Narrower than moment's strict parse, which accepts `24:00:00`. */
const HH_MM_SS = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const DATE_FORMAT = 'YYYY-MM-DD';
const TIME_FORMAT = 'HH:mm:ss';

/**
 * True for a date that exists, not merely one shaped like a date.
 *
 * The shape alone was the whole check, and 2024-02-30 passed it — which mattered because
 * this is what the dividend service validates an ex-dividend date with before it becomes
 * part of a ledger row's primary key, and what the Polygon client validates a request
 * date with before deciding the market was shut that day.
 */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  // A day past the end of its month rolls into the next one, so the round trip is what
  // proves it existed. `setUTCFullYear` rather than `Date.UTC`, which reads a year under
  // 100 as 19xx.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export class Clock {
  constructor(readonly timezone: string) {
    // moment writes a line to the console for a zone it has no data for and then carries
    // on in UTC, which would silently date everything an hour or five out.
    if (moment.tz.zone(timezone) === null) {
      throw new Error(`Unknown timezone "${timezone}". Use an IANA name such as "America/New_York".`);
    }
  }

  /** `HH:mm:ss` */
  time(timestamp: number = Date.now()): string {
    return this.at(timestamp).format(TIME_FORMAT);
  }

  /** `YYYY-MM-DD` */
  date(timestamp: number = Date.now()): string {
    return this.at(timestamp).format(DATE_FORMAT);
  }

  /** `YYYY-MM-DDTHH:mm:ss±HH:mm` */
  datetime(timestamp: number = Date.now()): string {
    return this.at(timestamp).format(`${DATE_FORMAT}T${TIME_FORMAT}Z`);
  }

  /**
   * The instant this zone's clock reads `date` at `time`, defaulting to midnight.
   *
   * A time inside the hour skipped when the clocks go forward never happens; it comes
   * back as the instant an hour past the gap. A time inside the hour repeated when they
   * go back happens twice, and this is the first of the two.
   */
  timestamp(date: string, time: string = '00:00:00'): number {
    return this.wallClock(date, time).valueOf();
  }

  /** The calendar date `days` on from `date`, negative to go back. */
  shiftDate(date: string, days: number): string {
    return this.wallClock(date, '00:00:00').add(days, 'days').format(DATE_FORMAT);
  }

  nextDate(date: string = this.date(), days: number = 1): string {
    return this.shiftDate(date, days);
  }

  private at(timestamp: number): moment.Moment {
    return moment(timestamp).tz(this.timezone);
  }

  private wallClock(date: string, time: string): moment.Moment {
    if (!ISO_DATE.test(date)) {
      throw new Error(`Expected an ISO YYYY-MM-DD date, got "${date}"`);
    }
    if (!isIsoDate(date)) {
      throw new Error(`No such date: "${date}"`);
    }
    if (!HH_MM_SS.test(time)) {
      throw new Error(`Expected a 24-hour HH:mm:ss time, got "${time}"`);
    }
    return moment.tz(`${date} ${time}`, `${DATE_FORMAT} ${TIME_FORMAT}`, true, this.timezone);
  }
}

/** Eastern time, the zone US equity markets keep. */
export const easternClock = new Clock('America/New_York');

export const utcClock = new Clock('UTC');
