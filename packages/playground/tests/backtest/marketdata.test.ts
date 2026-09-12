import { marketHour, requireOccSymbol, type AlpacaMarketDataClient, type Bar, type OccSymbol, type StockSplit } from '@fleece/marketdata';
import { easternClock } from '@fleece/utilities';

import { BacktestMarketDataImpl } from '../../src/backtest/marketdata';
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

  async optionBars(request: { from: unknown; to: unknown }): Promise<unknown> {
    this.requests.push({ kind: 'option', from: request.from, to: request.to });
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

async function marketData(client: FakeClient, now: number): Promise<BacktestMarketDataImpl> {
  // The fake implements the slice of the client this class touches, which the compiler cannot know.
  const subject = new BacktestMarketDataImpl(client as unknown as AlpacaMarketDataClient, availabilities());
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

    it('asks the client for unadjusted bars, whatever the caller wanted', async () => {
      const client = new FakeClient(bars, [], [SPLIT]);
      const subject = await marketData(client, at(DAY, '16:00:00'));

      await subject.minuteBars({ symbol: 'AMZN', from: DAY, adjustForSplit: true });

      expect(client.requests.filter((request) => request.kind === 'minute')).toEqual([{ kind: 'minute', from: DAY, to: DAY, adjustForSplit: false }]);
    });

    it('fetches once a day however many minutes ask, and again when the day turns', async () => {
      const client = new FakeClient(bars);
      const subject = await marketData(client, at(DAY, '09:31:00'));

      await subject.minuteBars({ symbol: 'AMZN', from: DAY });
      await subject.forward(at(DAY, '09:32:00'));
      await subject.minuteBars({ symbol: 'AMZN', from: DAY });
      expect(client.requests.filter((request) => request.kind === 'minute')).toHaveLength(1);

      await subject.forward(at(NEXT, '09:31:00'));
      await subject.minuteBars({ symbol: 'AMZN', from: DAY });
      expect(client.requests.filter((request) => request.kind === 'minute')).toHaveLength(2);
    });

    it('answers with nothing for a window that has not started yet', async () => {
      const client = new FakeClient(bars);
      const subject = await marketData(client, at(DAY, '09:31:00'));

      const { bars: seen } = await subject.minuteBars({ symbol: 'AMZN', from: AFTER_SPLIT });

      expect(seen).toEqual([]);
      expect(client.requests).toEqual([]); // never asked: the range would run backwards
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

    it('leaves out the bar still in progress', async () => {
      const subject = await marketData(new FakeClient([], [], [], bars), at(DAY, '09:31:00'));

      const { bars: seen } = await subject.optionBars({ symbol: JAN_CALL_200.symbol, from: DAY, to: DAY, multiplier: 1, timespan: 'minute' });

      expect(seen.map((bar) => bar.c)).toEqual([3.5]);
    });

    it('counts a multi-minute bar as finished only once every minute of it has passed', async () => {
      const fiveMinute = [{ ...minuteBar(DAY, '09:30:00', 3.5) }];
      const tooEarly = await marketData(new FakeClient([], [], [], fiveMinute), at(DAY, '09:34:00'));
      const onTime = await marketData(new FakeClient([], [], [], fiveMinute), at(DAY, '09:35:00'));

      const request = { symbol: JAN_CALL_200.symbol, from: DAY, to: DAY, multiplier: 5, timespan: 'minute' } as const;
      expect((await tooEarly.optionBars(request)).bars).toEqual([]);
      expect((await onTime.optionBars(request)).bars).toHaveLength(1);
    });

    it('refuses a timespan whose end it cannot date, rather than guessing', async () => {
      const subject = await marketData(new FakeClient(), at(DAY, '12:00:00'));

      await expect(subject.optionBars({ symbol: JAN_CALL_200.symbol, from: DAY, to: DAY, multiplier: 1, timespan: 'week' })).rejects.toThrow(/cannot serve week option bars/);
    });

    it('never adjusts for a split, because a split re-issues a contract rather than restating it', async () => {
      const subject = await marketData(new FakeClient([], [], [SPLIT], bars), at(AFTER_SPLIT, '12:00:00'));

      const { bars: seen } = await subject.optionBars({ symbol: JAN_CALL_200.symbol, from: DAY, to: AFTER_SPLIT, multiplier: 1, timespan: 'minute' });

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

  describe('before the clock starts', () => {
    it('says the clock has not started rather than answering with an empty market', async () => {
      const subject = new BacktestMarketDataImpl(new FakeClient() as unknown as AlpacaMarketDataClient, availabilities());

      await expect(subject.minuteBars({ symbol: 'AMZN', from: DAY })).rejects.toThrow(/clock has not started/);
      await expect(subject.listActiveOptionContracts({ underlying: 'AMZN' })).rejects.toThrow(/clock has not started/);
    });

    it('refuses to be stepped to an instant it is already on or past', async () => {
      const subject = await marketData(new FakeClient(), at(DAY, '12:00:00'));

      await expect(subject.forward(at(DAY, '12:00:00'))).rejects.toThrow(/only ever stepped forward/);
    });
  });
});
