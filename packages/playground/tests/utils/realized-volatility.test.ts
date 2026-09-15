import {
  marketHour,
  type Bar,
  type BarsResponse,
  type DailyBarsRequest,
  type DateOrTimestamp,
  type MarketHour,
  type MinuteBarsRequest,
  type QuotesResponse,
  type StockRestClient,
  type StockSplitsResponse,
  type TradesResponse,
} from '@fleece/marketdata';
import { easternClock } from '@fleece/utilities';

import {
  annualizedVolatility,
  calendarClockVolatility,
  closeToCloseVariance,
  HistoricalRealizedVolatility,
  HistoricalRealizedVolatilityLoader,
  intradayPlusOvernightVariance,
  intradayVariance,
  measureSession,
  realizedAfter,
  sessionsWithin,
  trailingVariance,
  yangZhangVariance,
  type RealizedVolatilityPoint,
  type SessionReturns,
} from '../../src/utils/realized-volatility';

const MINUTE = 60_000;

function hour(date: string): MarketHour {
  const session = marketHour(date);
  if (session === undefined) {
    throw new Error(`${date} is not a session in the market-hours table, so it cannot be a fixture.`);
  }
  return session;
}

function bar(date: string, time: string, prices: Partial<Pick<Bar, 'o' | 'h' | 'l' | 'c'>>): Bar {
  const c = prices.c ?? 100;
  return { S: 'AAPL', o: prices.o ?? c, h: prices.h ?? c, l: prices.l ?? c, c, v: 1, t: easternClock.timestamp(date, time) };
}

/** A session with only the returns the estimators read, and an intraday variance at 5 minutes. */
function session(date: string, overnight: number, openToClose: number, rogersSatchell = 0, intraday5 = 0): SessionReturns {
  return {
    date,
    gapDays: 1,
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    overnight,
    openToClose,
    closeToClose: overnight + openToClose,
    rogersSatchell,
    intraday: [{ minutes: 5, variance: intraday5 }],
  };
}

describe('intradayVariance', () => {
  const day = hour('2024-03-04');

  it('sums the squared returns between each bucket’s last close, from the official open to the official close', () => {
    // Bucket 0 ends on 102, bucket 1 has no trade, bucket 2 ends on 100, and the last bucket is
    // the close whatever traded in it.
    const bars = [
      bar('2024-03-04', '09:30:00', { c: 101 }),
      bar('2024-03-04', '09:31:00', { c: 102 }),
      bar('2024-03-04', '09:40:00', { c: 100 }),
      bar('2024-03-04', '15:58:00', { c: 99 }),
    ];
    const expected = Math.log(102 / 100) ** 2 + Math.log(100 / 102) ** 2 + Math.log(103 / 100) ** 2;

    expect(intradayVariance(bars, day, 100, 103, 5)).toBeCloseTo(expected, 15);
  });

  it('sees at one minute a round trip that a 5-minute bucket closes over', () => {
    const bars = [bar('2024-03-04', '09:30:00', { c: 110 }), bar('2024-03-04', '09:31:00', { c: 100 })];

    expect(intradayVariance(bars, day, 100, 100, 1)).toBeCloseTo(2 * Math.log(1.1) ** 2, 15);
    expect(intradayVariance(bars, day, 100, 100, 5)).toBe(0);
  });

  it('ignores a bar outside the session', () => {
    const bars = [bar('2024-03-04', '09:29:00', { c: 150 }), bar('2024-03-04', '16:00:00', { c: 150 })];
    expect(intradayVariance(bars, day, 100, 100, 5)).toBe(0);
  });
});

describe('measureSession', () => {
  it('splits the day at the official open, with a weekend as one gap', () => {
    const friday = bar('2024-03-01', '00:00:00', { c: 100 });
    const monday = bar('2024-03-04', '00:00:00', { o: 102, h: 106, l: 101, c: 104 });
    const measured = measureSession(monday, friday, hour('2024-03-04'), hour('2024-03-01'), []);

    const u = Math.log(106 / 102);
    const d = Math.log(101 / 102);
    const c = Math.log(104 / 102);
    expect(measured.gapDays).toBe(3);
    expect(measured.overnight).toBeCloseTo(Math.log(1.02), 15);
    expect(measured.openToClose).toBeCloseTo(c, 15);
    expect(measured.closeToClose).toBeCloseTo(Math.log(1.04), 15);
    expect(measured.rogersSatchell).toBeCloseTo(u * (u - c) + d * (d - c), 15);
  });
});

describe('the trailing estimators', () => {
  it('reads a steady slide as volatility rather than subtracting it as the mean', () => {
    expect(closeToCloseVariance([session('a', -0.01, 0), session('b', -0.01, 0)])).toBeCloseTo(0.0001, 15);
  });

  it('adds each session’s overnight gap to its intraday path at the interval asked for', () => {
    expect(intradayPlusOvernightVariance([session('a', 0.02, 0, 0, 0.0003), session('b', 0, 0, 0, 0.0001)], 5)).toBeCloseTo((0.0004 + 0.0003 + 0.0001) / 2, 15);
    expect(() => intradayPlusOvernightVariance([session('a', 0, 0)], 1)).toThrow('no intraday variance at 1 minutes');
  });

  it('weighs Yang-Zhang’s sample variances and Rogers-Satchell as published', () => {
    const sessions = [session('a', 0.01, 0.02, 0.0003), session('b', -0.02, 0, 0.0001), session('c', 0.01, -0.02, 0.0002)];
    // Both means are zero; σ²_O = 0.0006 / 2, σ²_C = 0.0008 / 2, and k = 0.34 / (1.34 + 4 / 2).
    const k = 0.34 / 3.34;
    expect(yangZhangVariance(sessions)).toBeCloseTo(0.0003 + k * 0.0004 + (1 - k) * 0.0002, 15);
  });

  it('refuses Yang-Zhang over a single session, which has no sample variance', () => {
    expect(() => yangZhangVariance([session('a', 0.01, 0.01)])).toThrow('at least two sessions');
  });

  it('says how much of the intraday-plus-overnight variance the gaps are', () => {
    expect(trailingVariance([session('a', 0.01, 0, 0, 0.0003), session('b', 0.01, 0, 0, 0.0001)], 5).overnightShare).toBeCloseTo(0.0001 / 0.0003, 15);
  });
});

describe('the clocks', () => {
  it('counts only the sessions a stretch of calendar days holds', () => {
    // March 2024 after the 1st: four full weeks, less Good Friday on the 29th.
    expect(sessionsWithin('2024-03-01', 30)).toBe(19);
  });

  it('restates a variance per session as the total those sessions carry, per calendar year', () => {
    expect(annualizedVolatility(0.0001)).toBeCloseTo(Math.sqrt(0.0252), 15);
    expect(calendarClockVolatility(0.0001, '2024-03-01', 30)).toBeCloseTo(Math.sqrt((0.0001 * 19 * 365) / 30), 15);
  });
});

describe('realizedAfter', () => {
  const week = [
    session('2024-03-01', 0.05, 0),
    session('2024-03-04', -0.03, 0.01),
    session('2024-03-05', 0, 0.01),
    session('2024-03-06', 0.01, 0),
    session('2024-03-07', 0, 0),
    session('2024-03-08', 0, 0.02),
  ];

  it('sums close-to-close variance over the sessions after the date, on the calendar clock', () => {
    const after = realizedAfter(week, '2024-03-01', 7);
    const variance = 0.02 ** 2 + 0.01 ** 2 + 0.01 ** 2 + 0 + 0.02 ** 2;

    expect(after?.sessions).toBe(5);
    expect(after?.variance).toBeCloseTo(variance, 15);
    expect(after?.volatility).toBeCloseTo(Math.sqrt((variance * 365) / 7), 15);
    // The 1st's own gap is before the window.
    expect(after?.largestGap).toBeCloseTo(0.03, 15);
  });

  it('has nothing to say until every session in the window is there', () => {
    expect(realizedAfter(week, '2024-03-04', 7)).toBeUndefined();
    expect(realizedAfter(week.slice(0, 3), '2024-03-01', 7)).toBeUndefined();
  });
});

/**
 * Serves daily bars for every session between the dates asked for, rising a percent a session, and
 * two minute bars for each except the dates in `withoutMinuteBars`. Keeps every request.
 */
class FakeStockClient implements StockRestClient {
  readonly requests: Array<{ readonly span: string } & DailyBarsRequest> = [];

  constructor(private readonly withoutMinuteBars: ReadonlyArray<string> = []) {}

  async dailyBars(request: DailyBarsRequest): Promise<BarsResponse> {
    this.requests.push({ span: 'day', ...request });
    return { bars: this.sessions(request).map((date, index) => bar(date, '00:00:00', { o: 100 * 1.01 ** index, c: 100 * 1.01 ** (index + 0.5) })) };
  }

  async minuteBars(request: MinuteBarsRequest): Promise<BarsResponse> {
    this.requests.push({ span: 'minute', ...request });
    const dates = this.sessions(request).filter((date) => !this.withoutMinuteBars.includes(date));
    return { bars: dates.flatMap((date) => [bar(date, '09:30:00', { c: 100 }), bar(date, '12:00:00', { c: 101 })]) };
  }

  async bars(): Promise<BarsResponse> {
    throw new Error('The loader reads daily and minute bars only.');
  }

  async trades(): Promise<TradesResponse> {
    throw new Error('The loader reads daily and minute bars only.');
  }

  async quotes(): Promise<QuotesResponse> {
    throw new Error('The loader reads daily and minute bars only.');
  }

  async stockSplits(): Promise<StockSplitsResponse> {
    throw new Error('The loader asks for split-adjusted bars rather than the splits.');
  }

  private sessions(request: { readonly from: DateOrTimestamp; readonly to?: DateOrTimestamp }): string[] {
    if (typeof request.from !== 'string' || typeof request.to !== 'string') {
      throw new Error('The fake serves whole dates, and the loader asks for them.');
    }
    const dates: string[] = [];
    for (let date = request.from; date <= request.to; date = easternClock.shiftDate(date, 1)) {
      if (marketHour(date) !== undefined) {
        dates.push(date);
      }
    }
    return dates;
  }
}

function loader(client: FakeStockClient, fromDate = '2024-03-06', toDate = '2024-03-08'): HistoricalRealizedVolatilityLoader {
  return new HistoricalRealizedVolatilityLoader({ symbol: 'aapl', client, fromDate, toDate, window: 2, intradayMinutes: 5 });
}

describe('HistoricalRealizedVolatilityLoader', () => {
  it('fetches split-adjusted bars from a window and a previous close before the range', async () => {
    const client = new FakeStockClient();
    await loader(client).load();

    // Two sessions of window and one previous close before the 6th: the 5th, the 4th and Friday the 1st.
    expect(client.requests).toEqual([
      { span: 'day', symbol: 'AAPL', from: '2024-03-01', to: '2024-03-08', adjustForSplit: true },
      { span: 'minute', symbol: 'AAPL', from: '2024-03-01', to: '2024-03-08', adjustForSplit: true },
    ]);
  });

  it('takes a point for each session in the range, over the window ending with it, known once its close is published', async () => {
    const history = loader(new FakeStockClient());
    await history.load();

    const points = history.getPoints();
    expect(points.map((point) => point.date)).toEqual(['2024-03-06', '2024-03-07', '2024-03-08']);
    expect(points[0].publishedAt).toBe(hour('2024-03-06').closeAt + MINUTE + 4_000);

    const sessions = history.getSessions();
    const [fifth, sixth] = sessions.filter((s) => s.date === '2024-03-05' || s.date === '2024-03-06');
    expect(points[0].trailing.closeToClose).toBeCloseTo((fifth.closeToClose ** 2 + sixth.closeToClose ** 2) / 2, 15);
    expect(sessions.map((s) => s.date)).toEqual(['2024-03-04', '2024-03-05', '2024-03-06', '2024-03-07', '2024-03-08']);
  });

  it('stops at the last session whose close was published when it loads, rather than measuring one still trading', async () => {
    for (const now of [easternClock.timestamp('2024-03-08', '12:00:00'), easternClock.timestamp('2024-03-08', '16:01:04')]) {
      const client = new FakeStockClient();
      const history = loader(client);
      await history.load(now);

      expect(client.requests.map((request) => request.to)).toEqual(['2024-03-07', '2024-03-07']);
      expect(history.getPoints().map((point) => point.date)).toEqual(['2024-03-06', '2024-03-07']);
    }
  });

  it('refuses a range in which nothing has closed yet', async () => {
    await expect(loader(new FakeStockClient()).load(easternClock.timestamp('2024-03-06', '15:00:00'))).rejects.toThrow('has closed by');
  });

  it('leaves out a session with no minute bars, and a point whose window would reach back past it', async () => {
    const history = loader(new FakeStockClient(['2024-03-05']));
    await history.load();

    expect(history.getSessions().map((s) => s.date)).toEqual(['2024-03-04', '2024-03-06', '2024-03-07', '2024-03-08']);
    expect(history.getPoints().map((point) => point.date)).toEqual(['2024-03-07', '2024-03-08']);
  });

  it('refuses a window with no sample variance, and an interval intraday variance is not measured at', () => {
    const props = { symbol: 'AAPL', client: new FakeStockClient(), fromDate: '2024-03-06', toDate: '2024-03-08' };
    expect(() => new HistoricalRealizedVolatilityLoader({ ...props, window: 1, intradayMinutes: 5 })).toThrow('at least 2');
    expect(() => new HistoricalRealizedVolatilityLoader({ ...props, window: 21, intradayMinutes: 3 })).toThrow('not 3');
  });

  it('says it is not loaded, rather than handing out an empty history', () => {
    const history = loader(new FakeStockClient());
    expect(() => history.getPoints()).toThrow('not loaded yet');
    expect(() => history.getSessions()).toThrow('not loaded yet');
    expect(() => history.buildTimeSubscriber()).toThrow('not loaded yet');
  });
});

describe('HistoricalRealizedVolatility', () => {
  const DATES = ['2024-03-04', '2024-03-05'];

  function reader(): HistoricalRealizedVolatility {
    const points: RealizedVolatilityPoint[] = DATES.map((date) => ({
      date,
      publishedAt: hour(date).closeAt + MINUTE + 4_000,
      session: session(date, 0, 0),
      trailing: { sessions: 2, closeToClose: 0, intradayPlusOvernight: 0, yangZhang: 0, overnightShare: 0 },
    }));
    return new HistoricalRealizedVolatility({ symbol: 'AAPL', fromDate: DATES[0], toDate: DATES[DATES.length - 1], points });
  }

  it('hands out a session only once the closing auction’s bar is published', async () => {
    const history = reader();
    await history.init(easternClock.timestamp('2024-03-04', '16:01:04'));
    expect(history.getPoints()).toEqual([]);

    await history.forward(easternClock.timestamp('2024-03-04', '16:01:05'));
    expect(history.getPoints().map((point) => point.date)).toEqual(['2024-03-04']);

    await history.forward(easternClock.timestamp('2024-03-05', '20:00:00'));
    expect(history.getPoints().map((point) => point.date)).toEqual(DATES);
  });

  it('hands back a copy each call, so a caller cannot edit the history', async () => {
    const history = reader();
    await history.init(easternClock.timestamp('2024-03-05', '09:30:00'));
    expect(history.getPoints()).not.toBe(history.getPoints());
    expect(history.getPoints()).toHaveLength(1);
  });

  it('refuses a backtest starting outside the range, a step that is not forward, one past the range, and a read before it starts', async () => {
    await expect(reader().init(easternClock.timestamp('2024-03-01', '09:30:00'))).rejects.toThrow('Set fromDate and toDate to cover the whole run');
    expect(() => reader().getPoints()).toThrow('before it was initialised');

    const history = reader();
    await history.init(easternClock.timestamp('2024-03-04', '10:00:00'));
    await expect(history.forward(easternClock.timestamp('2024-03-04', '10:00:00'))).rejects.toThrow('only ever stepped forward');
    await expect(history.forward(easternClock.timestamp('2024-03-06', '09:30:00'))).rejects.toThrow('Set toDate to cover the whole run');
  });
});
