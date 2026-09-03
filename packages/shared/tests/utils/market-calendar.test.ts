import { easternDate, isIsoDate, shiftIsoDate } from '../../src/utils/market-calendar';

describe('easternDate', () => {
  it("reports the Eastern date, not the host's", () => {
    // 03:00 UTC on the 31st is 23:00 Eastern on the 30th, still the same trading day.
    expect(easternDate(Date.parse('2026-08-31T03:00:00Z'))).toBe('2026-08-30');
  });

  it('rolls over at Eastern midnight', () => {
    expect(easternDate(Date.parse('2026-08-31T03:59:59Z'))).toBe('2026-08-30');
    expect(easternDate(Date.parse('2026-08-31T04:00:00Z'))).toBe('2026-08-31');
  });

  it('accounts for the offset changing with daylight saving', () => {
    // Eastern is UTC-5 in January and UTC-4 in July, so the same UTC clock time falls
    // on different sides of midnight depending on the season.
    expect(easternDate(Date.parse('2026-01-15T04:30:00Z'))).toBe('2026-01-14');
    expect(easternDate(Date.parse('2026-07-15T04:30:00Z'))).toBe('2026-07-15');
  });

  it('formats as ISO YYYY-MM-DD', () => {
    expect(easternDate(Date.parse('2026-03-05T15:00:00Z'))).toBe('2026-03-05');
  });
});

describe('shiftIsoDate', () => {
  it('moves forward and backward by whole days', () => {
    expect(shiftIsoDate('2026-08-31', 1)).toBe('2026-09-01');
    expect(shiftIsoDate('2026-08-31', -1)).toBe('2026-08-30');
  });

  it('crosses month and year boundaries', () => {
    expect(shiftIsoDate('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftIsoDate('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('handles a leap day', () => {
    expect(shiftIsoDate('2028-02-28', 1)).toBe('2028-02-29');
    expect(shiftIsoDate('2028-02-29', 1)).toBe('2028-03-01');
  });

  it('does not slip a day across a daylight-saving transition', () => {
    // US DST starts 2026-03-08 and ends 2026-11-01. Anchoring at midnight rather than
    // noon would land on the wrong side of one of these.
    expect(shiftIsoDate('2026-03-07', 1)).toBe('2026-03-08');
    expect(shiftIsoDate('2026-03-08', 1)).toBe('2026-03-09');
    expect(shiftIsoDate('2026-10-31', 1)).toBe('2026-11-01');
    expect(shiftIsoDate('2026-11-01', 1)).toBe('2026-11-02');
  });

  it('spans a month at a time, as the corporate-action window does', () => {
    expect(shiftIsoDate('2026-03-15', -30)).toBe('2026-02-13');
    expect(shiftIsoDate('2026-03-15', 30)).toBe('2026-04-14');
  });

  it('rejects anything that is not an ISO date', () => {
    expect(() => shiftIsoDate('2026-3-5', 1)).toThrow();
    expect(() => shiftIsoDate('not a date', 1)).toThrow();
  });
});

describe('isIsoDate', () => {
  it('accepts a zero-padded ISO date and rejects the rest', () => {
    expect(isIsoDate('2026-02-06')).toBe(true);
    expect(isIsoDate('2026-2-6')).toBe(false);
    expect(isIsoDate('06/02/2026')).toBe(false);
    expect(isIsoDate('')).toBe(false);
  });
});
