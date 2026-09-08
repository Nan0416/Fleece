import { easternClock } from '@fleece/utilities';

import { isTradingDay, marketHour, marketHourByIndex, marketHoursCoverage, marketState } from '../src/market-hours';

const at = (isoUtc: string): number => Date.parse(isoUtc);

describe('isTradingDay', () => {
  it('accepts a weekday session and refuses a weekend', () => {
    expect(isTradingDay('2022-04-11')).toBe(true);
    expect(isTradingDay('2022-04-10')).toBe(false);
  });

  it('refuses a market holiday that falls on a weekday', () => {
    expect(isTradingDay('2021-01-01')).toBe(false);
    expect(isTradingDay('2024-01-01')).toBe(false);
    expect(isTradingDay('2024-11-28')).toBe(false);
  });

  it('counts a half day as a trading day', () => {
    expect(isTradingDay('2024-12-24')).toBe(true);
    expect(isTradingDay('2024-11-29')).toBe(true);
  });

  it('refuses a date outside the table rather than guessing', () => {
    expect(isTradingDay('2122-04-11')).toBe(false);
    expect(isTradingDay('1999-01-04')).toBe(false);
  });
});

describe('marketState', () => {
  it('walks a full session from closed through after-market and back', () => {
    // Eastern: 03:30, 09:00, 10:30, 15:30, 16:30, 20:30 on 2024-12-19.
    expect(marketState(at('2024-12-19T08:30:00Z'))).toBe('closed');
    expect(marketState(at('2024-12-19T13:00:00Z'))).toBe('pre_market');
    expect(marketState(at('2024-12-19T15:30:00Z'))).toBe('open');
    expect(marketState(at('2024-12-19T20:30:00Z'))).toBe('open');
    expect(marketState(at('2024-12-19T21:30:00Z'))).toBe('after_market');
    expect(marketState(at('2024-12-20T01:30:00Z'))).toBe('closed');
  });

  it('is closed all day on a non-trading day', () => {
    for (const time of ['06:00:00', '14:00:00', '18:00:00', '22:00:00']) {
      expect(marketState(easternClock.timestamp('2022-04-10', time))).toBe('closed');
    }
  });

  it('changes state exactly on the boundary, not a millisecond either side', () => {
    const session = marketHour('2024-12-19')!;
    expect(marketState(session.preMarketOpenAt - 1)).toBe('closed');
    expect(marketState(session.preMarketOpenAt)).toBe('pre_market');
    expect(marketState(session.openAt - 1)).toBe('pre_market');
    expect(marketState(session.openAt)).toBe('open');
    expect(marketState(session.closeAt - 1)).toBe('open');
    expect(marketState(session.closeAt)).toBe('after_market');
    expect(marketState(session.afterMarketCloseAt - 1)).toBe('after_market');
    expect(marketState(session.afterMarketCloseAt)).toBe('closed');
  });

  it('closes a half day at 13:00 Eastern, when a full day would still be open', () => {
    expect(marketState(easternClock.timestamp('2024-12-24', '12:30:00'))).toBe('open');
    expect(marketState(easternClock.timestamp('2024-12-24', '13:30:00'))).toBe('after_market');
    expect(marketState(easternClock.timestamp('2024-12-23', '13:30:00'))).toBe('open');
  });

  it('opens at 09:30 Eastern on both sides of a daylight-saving change', () => {
    // 2024 DST starts on the 10th, so the same 09:30 open is 14:30 UTC before it and
    // 13:30 UTC after.
    expect(marketState(at('2024-03-07T14:00:00Z'))).toBe('pre_market');
    expect(marketState(at('2024-03-07T14:30:00Z'))).toBe('open');
    expect(marketState(at('2024-03-15T13:00:00Z'))).toBe('pre_market');
    expect(marketState(at('2024-03-15T13:30:00Z'))).toBe('open');
  });

  it('gives the same answer walking a day forwards as sampling it at random', () => {
    // The day cache is only ever hit by the sequential walk, and must not change a state.
    const day = easternClock.timestamp('2024-10-09', '00:00:00');
    const sequential = Array.from({ length: 288 }, (_, i) => marketState(day + i * 300_000));
    const shuffled = Array.from({ length: 288 }, (_, i) => i)
      .sort(() => Math.random() - 0.5)
      .map((i) => ({ i, state: marketState(day + i * 300_000) }))
      .sort((a, b) => a.i - b.i)
      .map((entry) => entry.state);
    expect(shuffled).toStrictEqual(sequential);
  });

  it('survives crossing a day boundary in either direction', () => {
    expect(marketState(at('2024-12-19T15:30:00Z'))).toBe('open');
    expect(marketState(at('2024-12-18T15:30:00Z'))).toBe('open');
    expect(marketState(at('2024-12-21T15:30:00Z'))).toBe('closed');
    expect(marketState(at('2024-12-19T15:30:00Z'))).toBe('open');
  });

  it('reads closed for any date the table does not cover', () => {
    expect(marketState(easternClock.timestamp(easternClock.shiftDate(marketHoursCoverage.to, 30), '10:30:00'))).toBe('closed');
    expect(marketState(at('1998-06-16T15:30:00Z'))).toBe('closed');
  });
});

describe('marketHour', () => {
  it('takes a date or a timestamp and finds the same session', () => {
    expect(marketHour('2022-04-11')?.date).toBe('2022-04-11');
    expect(marketHour(at('2022-04-11T06:00:00Z'))?.date).toBe('2022-04-11');
  });

  it('resolves a timestamp by its Eastern date, not the host or UTC date', () => {
    // 01:00 UTC on the 20th is still the evening of the 19th in New York.
    expect(marketHour(at('2024-12-20T01:00:00Z'))?.date).toBe('2024-12-19');
  });

  it('has nothing for a non-trading day', () => {
    expect(marketHour('2022-04-10')).toBeUndefined();
    expect(marketHour(at('2022-04-10T14:00:00Z'))).toBeUndefined();
  });

  it('carries session boundaries that agree with its open and close times', () => {
    const session = marketHour('2024-12-19')!;
    expect(session.open).toBe('09:30');
    expect(session.close).toBe('16:00');
    expect(session.openAt).toBe(easternClock.timestamp('2024-12-19', '09:30:00'));
    expect(session.closeAt).toBe(easternClock.timestamp('2024-12-19', '16:00:00'));
    expect(session.preMarketOpenAt).toBe(easternClock.timestamp('2024-12-19', '04:00:00'));
    expect(session.afterMarketCloseAt).toBe(easternClock.timestamp('2024-12-19', '20:00:00'));
  });
});

describe('marketHourByIndex', () => {
  it('steps back to the previous session, skipping the weekend', () => {
    const monday = marketHour('2024-12-23')!;
    expect(marketHourByIndex(monday.index - 1)?.date).toBe('2024-12-20');
  });

  it('steps back across a holiday', () => {
    const afterThanksgiving = marketHour('2024-11-29')!;
    expect(marketHourByIndex(afterThanksgiving.index - 1)?.date).toBe('2024-11-27');
  });

  it('has nothing outside the table, at either end', () => {
    expect(marketHourByIndex(-1)).toBeUndefined();
    expect(marketHourByIndex(9_999_999)).toBeUndefined();
    expect(marketHourByIndex(marketHour(marketHoursCoverage.to)!.index + 1)).toBeUndefined();
  });

  it('indexes sessions in date order, with no gaps', () => {
    const first = marketHourByIndex(0)!;
    expect(first.date).toBe(marketHoursCoverage.from);
    expect(marketHourByIndex(first.index + 1)!.date > first.date).toBe(true);
  });
});

describe('the table itself', () => {
  it('reports the range it covers, so a caller can tell closed from unknown', () => {
    // Derived from the table rather than written down: refreshing the file moves the far
    // end, and a literal here would fail for the one reason that is not a regression.
    expect(marketHoursCoverage.from).toBe('2001-01-02');
    expect(isTradingDay(marketHoursCoverage.from)).toBe(true);
    expect(isTradingDay(marketHoursCoverage.to)).toBe(true);
    expect(marketHoursCoverage.to > marketHoursCoverage.from).toBe(true);
    expect(marketHour(easternClock.shiftDate(marketHoursCoverage.to, 1))).toBeUndefined();
  });

  it('opens before it closes, every session', () => {
    let index = 0;
    let session = marketHourByIndex(index);
    while (session !== undefined) {
      expect(session.preMarketOpenAt).toBeLessThan(session.openAt);
      expect(session.openAt).toBeLessThan(session.closeAt);
      expect(session.closeAt).toBeLessThanOrEqual(session.afterMarketCloseAt);
      index += 1;
      session = marketHourByIndex(index);
    }
    expect(marketHourByIndex(index - 1)?.date).toBe(marketHoursCoverage.to);
  });

  it('agrees with the clock on every stored boundary', () => {
    // The stored epochs were computed elsewhere, years ago. This is the cross-check that
    // they are the instants our own Eastern clock names for those wall-clock times.
    for (let index = 0; ; index += 1) {
      const session = marketHourByIndex(index);
      if (session === undefined) {
        break;
      }
      expect(session.openAt).toBe(easternClock.timestamp(session.date, `${session.open}:00`));
      expect(session.closeAt).toBe(easternClock.timestamp(session.date, `${session.close}:00`));
    }
  });

  it('never lists a weekend or a duplicate date', () => {
    const seen = new Set<string>();
    for (let index = 0; ; index += 1) {
      const session = marketHourByIndex(index);
      if (session === undefined) {
        break;
      }
      expect(seen.has(session.date)).toBe(false);
      seen.add(session.date);
      const weekday = new Date(`${session.date}T12:00:00Z`).getUTCDay();
      expect(weekday).toBeGreaterThanOrEqual(1);
      expect(weekday).toBeLessThanOrEqual(5);
    }
  });
});
