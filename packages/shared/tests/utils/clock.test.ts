import { Clock, easternClock, isIsoDate, utcClock } from '../../src/utils/clock';

// These run on a host in Pacific time, so every Eastern assertion is also a statement
// that the clock ignores where the process runs. US transitions: forward at 07:00 UTC on
// the second Sunday in March, back at 06:00 UTC on the first Sunday in November.
describe('Clock', () => {
  const tokyoClock = new Clock('Asia/Tokyo');

  describe('time', () => {
    it('reads the time of day in its own zone', () => {
      expect(easternClock.time(1647990783933)).toBe('19:13:03');
      expect(easternClock.time(1643796083123)).toBe('05:01:23');
    });

    it('reads a different time from the same instant in a different zone', () => {
      const instant = Date.parse('2026-06-15T16:30:00Z');
      expect(utcClock.time(instant)).toBe('16:30:00');
      expect(easternClock.time(instant)).toBe('12:30:00');
      expect(tokyoClock.time(instant)).toBe('01:30:00');
    });

    it('skips the hour the clocks go forward', () => {
      expect(easternClock.time(Date.parse('2022-03-13T06:59:59Z'))).toBe('01:59:59');
      expect(easternClock.time(Date.parse('2022-03-13T07:00:00Z'))).toBe('03:00:00');
    });

    it('reads the repeated hour twice when the clocks go back', () => {
      expect(easternClock.time(Date.parse('2021-11-07T04:30:00Z'))).toBe('00:30:00');
      expect(easternClock.time(Date.parse('2021-11-07T05:30:00Z'))).toBe('01:30:00');
      expect(easternClock.time(Date.parse('2021-11-07T06:30:00Z'))).toBe('01:30:00');
      expect(easternClock.time(Date.parse('2021-11-07T07:30:00Z'))).toBe('02:30:00');
    });

    it('reports midnight as 00:00:00, not 24:00:00', () => {
      expect(easternClock.time(Date.parse('2026-06-15T04:00:00Z'))).toBe('00:00:00');
    });
  });

  describe('date', () => {
    it('reads the calendar date in its own zone', () => {
      expect(easternClock.date(1647990783933)).toBe('2022-03-22');
      expect(easternClock.date(1643796083123)).toBe('2022-02-02');
    });

    it('is still yesterday in New York when it is already tomorrow in Tokyo', () => {
      const instant = Date.parse('2026-06-16T02:00:00Z');
      expect(easternClock.date(instant)).toBe('2026-06-15');
      expect(utcClock.date(instant)).toBe('2026-06-16');
      expect(tokyoClock.date(instant)).toBe('2026-06-16');
    });

    it('rolls over at midnight in its own zone', () => {
      expect(easternClock.date(Date.parse('2026-08-31T03:59:59Z'))).toBe('2026-08-30');
      expect(easternClock.date(Date.parse('2026-08-31T04:00:00Z'))).toBe('2026-08-31');
    });

    it('accounts for the offset changing with daylight saving', () => {
      expect(easternClock.date(Date.parse('2026-01-15T04:30:00Z'))).toBe('2026-01-14');
      expect(easternClock.date(Date.parse('2026-07-15T04:30:00Z'))).toBe('2026-07-15');
    });

    it('zero-pads the month and day', () => {
      expect(easternClock.date(Date.parse('2026-01-05T15:00:00Z'))).toBe('2026-01-05');
    });
  });

  describe('datetime', () => {
    it('carries the offset in force at that instant', () => {
      expect(easternClock.datetime(1647990783933)).toBe('2022-03-22T19:13:03-04:00');
      expect(easternClock.datetime(1643796083123)).toBe('2022-02-02T05:01:23-05:00');
    });

    it('writes UTC as +00:00 and a zone ahead of UTC with a plus', () => {
      const instant = Date.parse('2026-06-15T16:30:00Z');
      expect(utcClock.datetime(instant)).toBe('2026-06-15T16:30:00+00:00');
      expect(tokyoClock.datetime(instant)).toBe('2026-06-16T01:30:00+09:00');
    });

    it('writes a half-hour offset in minutes', () => {
      expect(new Clock('Asia/Kolkata').datetime(Date.parse('2026-06-15T16:30:00Z'))).toBe('2026-06-15T22:00:00+05:30');
    });

    it('drops sub-second precision rather than rounding into the next second', () => {
      expect(utcClock.datetime(Date.parse('2026-06-15T16:30:00.999Z'))).toBe('2026-06-15T16:30:00+00:00');
    });
  });

  describe('timestamp', () => {
    it('names the instant its zone reads that date and time', () => {
      expect(easternClock.timestamp('2022-03-22', '19:13:03')).toBe(Date.parse('2022-03-22T23:13:03Z'));
      expect(utcClock.timestamp('2022-03-22', '19:13:03')).toBe(Date.parse('2022-03-22T19:13:03Z'));
    });

    it('defaults to midnight in its zone, not to midnight UTC', () => {
      expect(easternClock.timestamp('2026-06-15')).toBe(Date.parse('2026-06-15T04:00:00Z'));
      expect(easternClock.timestamp('2026-01-15')).toBe(Date.parse('2026-01-15T05:00:00Z'));
    });

    it('round-trips every method, on both sides of both transitions', () => {
      for (const date of ['2026-01-15', '2026-03-08', '2026-07-04', '2026-11-01', '2026-11-02']) {
        for (const time of ['00:00:00', '09:30:00', '16:00:00', '23:59:59']) {
          const instant = easternClock.timestamp(date, time);
          expect(easternClock.date(instant)).toBe(date);
          expect(easternClock.time(instant)).toBe(time);
        }
      }
    });

    it('moves a time inside the spring-forward gap past it', () => {
      // 02:30 on 2022-03-13 in New York never happens: 02:00 becomes 03:00.
      const instant = easternClock.timestamp('2022-03-13', '02:30:00');
      expect(instant).toBe(Date.parse('2022-03-13T07:30:00Z'));
      expect(easternClock.time(instant)).toBe('03:30:00');
    });

    it('resolves the hour after the gap without shifting it', () => {
      expect(easternClock.timestamp('2022-03-13', '03:30:00')).toBe(Date.parse('2022-03-13T07:30:00Z'));
    });

    it('resolves a fall-back morning to the time asked for', () => {
      const instant = easternClock.timestamp('2021-11-07', '02:30:00');
      expect(instant).toBe(Date.parse('2021-11-07T07:30:00Z'));
      expect(easternClock.time(instant)).toBe('02:30:00');
    });

    it('takes the first of the two readings of a repeated hour', () => {
      // 01:30 on 2021-11-07 happens twice in New York; this is the earlier, still EDT.
      expect(easternClock.timestamp('2021-11-07', '01:30:00')).toBe(Date.parse('2021-11-07T05:30:00Z'));
    });

    it('rejects a date that is not ISO YYYY-MM-DD', () => {
      expect(() => easternClock.timestamp('2026-3-5')).toThrow(/YYYY-MM-DD/);
      expect(() => easternClock.timestamp('03/05/2026')).toThrow(/YYYY-MM-DD/);
      expect(() => easternClock.timestamp('')).toThrow(/YYYY-MM-DD/);
    });

    it('rejects a date the calendar does not have, rather than rolling it over', () => {
      expect(() => easternClock.timestamp('2026-02-31')).toThrow(/No such date/);
      expect(() => easternClock.timestamp('2026-13-01')).toThrow(/No such date/);
      expect(() => easternClock.timestamp('2027-02-29')).toThrow(/No such date/);
      expect(easternClock.date(easternClock.timestamp('2028-02-29'))).toBe('2028-02-29');
    });

    it('rejects a time that is not 24-hour HH:mm:ss', () => {
      expect(() => easternClock.timestamp('2026-06-15', '9:30:00')).toThrow(/HH:mm:ss/);
      expect(() => easternClock.timestamp('2026-06-15', '09:30')).toThrow(/HH:mm:ss/);
      expect(() => easternClock.timestamp('2026-06-15', '24:00:00')).toThrow(/HH:mm:ss/);
      expect(() => easternClock.timestamp('2026-06-15', '09:60:00')).toThrow(/HH:mm:ss/);
      expect(() => easternClock.timestamp('2026-06-15', '09:30:00 PM')).toThrow(/HH:mm:ss/);
    });
  });

  describe('shiftDate', () => {
    it('moves forward and backward by whole days', () => {
      expect(easternClock.shiftDate('2026-08-31', 1)).toBe('2026-09-01');
      expect(easternClock.shiftDate('2026-08-31', -1)).toBe('2026-08-30');
      expect(easternClock.shiftDate('2026-08-31', 0)).toBe('2026-08-31');
    });

    it('crosses month, year and leap-day boundaries', () => {
      expect(easternClock.shiftDate('2026-01-01', -1)).toBe('2025-12-31');
      expect(easternClock.shiftDate('2026-12-31', 1)).toBe('2027-01-01');
      expect(easternClock.shiftDate('2028-02-28', 1)).toBe('2028-02-29');
      expect(easternClock.shiftDate('2028-02-29', 1)).toBe('2028-03-01');
    });

    it('spans a month at a time, as the corporate-action window does', () => {
      expect(easternClock.shiftDate('2026-03-15', -30)).toBe('2026-02-13');
      expect(easternClock.shiftDate('2026-03-15', 30)).toBe('2026-04-14');
    });

    it('does not slip a day across a daylight-saving transition', () => {
      // Counting 24-hour spans instead of calendar days returns 2026-11-01 for itself:
      // midnight plus 24 hours is 23:00 the same evening on the day the clocks go back.
      expect(easternClock.shiftDate('2026-11-01', 1)).toBe('2026-11-02');
      expect(easternClock.shiftDate('2026-10-31', 1)).toBe('2026-11-01');
      expect(easternClock.shiftDate('2026-03-07', 1)).toBe('2026-03-08');
      expect(easternClock.shiftDate('2026-03-08', 1)).toBe('2026-03-09');
      expect(easternClock.shiftDate('2026-11-02', -1)).toBe('2026-11-01');
      expect(easternClock.shiftDate('2026-03-09', -1)).toBe('2026-03-08');
    });

    it('spans a year of Eastern dates without repeating or skipping one', () => {
      const seen = new Set<string>();
      let date = '2025-12-31';
      for (let day = 0; day < 366; day += 1) {
        date = easternClock.shiftDate(date, 1);
        seen.add(date);
      }
      expect(seen.size).toBe(366);
      expect(date).toBe('2027-01-01');
    });

    it('rejects anything that is not an ISO date', () => {
      expect(() => easternClock.shiftDate('2026-3-5', 1)).toThrow(/YYYY-MM-DD/);
      expect(() => easternClock.shiftDate('not a date', 1)).toThrow(/YYYY-MM-DD/);
      expect(() => easternClock.shiftDate('2026-02-31', 1)).toThrow(/No such date/);
    });
  });

  describe('nextDate', () => {
    it('advances one day by default', () => {
      expect(easternClock.nextDate('2026-06-15')).toBe('2026-06-16');
    });

    it('takes a count of days, forward or back', () => {
      expect(easternClock.nextDate('2026-06-15', 30)).toBe('2026-07-15');
      expect(easternClock.nextDate('2026-06-15', -1)).toBe('2026-06-14');
    });

    it('defaults to today in its own zone', () => {
      expect(easternClock.nextDate()).toBe(easternClock.shiftDate(easternClock.date(), 1));
    });
  });

  describe('construction', () => {
    it('keeps the zone it was given', () => {
      expect(easternClock.timezone).toBe('America/New_York');
      expect(utcClock.timezone).toBe('UTC');
    });

    it('refuses a zone it has no data for, rather than quietly running in UTC', () => {
      expect(() => new Clock('America/Nowhere')).toThrow(/Unknown timezone/);
    });
  });

  describe('the current instant', () => {
    it('is what each method reads when no timestamp is given', () => {
      const before = Date.now();
      const date = utcClock.date();
      const time = utcClock.time();
      const datetime = utcClock.datetime();
      const after = Date.now();

      for (const reading of [utcClock.timestamp(date, time), Date.parse(datetime)]) {
        expect(reading).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
        expect(reading).toBeLessThanOrEqual(after);
      }
    });
  });
});

describe('isIsoDate', () => {
  it('accepts a zero-padded ISO date and rejects the rest', () => {
    expect(isIsoDate('2026-02-06')).toBe(true);
    expect(isIsoDate('2026-2-6')).toBe(false);
    expect(isIsoDate('06/02/2026')).toBe(false);
    expect(isIsoDate('')).toBe(false);
  });

  it('rejects a date that is shaped right but does not exist', () => {
    // The shape alone was the whole check, and these all passed it — including as an
    // ex-dividend date, which is part of a ledger row's primary key.
    expect(isIsoDate('2024-02-30')).toBe(false);
    expect(isIsoDate('2026-06-31')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('2026-00-10')).toBe(false);
    expect(isIsoDate('2026-01-00')).toBe(false);
  });

  it('knows which Februaries have a 29th', () => {
    expect(isIsoDate('2024-02-29')).toBe(true);
    expect(isIsoDate('2023-02-29')).toBe(false);
    expect(isIsoDate('2000-02-29')).toBe(true);
    expect(isIsoDate('1900-02-29')).toBe(false);
  });

  it('reads a year under 100 as itself, not as the twentieth century', () => {
    expect(isIsoDate('0050-01-01')).toBe(true);
  });
});
