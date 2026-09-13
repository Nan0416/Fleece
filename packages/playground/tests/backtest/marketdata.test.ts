import { marketHour, requireOccSymbol, type AlpacaMarketDataClient, type Bar, type OccSymbol, type StockSplit } from '@fleece/marketdata';
import { easternClock } from '@fleece/utilities';

import { BacktestMarketDataImpl, findOverlaps, generatePlaceholderBarSegments, type MarketData } from '../../src/backtest/marketdata';
import type { TimeSubscriber } from '../../src/backtest/time';
import type { OptionsAvailabilitiesHelper } from '../../src/utils/options-availabilities';

const JAN_CALL_200 = requireOccSymbol('AMZN260116C00200000', 'build a fixture');
const JAN_PUT_150 = requireOccSymbol('AMZN260116P00150000', 'build a fixture');
const MAR_CALL_300 = requireOccSymbol('AMZN260320C00300000', 'build a fixture');
const MAR_PUT_100 = requireOccSymbol('AMZN260320P00100000', 'build a fixture');
const CHAIN = [JAN_CALL_200, JAN_PUT_150, MAR_CALL_300, MAR_PUT_100];

const DAY = '2024-03-04';
const NEXT = '2024-03-05';
/** A one-for-four split, so a price before it is worth a quarter as much afterwards. */
const SPLIT_DAY = '2024-03-06';
const AFTER_SPLIT = '2024-03-07';

function at(date: string, time: string): number {
  return easternClock.timestamp(date, time);
}

function minuteBar(date: string, time: string, close: number): Bar {
  return { S: 'AMZN', o: close, h: close, l: close, c: close, v: 1_000, t: at(date, time) };
}

function dailyBar(date: string, close: number): Bar {
  return { S: 'AMZN', o: close, h: close, l: close, c: close, v: 1_000, t: at(date, '00:00:00') };
}

interface Recorded {
  readonly kind: string;
  readonly from?: number;
  readonly to?: number;
  readonly adjustForSplit?: boolean;
  readonly timespan?: string;
}

interface WindowRequest {
  readonly from: number;
  readonly to: number;
}

/**
 * Serves only the bars inside the window it is asked for, both ends included, as Alpaca
 * does. A fake that handed back everything whatever it was asked would put each bar in
 * every segment a request spans, and the duplicate would be the fake's rather than the code's.
 */
class FakeClient {
  readonly requests: Recorded[] = [];
  /** How many of the next bar fetches fail, the way a 429 or a timeout would. */
  failures = 0;

  constructor(
    private readonly minutes: ReadonlyArray<Bar> = [],
    private readonly days: ReadonlyArray<Bar> = [],
    private readonly splits: ReadonlyArray<StockSplit> = [],
    private readonly options: ReadonlyArray<Bar> = [],
  ) {}

  async minuteBars(request: WindowRequest & { adjustForSplit?: boolean }): Promise<unknown> {
    this.requests.push({ kind: 'minute', from: request.from, to: request.to, adjustForSplit: request.adjustForSplit });
    return this.serve(this.minutes, request);
  }

  async dailyBars(request: WindowRequest & { adjustForSplit?: boolean }): Promise<unknown> {
    this.requests.push({ kind: 'day', from: request.from, to: request.to, adjustForSplit: request.adjustForSplit });
    return this.serve(this.days, request);
  }

  async optionBars(request: WindowRequest & { timespan: string }): Promise<unknown> {
    this.requests.push({ kind: 'option', from: request.from, to: request.to, timespan: request.timespan });
    return this.serve(this.options, request);
  }

  async stockSplits(): Promise<unknown> {
    this.requests.push({ kind: 'splits' });
    return { splits: this.splits };
  }

  private serve(bars: ReadonlyArray<Bar>, request: WindowRequest): { bars: Bar[] } {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('Alpaca returned 429 for /v2/stocks/bars.');
    }
    return { bars: bars.filter((bar) => bar.t >= request.from && bar.t <= request.to) };
  }
}

function availabilities(chain: ReadonlyArray<OccSymbol> = CHAIN): OptionsAvailabilitiesHelper {
  return { cachePath: '/nowhere', save: async () => {}, availableOptions: async () => chain };
}

function build(client: FakeClient): BacktestMarketDataImpl {
  // The fake implements the slice of the client this class touches, which the compiler cannot know.
  return new BacktestMarketDataImpl(client as unknown as AlpacaMarketDataClient, availabilities());
}

async function marketData(client: FakeClient, now: number): Promise<BacktestMarketDataImpl> {
  const subject = build(client);
  await subject.init(now);
  return subject;
}

function requestsOf(client: FakeClient, kind: string): Recorded[] {
  return client.requests.filter((request) => request.kind === kind);
}

const SPLIT: StockSplit = { ticker: 'AMZN', executionDate: SPLIT_DAY, splitFrom: 1, splitTo: 4 };

interface Segment {
  readonly id: string;
  readonly timeWindow: { readonly startTimestamp: number; readonly endTimestamp: number };
}

function segment(startTimestamp: number, endTimestamp: number): Segment {
  return { id: `${startTimestamp}-${endTimestamp}`, timeWindow: { startTimestamp, endTimestamp } };
}

function overlapping(segments: Segment[], startTimestamp: number, endTimestamp: number): string[] {
  return findOverlaps(segments, { startTimestamp, endTimestamp }).map((found) => found.id);
}

describe('findOverlaps', () => {
  // Back to back, the way the placeholder segments are laid out: each ends where the next starts.
  const backToBack = [segment(0, 10), segment(10, 20), segment(20, 30), segment(30, 40)];

  it('returns every segment the window passes through, in order', () => {
    expect(overlapping(backToBack, 5, 35)).toEqual(['0-10', '10-20', '20-30', '30-40']);
  });

  it('returns only the segment a window sits inside', () => {
    expect(overlapping(backToBack, 12, 18)).toEqual(['10-20']);
  });

  it('returns only the one segment a window matches exactly, not its neighbours sharing the ends', () => {
    expect(overlapping(backToBack, 10, 20)).toEqual(['10-20']);
  });

  it('does not count a window that only touches a segment at an end, since both ends are exclusive', () => {
    expect(overlapping(backToBack, -5, 0)).toEqual([]);
    expect(overlapping(backToBack, 40, 45)).toEqual([]);
  });

  it('counts a window that crosses a boundary by the smallest step', () => {
    expect(overlapping(backToBack, 9, 11)).toEqual(['0-10', '10-20']);
    expect(overlapping(backToBack, -5, 1)).toEqual(['0-10']);
    expect(overlapping(backToBack, 39, 45)).toEqual(['30-40']);
  });

  it('returns every segment for a window wider than all of them', () => {
    expect(overlapping(backToBack, -100, 100)).toEqual(['0-10', '10-20', '20-30', '30-40']);
  });

  it('returns nothing for a window entirely before or after the segments', () => {
    expect(overlapping(backToBack, -20, -10)).toEqual([]);
    expect(overlapping(backToBack, 50, 60)).toEqual([]);
  });

  it('returns nothing for a window with no length, even one inside a segment', () => {
    expect(overlapping(backToBack, 15, 15)).toEqual([]);
    expect(overlapping(backToBack, 10, 10)).toEqual([]);
  });

  it('returns nothing for a window that ends before it starts, rather than the segments between its ends', () => {
    expect(overlapping(backToBack, 35, 5)).toEqual([]);
  });

  it('returns nothing when there are no segments', () => {
    expect(overlapping([], 0, 10)).toEqual([]);
  });

  it('skips a gap between segments and returns what lies either side of it', () => {
    const gapped = [segment(0, 10), segment(20, 30)];

    expect(overlapping(gapped, 12, 18)).toEqual([]);
    expect(overlapping(gapped, 10, 20)).toEqual([]);
    expect(overlapping(gapped, 5, 25)).toEqual(['0-10', '20-30']);
  });

  it('hands back the segments themselves, so filling one in fills in the cache', () => {
    const found = findOverlaps(backToBack, { startTimestamp: 12, endTimestamp: 18 });

    expect(found[0]).toBe(backToBack[1]);
  });

  it('agrees with checking every segment one by one, across a list long enough to search', () => {
    // A couple of hundred segments is what seventeen years of months comes to. A search
    // that is off by one at either end still passes the short lists above.
    const many = Array.from({ length: 200 }, (_, i) => segment(i * 10, i * 10 + 10));
    // The length check is not redundant: a zero-length window inside a segment passes the
    // other two comparisons, and it covers no time at all.
    const expected = (start: number, end: number) =>
      many.filter((one) => end > start && one.timeWindow.startTimestamp < end && one.timeWindow.endTimestamp > start).map((one) => one.id);

    for (let start = -15; start <= 2015; start += 7) {
      for (const length of [0, 1, 9, 10, 11, 95, 3000]) {
        expect(overlapping(many, start, start + length)).toEqual(expected(start, start + length));
      }
    }
  });
});

describe('generatePlaceholderBarSegments', () => {
  // Written with their offsets rather than through `easternClock`, so a boundary the
  // implementation got wrong cannot be checked against the same mistake.
  const JAN_2010_NY = Date.parse('2010-01-01T00:00:00-05:00');
  const JAN_2027_NY = Date.parse('2027-01-01T00:00:00-05:00');

  it('covers 2010 to 2027 in calendar months', () => {
    const segments = generatePlaceholderBarSegments('1Month');

    expect(segments).toHaveLength(17 * 12);
    expect(segments[0].timeWindow.startTimestamp).toBe(JAN_2010_NY);
    expect(segments[segments.length - 1].timeWindow.endTimestamp).toBe(JAN_2027_NY);
  });

  it('covers 2010 to 2027 in calendar years', () => {
    const segments = generatePlaceholderBarSegments('1Year');

    expect(segments).toHaveLength(17);
    expect(segments[0].timeWindow.startTimestamp).toBe(JAN_2010_NY);
    expect(segments[segments.length - 1].timeWindow.endTimestamp).toBe(JAN_2027_NY);
    expect(segments.map((one) => easternClock.date(one.timeWindow.startTimestamp))).toEqual(Array.from({ length: 17 }, (_, i) => `${2010 + i}-01-01`));
  });

  it('ends each segment at the instant the next one starts, leaving no gap for a bar to fall into', () => {
    for (const windowSize of ['1Month', '1Year'] as const) {
      const segments = generatePlaceholderBarSegments(windowSize);

      for (let i = 1; i < segments.length; i++) {
        expect(segments[i].timeWindow.startTimestamp).toBe(segments[i - 1].timeWindow.endTimestamp);
      }
    }
  });

  it('starts every month at midnight on the 1st in New York, whichever side of daylight saving it is on', () => {
    const segments = generatePlaceholderBarSegments('1Month');

    for (const one of segments) {
      expect(easternClock.date(one.timeWindow.startTimestamp).endsWith('-01')).toBe(true);
      expect(easternClock.time(one.timeWindow.startTimestamp)).toBe('00:00:00');
    }
    // Midnight in New York is 05:00 UTC in winter and 04:00 UTC in summer, not midnight UTC.
    const starting = (date: string) => segments.find((one) => easternClock.date(one.timeWindow.startTimestamp) === date);
    expect(starting('2024-01-01')?.timeWindow.startTimestamp).toBe(Date.parse('2024-01-01T05:00:00Z'));
    expect(starting('2024-07-01')?.timeWindow.startTimestamp).toBe(Date.parse('2024-07-01T04:00:00Z'));
  });

  it('keeps an evening session in the month it traded, though in UTC it is already the next month', () => {
    const segments = generatePlaceholderBarSegments('1Month');
    // 19:59 in New York on 31 January is 00:59 UTC on 1 February.
    const lastAfterHoursMinute = at('2024-01-31', '19:59:00');

    const found = findOverlaps(segments, { startTimestamp: lastAfterHoursMinute, endTimestamp: lastAfterHoursMinute + 60_000 });

    expect(found.map((one) => easternClock.date(one.timeWindow.startTimestamp))).toEqual(['2024-01-01']);
  });

  it('puts a whole trading day, pre-market to after hours, in exactly one month', () => {
    const segments = generatePlaceholderBarSegments('1Month');

    const found = findOverlaps(segments, { startTimestamp: at('2024-02-29', '04:00:00'), endTimestamp: at('2024-02-29', '20:00:00') });

    expect(found.map((one) => easternClock.date(one.timeWindow.startTimestamp))).toEqual(['2024-02-01']);
  });

  it('starts with nothing fetched', () => {
    for (const windowSize of ['1Month', '1Year'] as const) {
      expect(generatePlaceholderBarSegments(windowSize).every((one) => one.barsPromise === undefined)).toBe(true);
    }
  });

  it('hands out new segments on every call, so bars fetched for one symbol never reach another', () => {
    const forAmzn = generatePlaceholderBarSegments('1Month');
    const forAapl = generatePlaceholderBarSegments('1Month');

    forAmzn[0].barsPromise = Promise.resolve([]);

    expect(forAapl[0]).not.toBe(forAmzn[0]);
    expect(forAapl[0].barsPromise).toBeUndefined();
  });
});

describe('BacktestMarketDataImpl', () => {
  describe('minuteBars', () => {
    const bars = [minuteBar(DAY, '09:30:00', 10), minuteBar(DAY, '09:31:00', 11), minuteBar(DAY, '09:32:00', 12)];

    it('leaves out the bar still in progress, whose close has not happened yet', async () => {
      const subject = await marketData(new FakeClient(bars), at(DAY, '09:31:30'));

      const { bars: seen } = await subject.minuteBars({ symbol: 'AMZN', from: DAY });

      // At 09:31:30 the 09:31 bar closes at 09:32, which is half a minute away.
      expect(seen.map((bar) => bar.c)).toEqual([10]);
    });

    it('admits a bar once the clock is past its close, and not while the clock is on it', async () => {
      const exactly = await marketData(new FakeClient(bars), at(DAY, '09:31:00'));
      const justAfter = await marketData(new FakeClient(bars), at(DAY, '09:31:00') + 1);

      expect((await exactly.minuteBars({ symbol: 'AMZN', from: DAY })).bars).toEqual([]);
      expect((await justAfter.minuteBars({ symbol: 'AMZN', from: DAY })).bars.map((bar) => bar.c)).toEqual([10]);
    });

    it('stops at a `to` short of the clock, leaving out the bar that closes on it', async () => {
      const subject = await marketData(new FakeClient(bars), at(DAY, '16:00:00'));

      const { bars: seen } = await subject.minuteBars({ symbol: 'AMZN', from: DAY, to: at(DAY, '09:32:00') });

      expect(seen.map((bar) => bar.c)).toEqual([10]);
    });

    it('narrows to a `from` inside the day', async () => {
      const subject = await marketData(new FakeClient(bars), at(DAY, '16:00:00'));

      const { bars: seen } = await subject.minuteBars({ symbol: 'AMZN', from: at(DAY, '09:31:00') });

      expect(seen.map((bar) => bar.c)).toEqual([11, 12]);
    });

    it('answers with nothing for a window that has not started yet', async () => {
      const subject = await marketData(new FakeClient(bars), at(DAY, '09:31:00'));

      expect((await subject.minuteBars({ symbol: 'AMZN', from: AFTER_SPLIT })).bars).toEqual([]);
    });

    it('asks for the whole month unadjusted, a millisecond short of the next month, whatever the caller wanted', async () => {
      const client = new FakeClient(bars, [], [SPLIT]);
      const subject = await marketData(client, at(DAY, '16:00:00'));

      await subject.minuteBars({ symbol: 'AMZN', from: DAY, adjustForSplit: true });

      // The client includes its `to`, so asking for the month's end would include the next month's first instant.
      expect(requestsOf(client, 'minute')).toEqual([{ kind: 'minute', from: at('2024-03-01', '00:00:00'), to: at('2024-04-01', '00:00:00') - 1, adjustForSplit: false }]);
    });

    it('fetches a month once, however many steps ask for it', async () => {
      const client = new FakeClient(bars);
      const subject = await marketData(client, at(DAY, '09:31:00'));

      await subject.minuteBars({ symbol: 'AMZN', from: DAY });
      await subject.forward(at(DAY, '09:32:00'));
      await subject.minuteBars({ symbol: 'AMZN', from: DAY });
      await subject.forward(at(AFTER_SPLIT, '09:31:00'));
      await subject.minuteBars({ symbol: 'AMZN', from: DAY });

      expect(requestsOf(client, 'minute')).toHaveLength(1);
    });

    it('fetches only the month it has not got when a request reaches across a month end, and answers in order', async () => {
      const client = new FakeClient([minuteBar('2024-03-28', '09:30:00', 1), minuteBar('2024-04-01', '09:30:00', 2)]);
      const subject = await marketData(client, at('2024-03-28', '16:00:00'));

      await subject.minuteBars({ symbol: 'AMZN', from: '2024-03-28' });
      await subject.forward(at('2024-04-01', '16:00:00'));
      const { bars: seen } = await subject.minuteBars({ symbol: 'AMZN', from: '2024-03-28' });

      expect(seen.map((bar) => bar.c)).toEqual([1, 2]);
      expect(requestsOf(client, 'minute').map((request) => easternClock.date(request.from ?? 0))).toEqual(['2024-03-01', '2024-04-01']);
    });

    it('answers a bar stamped on the instant two months meet once, not once from each', async () => {
      const client = new FakeClient([minuteBar('2024-03-01', '00:00:00', 7)]);
      const subject = await marketData(client, at(NEXT, '12:00:00'));

      const { bars: seen } = await subject.minuteBars({ symbol: 'AMZN', from: '2024-02-15' });

      expect(seen.map((bar) => bar.c)).toEqual([7]);
    });
  });

  describe('dailyBars', () => {
    const bars = [dailyBar(DAY, 10), dailyBar(NEXT, 11)];

    it('leaves out a session that has not closed yet', async () => {
      const subject = await marketData(new FakeClient([], bars), at(DAY, '15:59:59'));

      expect((await subject.dailyBars({ symbol: 'AMZN', from: DAY })).bars).toEqual([]);
    });

    it('admits a session once the clock is past its own close', async () => {
      const closeAt = marketHour(DAY)?.closeAt ?? 0;
      const exactly = await marketData(new FakeClient([], bars), closeAt);
      const justAfter = await marketData(new FakeClient([], bars), closeAt + 1);

      expect((await exactly.dailyBars({ symbol: 'AMZN', from: DAY })).bars).toEqual([]);
      expect((await justAfter.dailyBars({ symbol: 'AMZN', from: DAY })).bars.map((bar) => bar.c)).toEqual([10]);
    });

    it('dates a half day by its 13:00 close, which no rule derives and the market-hours table has', async () => {
      const halfDay = [dailyBar('2024-07-03', 20)];
      const subject = await marketData(new FakeClient([], halfDay), at('2024-07-03', '13:00:00') + 1);

      expect((await subject.dailyBars({ symbol: 'AMZN', from: '2024-07-03' })).bars.map((bar) => bar.c)).toEqual([20]);
    });

    it('asks for the whole calendar year unadjusted, a millisecond short of the next', async () => {
      const client = new FakeClient([], bars, [SPLIT]);
      const subject = await marketData(client, at(AFTER_SPLIT, '12:00:00'));

      await subject.dailyBars({ symbol: 'AMZN', from: DAY, adjustForSplit: true });
      await subject.dailyBars({ symbol: 'AMZN', from: NEXT });

      expect(requestsOf(client, 'day')).toEqual([{ kind: 'day', from: at('2024-01-01', '00:00:00'), to: at('2025-01-01', '00:00:00') - 1, adjustForSplit: false }]);
    });
  });

  describe('stockSplits', () => {
    it('leaves out a split that has not executed yet', async () => {
      const subject = await marketData(new FakeClient([], [], [SPLIT]), at(NEXT, '12:00:00'));

      expect((await subject.stockSplits({ symbol: 'AMZN' })).splits).toEqual([]);
    });

    it('reports a split from the day it executes', async () => {
      const subject = await marketData(new FakeClient([], [], [SPLIT]), at(SPLIT_DAY, '00:00:00'));

      expect((await subject.stockSplits({ symbol: 'AMZN' })).splits).toEqual([SPLIT]);
    });

    it('still narrows by execution date when one is asked for', async () => {
      const subject = await marketData(new FakeClient([], [], [SPLIT]), at(AFTER_SPLIT, '12:00:00'));

      expect((await subject.stockSplits({ symbol: 'AMZN', executionDate: SPLIT_DAY })).splits).toEqual([SPLIT]);
      expect((await subject.stockSplits({ symbol: 'AMZN', executionDate: DAY })).splits).toEqual([]);
    });

    it("fetches a symbol's splits once however often it is asked", async () => {
      const client = new FakeClient([], [], [SPLIT]);
      const subject = await marketData(client, at(AFTER_SPLIT, '12:00:00'));

      await subject.stockSplits({ symbol: 'AMZN' });
      await subject.stockSplits({ symbol: 'AMZN' });

      expect(requestsOf(client, 'splits')).toHaveLength(1);
    });
  });

  describe('split adjustment', () => {
    const bars = [dailyBar(DAY, 100)];

    it('leaves prices as traded unless asked', async () => {
      const subject = await marketData(new FakeClient([], bars, [SPLIT]), at(AFTER_SPLIT, '12:00:00'));

      expect((await subject.dailyBars({ symbol: 'AMZN', from: DAY })).bars.map((bar) => bar.c)).toEqual([100]);
    });

    it('restates a price for a split the clock has already passed', async () => {
      const subject = await marketData(new FakeClient([], bars, [SPLIT]), at(AFTER_SPLIT, '12:00:00'));

      const { bars: seen } = await subject.dailyBars({ symbol: 'AMZN', from: DAY, adjustForSplit: true });

      expect(seen.map((bar) => bar.c)).toEqual([25]); // one-for-four
    });

    it('does not restate for a split still ahead of the clock, which is the whole point', async () => {
      const subject = await marketData(new FakeClient([], bars, [SPLIT]), at(NEXT, '16:00:00'));

      const { bars: seen } = await subject.dailyBars({ symbol: 'AMZN', from: DAY, adjustForSplit: true });

      // The split is two days out. Restating now would size a position in shares nobody holds.
      expect(seen.map((bar) => bar.c)).toEqual([100]);
    });

    it('moves volume the other way, since a split makes more shares and not fewer', async () => {
      const subject = await marketData(new FakeClient([], bars, [SPLIT]), at(AFTER_SPLIT, '12:00:00'));

      const { bars: seen } = await subject.dailyBars({ symbol: 'AMZN', from: DAY, adjustForSplit: true });

      expect(seen.map((bar) => bar.v)).toEqual([4_000]);
    });

    it('restates minute bars too', async () => {
      const subject = await marketData(new FakeClient([minuteBar(DAY, '09:30:00', 100)], [], [SPLIT]), at(AFTER_SPLIT, '12:00:00'));

      const { bars: seen } = await subject.minuteBars({ symbol: 'AMZN', from: DAY, adjustForSplit: true });

      expect(seen.map((bar) => bar.c)).toEqual([25]);
    });
  });

  describe('optionBars', () => {
    const bars = [minuteBar(DAY, '09:30:00', 3.5), minuteBar(DAY, '09:31:00', 3.6)];

    it('leaves out the minute bar still in progress', async () => {
      const subject = await marketData(new FakeClient([], [], [], bars), at(DAY, '09:31:30'));

      const { bars: seen } = await subject.optionMinuteBars({ symbol: JAN_CALL_200.symbol, from: DAY });

      expect(seen.map((bar) => bar.c)).toEqual([3.5]);
    });

    it('leaves out a daily bar whose session has not closed', async () => {
      const days = [dailyBar(DAY, 3.5)];
      const during = await marketData(new FakeClient([], [], [], days), at(DAY, '15:59:59'));
      const afterClose = await marketData(new FakeClient([], [], [], days), (marketHour(DAY)?.closeAt ?? 0) + 1);

      expect((await during.optionDailyBars({ symbol: JAN_CALL_200.symbol, from: DAY })).bars).toEqual([]);
      expect((await afterClose.optionDailyBars({ symbol: JAN_CALL_200.symbol, from: DAY })).bars).toHaveLength(1);
    });

    it('asks for a month of minute bars and a year of daily bars, in the span each method names', async () => {
      const client = new FakeClient([], [], [], bars);
      const subject = await marketData(client, at(DAY, '16:00:00'));

      await subject.optionMinuteBars({ symbol: JAN_CALL_200.symbol, from: DAY });
      await subject.optionDailyBars({ symbol: JAN_CALL_200.symbol, from: DAY });

      expect(requestsOf(client, 'option')).toEqual([
        { kind: 'option', from: at('2024-03-01', '00:00:00'), to: at('2024-04-01', '00:00:00') - 1, timespan: 'minute' },
        { kind: 'option', from: at('2024-01-01', '00:00:00'), to: at('2025-01-01', '00:00:00') - 1, timespan: 'day' },
      ]);
    });

    it('keeps minute and daily bars for one contract apart rather than serving one for the other', async () => {
      const client = new FakeClient([], [], [], bars);
      const subject = await marketData(client, at(DAY, '16:00:00'));

      await subject.optionMinuteBars({ symbol: JAN_CALL_200.symbol, from: DAY });
      await subject.optionMinuteBars({ symbol: JAN_CALL_200.symbol, from: DAY });
      await subject.optionDailyBars({ symbol: JAN_CALL_200.symbol, from: DAY });

      // One fetch per span, not one per call and not one shared between the two.
      expect(requestsOf(client, 'option')).toHaveLength(2);
    });

    it('keeps a stock and an option with the same symbol apart', async () => {
      const client = new FakeClient([], [dailyBar(DAY, 10)], [], [dailyBar(DAY, 3.5)]);
      const subject = await marketData(client, at(NEXT, '12:00:00'));

      expect((await subject.dailyBars({ symbol: 'AMZN', from: DAY })).bars.map((bar) => bar.c)).toEqual([10]);
      expect((await subject.optionDailyBars({ symbol: 'AMZN', from: DAY })).bars.map((bar) => bar.c)).toEqual([3.5]);
    });

    it('never adjusts for a split, because a split re-issues a contract rather than restating it', async () => {
      const subject = await marketData(new FakeClient([], [], [SPLIT], bars), at(AFTER_SPLIT, '12:00:00'));

      const { bars: seen } = await subject.optionMinuteBars({ symbol: JAN_CALL_200.symbol, from: DAY });

      expect(seen.map((bar) => bar.c)).toEqual([3.5, 3.6]);
    });
  });

  describe('listActiveOptionContracts', () => {
    it('hands back everything available when the request names no filter', async () => {
      const subject = await marketData(new FakeClient(), at(DAY, '12:00:00'));

      const { contracts } = await subject.listActiveOptionContracts({ underlying: 'AMZN' });

      expect(contracts.map((contract) => contract.symbol).sort()).toEqual(CHAIN.map((contract) => contract.symbol).sort());
    });

    it('narrows by every filter at once rather than by only one of them', async () => {
      const subject = await marketData(new FakeClient(), at(DAY, '12:00:00'));

      // Each filter alone would keep two contracts; together they keep exactly one.
      const { contracts } = await subject.listActiveOptionContracts({
        underlying: 'AMZN',
        type: 'call',
        expirationFrom: '2026-01-01',
        expirationTo: '2026-02-01',
        strikeFrom: 150,
        strikeTo: 250,
      });

      expect(contracts.map((contract) => contract.symbol)).toEqual([JAN_CALL_200.symbol]);
    });

    it('keeps only expirations inside the window, both ends inclusive', async () => {
      const subject = await marketData(new FakeClient(), at(DAY, '12:00:00'));

      const exact = await subject.listActiveOptionContracts({ underlying: 'AMZN', expirationFrom: '2026-01-16', expirationTo: '2026-01-16' });

      expect(exact.contracts.map((contract) => contract.symbol).sort()).toEqual([JAN_CALL_200.symbol, JAN_PUT_150.symbol].sort());
    });

    it('keeps only strikes inside the band, both ends inclusive', async () => {
      const subject = await marketData(new FakeClient(), at(DAY, '12:00:00'));

      const { contracts } = await subject.listActiveOptionContracts({ underlying: 'AMZN', strikeFrom: 150, strikeTo: 200 });

      expect(contracts.map((contract) => contract.symbol).sort()).toEqual([JAN_CALL_200.symbol, JAN_PUT_150.symbol].sort());
    });
  });

  describe('a failed fetch', () => {
    it('is asked again on the next request, rather than failing every later one with the same error', async () => {
      const client = new FakeClient([minuteBar(DAY, '09:30:00', 10)]);
      client.failures = 1;
      const subject = await marketData(client, at(DAY, '12:00:00'));

      await expect(subject.minuteBars({ symbol: 'AMZN', from: DAY })).rejects.toThrow(/429/);
      const { bars: seen } = await subject.minuteBars({ symbol: 'AMZN', from: DAY });

      expect(seen.map((bar) => bar.c)).toEqual([10]);
      expect(requestsOf(client, 'minute')).toHaveLength(2);
    });

    it('only follows a fetch that failed: a segment that loaded is not asked for again', async () => {
      const client = new FakeClient([], [dailyBar(DAY, 10)]);
      const subject = await marketData(client, at(NEXT, '12:00:00'));

      await subject.dailyBars({ symbol: 'AMZN', from: DAY });
      client.failures = 1;
      await subject.dailyBars({ symbol: 'AMZN', from: DAY });

      expect(requestsOf(client, 'day')).toHaveLength(1);
    });
  });

  describe('the loaded range', () => {
    it('refuses a request reaching back before 2010 rather than answering a short series', async () => {
      const client = new FakeClient();
      const subject = await marketData(client, at('2010-02-01', '12:00:00'));

      // An SMA20 quietly computed from twelve bars is wrong in a way nothing reports.
      await expect(subject.dailyBars({ symbol: 'AMZN', from: '2009-12-01' })).rejects.toThrow(/Widen the range/);
      expect(client.requests).toEqual([]);
    });

    it('refuses once the clock is past the end of 2026', async () => {
      const subject = await marketData(new FakeClient(), at('2027-01-04', '12:00:00'));

      await expect(subject.minuteBars({ symbol: 'AMZN', from: '2026-12-31' })).rejects.toThrow(/Widen the range/);
    });

    it('takes a `to` past the range while the clock is inside it, since nothing past the clock is answered anyway', async () => {
      const subject = await marketData(new FakeClient([], [dailyBar(DAY, 10)]), at(NEXT, '12:00:00'));

      const { bars: seen } = await subject.dailyBars({ symbol: 'AMZN', from: DAY, to: '2030-01-01' });

      expect(seen.map((bar) => bar.c)).toEqual([10]);
    });
  });

  describe('before the clock starts', () => {
    it('says the clock has not started rather than answering with an empty market, and asks the client nothing', async () => {
      const client = new FakeClient([minuteBar(DAY, '09:30:00', 10)], [dailyBar(DAY, 10)], [SPLIT], [minuteBar(DAY, '09:30:00', 3.5)]);
      const subject = build(client);

      await expect(subject.minuteBars({ symbol: 'AMZN', from: DAY })).rejects.toThrow(/clock has not started/);
      await expect(subject.minuteBars({ symbol: 'AMZN', from: DAY, to: NEXT })).rejects.toThrow(/clock has not started/);
      await expect(subject.dailyBars({ symbol: 'AMZN', from: DAY })).rejects.toThrow(/clock has not started/);
      await expect(subject.optionMinuteBars({ symbol: JAN_CALL_200.symbol, from: DAY })).rejects.toThrow(/clock has not started/);
      await expect(subject.optionDailyBars({ symbol: JAN_CALL_200.symbol, from: DAY })).rejects.toThrow(/clock has not started/);
      await expect(subject.listActiveOptionContracts({ underlying: 'AMZN' })).rejects.toThrow(/clock has not started/);

      expect(client.requests).toEqual([]);
    });

    it('says the clock has not started rather than answering that a symbol never split', async () => {
      const client = new FakeClient([], [], [SPLIT]);
      const subject = build(client);

      // Not an empty list: nothing has executed before the clock starts, so a caller would
      // read "AMZN never split" and price an unadjusted series as though it were adjusted.
      await expect(subject.stockSplits({ symbol: 'AMZN' })).rejects.toThrow(/clock has not started/);
      // And it refuses before spending the round trip, not after.
      expect(client.requests).toHaveLength(0);
    });

    it('leaves the clock off the market data a strategy is handed', () => {
      const view: MarketData = build(new FakeClient());

      // @ts-expect-error `init` and `forward` belong to `BacktestMarketData`, which the
      // driver holds, and not to the `MarketData` a strategy is given. A strategy that could
      // step only the market data would be reading bars the run has not reached, and the
      // number it reported would look entirely plausible.
      const stepping: TimeSubscriber = view;

      expect(stepping.timeSubscriberId).toBeDefined();
    });

    it('refuses to be stepped to an instant it is already on or past', async () => {
      const subject = await marketData(new FakeClient(), at(DAY, '12:00:00'));

      await expect(subject.forward(at(DAY, '12:00:00'))).rejects.toThrow(/only ever stepped forward/);
    });
  });
});
