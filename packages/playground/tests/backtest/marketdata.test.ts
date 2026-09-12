import { marketHour, marketHoursCoverage, requireOccSymbol, type AlpacaMarketDataClient, type Bar, type OccSymbol, type StockSplit } from '@fleece/marketdata';
import { easternClock } from '@fleece/utilities';

import { BacktestMarketDataImpl, type BacktestMarketDataView } from '../../src/backtest/marketdata';
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
  readonly from: unknown;
  readonly to: unknown;
  readonly adjustForSplit?: boolean;
  readonly timespan?: string;
}

class FakeClient {
  readonly requests: Recorded[] = [];

  constructor(
    private readonly minutes: ReadonlyArray<Bar> = [],
    private readonly days: ReadonlyArray<Bar> = [],
    private readonly splits: ReadonlyArray<StockSplit> = [],
    private readonly options: ReadonlyArray<Bar> = [],
  ) {}

  async minuteBars(request: { from: unknown; to: unknown; adjustForSplit?: boolean }): Promise<unknown> {
    this.requests.push({ kind: 'minute', from: request.from, to: request.to, adjustForSplit: request.adjustForSplit });
    return { bars: this.minutes };
  }

  async dailyBars(request: { from: unknown; to: unknown; adjustForSplit?: boolean }): Promise<unknown> {
    this.requests.push({ kind: 'day', from: request.from, to: request.to, adjustForSplit: request.adjustForSplit });
    return { bars: this.days };
  }

  async optionBars(request: { from: unknown; to: unknown; timespan: string }): Promise<unknown> {
    this.requests.push({ kind: 'option', from: request.from, to: request.to, timespan: request.timespan });
    return { bars: this.options };
  }

  async stockSplits(): Promise<unknown> {
    this.requests.push({ kind: 'splits', from: undefined, to: undefined });
    return { splits: this.splits };
  }
}

function availabilities(chain: ReadonlyArray<OccSymbol> = CHAIN): OptionsAvailabilitiesHelper {
  return { cachePath: '/nowhere', save: async () => {}, availableOptions: async () => chain };
}

/** The run's own window. Wide enough that these tests step around inside it. */
const RUN_FROM = at(DAY, '09:30:00');
const RUN_TO = at(AFTER_SPLIT, '16:00:00');
const BUFFER_DAYS = 10;
const BUFFER_MS = BUFFER_DAYS * 24 * 60 * 60_000;

function build(client: FakeClient, bufferMs: number = BUFFER_MS): BacktestMarketDataImpl {
  // The fake implements the slice of the client this class touches, which the compiler cannot know.
  return new BacktestMarketDataImpl(client as unknown as AlpacaMarketDataClient, RUN_FROM, RUN_TO, availabilities(), bufferMs);
}

async function marketData(client: FakeClient, now: number, bufferMs: number = BUFFER_MS): Promise<BacktestMarketDataImpl> {
  const subject = build(client, bufferMs);
  await subject.init(now);
  return subject;
}

const SPLIT: StockSplit = { ticker: 'AMZN', executionDate: SPLIT_DAY, splitFrom: 1, splitTo: 4 };

describe('BacktestMarketDataImpl', () => {
  describe('minuteBars', () => {
    const bars = [minuteBar(DAY, '09:30:00', 10), minuteBar(DAY, '09:31:00', 11), minuteBar(DAY, '09:32:00', 12)];

    it('leaves out the bar still in progress, whose close has not happened yet', async () => {
      const subject = await marketData(new FakeClient(bars), at(DAY, '09:31:30'));

      const { bars: seen } = await subject.minuteBars({ symbol: 'AMZN', from: DAY });

      // At 09:31:30 the 09:31 bar closes at 09:32, which is half a minute away.
      expect(seen.map((bar) => bar.c)).toEqual([10]);
    });

    it('admits a bar the moment it closes, and not a millisecond before', async () => {
      const justBefore = await marketData(new FakeClient(bars), at(DAY, '09:31:00') - 1);
      const exactly = await marketData(new FakeClient(bars), at(DAY, '09:31:00'));

      expect((await justBefore.minuteBars({ symbol: 'AMZN', from: DAY })).bars).toEqual([]);
      expect((await exactly.minuteBars({ symbol: 'AMZN', from: DAY })).bars.map((bar) => bar.c)).toEqual([10]);
    });

    it('honours a `to` that stops short of the clock', async () => {
      const subject = await marketData(new FakeClient(bars), at(DAY, '16:00:00'));

      const { bars: seen } = await subject.minuteBars({ symbol: 'AMZN', from: DAY, to: at(DAY, '09:31:00') });

      expect(seen.map((bar) => bar.c)).toEqual([10, 11]);
    });

    it('asks the client for unadjusted bars over the run window, whatever the caller wanted', async () => {
      const client = new FakeClient(bars, [], [SPLIT]);
      const subject = await marketData(client, at(DAY, '16:00:00'));

      await subject.minuteBars({ symbol: 'AMZN', from: DAY, adjustForSplit: true });

      // The buffer reaches ten days before the run, and the far end is the run's own end.
      expect(client.requests.filter((request) => request.kind === 'minute')).toEqual([
        { kind: 'minute', from: easternClock.date(RUN_FROM - BUFFER_MS), to: easternClock.date(RUN_TO), adjustForSplit: false },
      ]);
    });

    it('fetches the run window once, however many minutes and days ask', async () => {
      const client = new FakeClient(bars);
      const subject = await marketData(client, at(DAY, '09:31:00'));

      await subject.minuteBars({ symbol: 'AMZN', from: DAY });
      await subject.forward(at(DAY, '09:32:00'));
      await subject.minuteBars({ symbol: 'AMZN', from: DAY });
      await subject.forward(at(NEXT, '09:31:00'));
      await subject.minuteBars({ symbol: 'AMZN', from: DAY });
      await subject.forward(at(AFTER_SPLIT, '09:31:00'));
      await subject.minuteBars({ symbol: 'AMZN', from: DAY });

      // The window does not move, so neither does the answer to "have I got this yet".
      expect(client.requests.filter((request) => request.kind === 'minute')).toHaveLength(1);
    });

    it('answers with nothing for a window that has not started yet', async () => {
      const subject = await marketData(new FakeClient(bars), at(DAY, '09:31:00'));

      expect((await subject.minuteBars({ symbol: 'AMZN', from: AFTER_SPLIT })).bars).toEqual([]);
    });

    it('narrows to the requested window inside the one it loaded', async () => {
      const subject = await marketData(new FakeClient(bars), at(DAY, '16:00:00'));

      const { bars: seen } = await subject.minuteBars({ symbol: 'AMZN', from: at(DAY, '09:31:00') });

      expect(seen.map((bar) => bar.c)).toEqual([11, 12]);
    });
  });

  describe('dailyBars', () => {
    const bars = [dailyBar(DAY, 10), dailyBar(NEXT, 11)];

    it('leaves out a session that has not closed yet', async () => {
      const subject = await marketData(new FakeClient([], bars), at(DAY, '15:59:59'));

      expect((await subject.dailyBars({ symbol: 'AMZN', from: DAY })).bars).toEqual([]);
    });

    it('admits a session at its own close, which is not midnight', async () => {
      const closeAt = marketHour(DAY)?.closeAt ?? 0;
      const subject = await marketData(new FakeClient([], bars), closeAt);

      expect((await subject.dailyBars({ symbol: 'AMZN', from: DAY })).bars.map((bar) => bar.c)).toEqual([10]);
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

      expect(client.requests.filter((request) => request.kind === 'splits')).toHaveLength(1);
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
  });

  describe('optionBars', () => {
    const bars = [minuteBar(DAY, '09:30:00', 3.5), minuteBar(DAY, '09:31:00', 3.6)];

    it('leaves out the minute bar still in progress', async () => {
      const subject = await marketData(new FakeClient([], [], [], bars), at(DAY, '09:31:00'));

      const { bars: seen } = await subject.optionMinuteBars({ symbol: JAN_CALL_200.symbol, from: DAY });

      expect(seen.map((bar) => bar.c)).toEqual([3.5]);
    });

    it('leaves out a daily bar whose session has not closed', async () => {
      const days = [dailyBar(DAY, 3.5)];
      const during = await marketData(new FakeClient([], [], [], days), at(DAY, '15:59:59'));
      const afterClose = await marketData(new FakeClient([], [], [], days), marketHour(DAY)?.closeAt ?? 0);

      expect((await during.optionDailyBars({ symbol: JAN_CALL_200.symbol, from: DAY })).bars).toEqual([]);
      expect((await afterClose.optionDailyBars({ symbol: JAN_CALL_200.symbol, from: DAY })).bars).toHaveLength(1);
    });

    it('asks the client for the span the method names, one contract at a time', async () => {
      const client = new FakeClient([], [], [], bars);
      const subject = await marketData(client, at(DAY, '16:00:00'));

      await subject.optionMinuteBars({ symbol: JAN_CALL_200.symbol, from: DAY });
      await subject.optionDailyBars({ symbol: JAN_CALL_200.symbol, from: DAY });

      expect(client.requests.filter((request) => request.kind === 'option').map((request) => request.timespan)).toEqual(['minute', 'day']);
    });

    it('keeps minute and daily bars for one contract apart rather than serving one for the other', async () => {
      const client = new FakeClient([], [], [], bars);
      const subject = await marketData(client, at(DAY, '16:00:00'));

      await subject.optionMinuteBars({ symbol: JAN_CALL_200.symbol, from: DAY });
      await subject.optionMinuteBars({ symbol: JAN_CALL_200.symbol, from: DAY });
      await subject.optionDailyBars({ symbol: JAN_CALL_200.symbol, from: DAY });

      // One fetch per span, not one per call and not one shared between the two.
      expect(client.requests.filter((request) => request.kind === 'option')).toHaveLength(2);
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

  describe('the loaded window', () => {
    it('reaches back by the buffer, so an indicator has something to warm up on', async () => {
      const client = new FakeClient([dailyBar(DAY, 10)]);
      const subject = await marketData(client, at(DAY, '16:00:00'));

      // Five days before the run starts, which only the buffer makes reachable.
      await subject.dailyBars({ symbol: 'AMZN', from: easternClock.shiftDate(DAY, -5) });

      expect(client.requests.filter((request) => request.kind === 'day')).toHaveLength(1);
    });

    it('refuses a request reaching back before the buffer rather than answering a short series', async () => {
      const subject = await marketData(new FakeClient(), at(DAY, '16:00:00'));

      // An SMA20 quietly computed from twelve bars is wrong in a way nothing reports.
      await expect(subject.dailyBars({ symbol: 'AMZN', from: easternClock.shiftDate(DAY, -BUFFER_DAYS - 5) })).rejects.toThrow(/Widen historyBufferMs/);
    });

    it('takes a buffer of zero, which then admits only the run itself', async () => {
      const subject = await marketData(new FakeClient(), at(DAY, '16:00:00'), 0);

      await expect(subject.dailyBars({ symbol: 'AMZN', from: DAY })).resolves.toBeDefined();
      await expect(subject.dailyBars({ symbol: 'AMZN', from: easternClock.shiftDate(DAY, -1) })).rejects.toThrow(/Widen historyBufferMs/);
    });

    it('refuses a run window that is empty or a buffer that runs backwards', () => {
      const client = new FakeClient() as unknown as AlpacaMarketDataClient;
      expect(() => new BacktestMarketDataImpl(client, RUN_TO, RUN_FROM, availabilities())).toThrow(/no window to load/);
      expect(() => new BacktestMarketDataImpl(client, RUN_FROM, RUN_FROM, availabilities())).toThrow(/no window to load/);
      expect(() => new BacktestMarketDataImpl(client, RUN_FROM, RUN_TO, availabilities(), -1)).toThrow(/must not be negative/);
    });

    it('refuses a run the market-hours table does not cover, rather than answering with an empty market', () => {
      const client = new FakeClient([], [dailyBar(DAY, 10)]) as unknown as AlpacaMarketDataClient;
      const pastTheTable = at(marketHoursCoverage.to, '16:00:00') + 24 * 60 * 60_000;
      const beforeTheTable = at(marketHoursCoverage.from, '09:30:00');

      // `marketHour` answers undefined outside the table rather than throwing, so every
      // daily bar past the end would go undated and be dropped: a symbol that looks as
      // though it stopped trading, on a run that reports a number anyway.
      expect(() => new BacktestMarketDataImpl(client, pastTheTable - 60_000, pastTheTable, availabilities())).toThrow(/market-hours table covers/);
      // And at the near end, where it is the buffer rather than the run that reaches out.
      expect(() => new BacktestMarketDataImpl(client, beforeTheTable, RUN_TO, availabilities(), BUFFER_MS)).toThrow(/market-hours table covers/);
    });
  });

  describe('before the clock starts', () => {
    it('refuses before asking the client, so a question asked too early costs no round trip', async () => {
      const client = new FakeClient([minuteBar(DAY, '09:30:00', 10)], [], [SPLIT]);
      const subject = build(client);

      await expect(subject.minuteBars({ symbol: 'AMZN', from: DAY })).rejects.toThrow(/clock has not started/);
      await expect(subject.dailyBars({ symbol: 'AMZN', from: DAY })).rejects.toThrow(/clock has not started/);
      await expect(subject.optionMinuteBars({ symbol: JAN_CALL_200.symbol, from: DAY })).rejects.toThrow(/clock has not started/);
      await expect(subject.stockSplits({ symbol: 'AMZN' })).rejects.toThrow(/clock has not started/);

      expect(client.requests).toEqual([]);
    });

    it('says the clock has not started rather than answering with an empty market', async () => {
      const subject = build(new FakeClient());

      await expect(subject.minuteBars({ symbol: 'AMZN', from: DAY })).rejects.toThrow(/clock has not started/);
      await expect(subject.dailyBars({ symbol: 'AMZN', from: DAY })).rejects.toThrow(/clock has not started/);
      await expect(subject.optionMinuteBars({ symbol: JAN_CALL_200.symbol, from: DAY })).rejects.toThrow(/clock has not started/);
      await expect(subject.optionDailyBars({ symbol: JAN_CALL_200.symbol, from: DAY })).rejects.toThrow(/clock has not started/);
      await expect(subject.listActiveOptionContracts({ underlying: 'AMZN' })).rejects.toThrow(/clock has not started/);
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

    it('leaves the clock off the view a strategy is handed', () => {
      const view: BacktestMarketDataView = build(new FakeClient());

      // @ts-expect-error `init` and `forward` belong to `BacktestMarketData`, which the
      // driver holds, and not to the view a strategy is given. A strategy that could step
      // only the market data would be reading bars the run has not reached, and the number
      // it reported would look entirely plausible. `BacktestPortfolio` narrows the account
      // for the same reason.
      const stepping: TimeSubscriber = view;

      expect(stepping.timeSubscriberId).toBeDefined();
    });

    it('refuses to be stepped to an instant it is already on or past', async () => {
      const subject = await marketData(new FakeClient(), at(DAY, '12:00:00'));

      await expect(subject.forward(at(DAY, '12:00:00'))).rejects.toThrow(/only ever stepped forward/);
    });
  });
});
