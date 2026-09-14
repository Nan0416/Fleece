import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { blackScholesPrice, marketHour, requireOccSymbol, type AlpacaMarketDataClient, type Bar, type OccSymbol } from '@fleece/marketdata';
import { easternClock } from '@fleece/utilities';

import {
  ImpliedVolatilityHistoryHelperImpl,
  lastPrint,
  measureSample,
  sampleTimes,
  solvePoint,
  straddlePairs,
  type ImpliedVolatilityHistory,
  type ImpliedVolatilityHistoryRequest,
  type MeasuredSample,
  type SessionSamples,
  type StraddlePair,
} from '../../src/utils/implied-volatility-history';
import type { OptionsAvailabilitiesHelper } from '../../src/utils/options-availabilities';

const DAY = '2024-03-04';
const OPEN = easternClock.timestamp(DAY, '09:30:00');
const ELEVEN = easternClock.timestamp(DAY, '11:00:00');
const MINUTE = 60_000;

function contract(symbol: string): OccSymbol {
  return requireOccSymbol(symbol, 'build a fixture');
}

function bar(symbol: string, t: number, close: number): Bar {
  return { S: symbol, o: close, h: close, l: close, c: close, v: 1, t };
}

/** A put and a call at one strike and expiration, as `straddlePairs` hands them back. */
function pair(expiration: string, strike: number): StraddlePair {
  const code = `${expiration.slice(2, 4)}${expiration.slice(5, 7)}${expiration.slice(8, 10)}`;
  const mils = String(strike * 1000).padStart(8, '0');
  return { put: contract(`AAPL${code}P${mils}`), call: contract(`AAPL${code}C${mils}`) };
}

function legs(...pairs: StraddlePair[]): OccSymbol[] {
  return pairs.flatMap(({ put, call }) => [put, call]);
}

describe('sampleTimes', () => {
  it('takes the half-hour bars from the open to the last one that ends by the close', () => {
    const times = sampleTimes(marketHour(DAY) ?? { openAt: 0, closeAt: 0 });
    expect(times).toEqual([
      '09:30:00',
      '10:00:00',
      '10:30:00',
      '11:00:00',
      '11:30:00',
      '12:00:00',
      '12:30:00',
      '13:00:00',
      '13:30:00',
      '14:00:00',
      '14:30:00',
      '15:00:00',
      '15:30:00',
    ]);
  });

  it('stops at 12:30 on a 13:00 close', () => {
    const times = sampleTimes(marketHour('2024-11-29') ?? { openAt: 0, closeAt: 0 });
    expect(times[times.length - 1]).toBe('12:30:00');
    expect(times).toHaveLength(7);
  });
});

describe('lastPrint', () => {
  it('takes the latest bar up to and including the sample bar', () => {
    const bars = [bar('X', ELEVEN - 5 * MINUTE, 1), bar('X', ELEVEN, 2), bar('X', ELEVEN + MINUTE, 3)];
    expect(lastPrint(bars, ELEVEN, OPEN)).toEqual({ price: 2, at: ELEVEN });
  });

  it('takes a print exactly fifteen minutes old, and not one a minute older', () => {
    expect(lastPrint([bar('X', ELEVEN - 15 * MINUTE, 1)], ELEVEN, OPEN)).toEqual({ price: 1, at: ELEVEN - 15 * MINUTE });
    expect(lastPrint([bar('X', ELEVEN - 16 * MINUTE, 1)], ELEVEN, OPEN)).toBeUndefined();
  });

  it('leaves out a print before the open, which would otherwise read as fresh at 09:30', () => {
    expect(lastPrint([bar('X', OPEN - MINUTE, 1)], OPEN, OPEN)).toBeUndefined();
  });

  it('does not depend on the bars arriving in order', () => {
    const bars = [bar('X', ELEVEN, 2), bar('X', ELEVEN - MINUTE, 1)];
    expect(lastPrint(bars, ELEVEN, OPEN)?.price).toBe(2);
  });
});

describe('straddlePairs', () => {
  it('orders by expiration nearest 30 days, then strike nearest the spot, three strikes an expiration', () => {
    // From 2024-03-04: 2024-04-05 is 32 days, 2024-03-28 is 24, and 2024-04-19 is 46, outside.
    const near = [pair('2024-04-05', 100), pair('2024-04-05', 105), pair('2024-04-05', 95), pair('2024-04-05', 90)];
    const next = [pair('2024-03-28', 100)];
    const outside = [pair('2024-04-19', 100)];
    const pairs = straddlePairs(legs(...outside, ...next, ...near), DAY, 101);

    expect(pairs.map(({ put }) => put.symbol)).toEqual(['AAPL240405P00100000', 'AAPL240405P00105000', 'AAPL240405P00095000', 'AAPL240328P00100000']);
  });

  it('takes the lower of two strikes equally near the spot, whatever order they are listed in', () => {
    const pairs = straddlePairs(legs(pair('2024-04-05', 105), pair('2024-04-05', 95)), DAY, 100);
    expect(pairs.map(({ put }) => put.strike)).toEqual([95, 105]);
  });

  it('leaves out a strike with only one side, and one more than 10% from the spot', () => {
    const lonely = pair('2024-04-05', 100).put;
    const far = pair('2024-04-05', 115);
    expect(straddlePairs([lonely, ...legs(far)], DAY, 100)).toEqual([]);
  });
});

describe('measureSample', () => {
  const first = pair('2024-04-05', 100);
  const second = pair('2024-04-05', 105);
  const spot = { price: 101, at: ELEVEN };

  it('takes the first pair whose legs both have a price', () => {
    const optionBars = new Map([
      [first.put.symbol, [bar(first.put.symbol, ELEVEN, 3)]],
      [second.put.symbol, [bar(second.put.symbol, ELEVEN - MINUTE, 5.5)]],
      [second.call.symbol, [bar(second.call.symbol, ELEVEN - 2 * MINUTE, 2.25)]],
    ]);
    const sample = measureSample({ date: DAY, time: '11:00:00', openAt: OPEN, spot, pairs: [first, second], optionBars });

    expect(sample).toEqual({
      status: 'measured',
      time: '11:00:00',
      spot: 101,
      spotAt: ELEVEN,
      putSymbol: second.put.symbol,
      putPrice: 5.5,
      putAt: ELEVEN - MINUTE,
      callSymbol: second.call.symbol,
      callPrice: 2.25,
      callAt: ELEVEN - 2 * MINUTE,
    });
  });

  it('says why there is no sample', () => {
    const input = { date: DAY, time: '11:00:00', openAt: OPEN, optionBars: new Map<string, Bar[]>() };
    expect(measureSample({ ...input, pairs: [first] })).toEqual({ status: 'unmeasured', time: '11:00:00', reason: 'no-spot' });
    expect(measureSample({ ...input, spot, pairs: [] })).toEqual({ status: 'unmeasured', time: '11:00:00', reason: 'no-contracts' });
    expect(measureSample({ ...input, spot, pairs: [first] })).toEqual({ status: 'unmeasured', time: '11:00:00', reason: 'no-priced-pair' });
  });
});

describe('solvePoint', () => {
  const { put, call } = pair('2024-04-05', 100);
  const rate = 0.043;
  const dividendYield = 0.004;
  // As of the end of the 11:00 bar, which is when its close printed.
  const tYears = (easternClock.timestamp('2024-04-05', '16:00:00') - (ELEVEN + MINUTE)) / (365 * 24 * 60 * 60 * 1000);

  function sample(putPrice: number, callPrice: number): MeasuredSample {
    return { status: 'measured', time: '11:00:00', spot: 101, spotAt: ELEVEN, putSymbol: put.symbol, putPrice, putAt: ELEVEN, callSymbol: call.symbol, callPrice, callAt: ELEVEN };
  }

  it('recovers the volatility each leg was priced at, with the rate and yield given at read time', () => {
    const input = { spot: 101, strike: 100, tYears, rate, dividendYield };
    const putPrice = blackScholesPrice({ ...input, vol: 0.31, type: 'put' });
    const callPrice = blackScholesPrice({ ...input, vol: 0.27, type: 'call' });
    const point = solvePoint(DAY, sample(putPrice, callPrice), rate, dividendYield);

    expect(point?.putIv).toBeCloseTo(0.31, 4);
    expect(point?.callIv).toBeCloseTo(0.27, 4);
    expect(point).toMatchObject({ date: DAY, spot: 101, spotAt: ELEVEN, putSymbol: put.symbol, callSymbol: call.symbol });
  });

  it('gives no point when either leg has no volatility, rather than a point with one side', () => {
    // A call below its intrinsic value of 1 is outside the no-arbitrage band.
    expect(solvePoint(DAY, sample(3, 0.5), rate, dividendYield)).toBeUndefined();
  });
});

const HISTORY_START = ['2024-02-01', '2024-02-02', '2024-02-05'];
/** Weekly expirations far enough out that every session in these tests has one 20 to 40 days away. */
const CHAIN = legs(
  ...[
    '2024-03-01',
    '2024-03-08',
    '2024-03-15',
    '2024-03-22',
    '2024-03-28',
    '2024-04-05',
    '2024-04-12',
    '2024-04-19',
    '2024-04-26',
    '2024-05-03',
    '2024-05-10',
    '2024-05-17',
    '2024-05-24',
  ].map((expiration) => pair(expiration, 100)),
);

/** Serves a flat $100 stock every minute and, on the dates it is given, both legs of the 100 strike at 11:00. */
class FakeClient {
  readonly stockDates: string[] = [];
  readonly optionDates: string[] = [];
  failOn: string | undefined;

  constructor(private readonly pricedDates: ReadonlyArray<string> = []) {}

  async minuteBars(request: { symbol: string; from: string; to: string }): Promise<unknown> {
    if (request.from === this.failOn) {
      throw new Error('Alpaca returned 429 for /v2/stocks/bars.');
    }
    this.stockDates.push(request.from);
    const openAt = marketHour(request.from)?.openAt ?? 0;
    return { bars: Array.from({ length: 390 }, (_, index) => bar(request.symbol, openAt + index * MINUTE, 100)) };
  }

  async optionBarsBySymbol(request: { symbols: ReadonlyArray<string>; from: string }): Promise<unknown> {
    this.optionDates.push(request.from);
    const bars = new Map<string, ReadonlyArray<Bar>>();
    if (this.pricedDates.includes(request.from)) {
      const eleven = easternClock.timestamp(request.from, '11:00:00');
      for (const symbol of request.symbols) {
        bars.set(symbol, [bar(symbol, eleven, contract(symbol).type === 'put' ? 3 : 4)]);
      }
    }
    return { bars };
  }
}

function availabilities(listedAt: number | undefined): OptionsAvailabilitiesHelper {
  return { cachePath: '/nowhere', save: async () => {}, availableOptions: async () => CHAIN, refreshedAt: async () => listedAt };
}

function afterClose(date: string): number {
  return easternClock.timestamp(date, '20:00:00');
}

function helper(root: string, client: FakeClient, now: number, listedAt: number | undefined = now): ImpliedVolatilityHistoryHelperImpl {
  // The fake implements the slice of the client this class touches, which the compiler cannot know.
  return new ImpliedVolatilityHistoryHelperImpl(root, client as unknown as AlpacaMarketDataClient, availabilities(listedAt), () => now, 1);
}

function readHistory(root: string): ImpliedVolatilityHistory {
  return JSON.parse(readFileSync(join(root, 'implied-volatility', 'AAPL.json'), 'utf8')) as ImpliedVolatilityHistory;
}

describe('ImpliedVolatilityHistoryHelperImpl', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'iv-history-'));
  });

  it('sweeps every closed session from the start of the history, at every half hour', async () => {
    const client = new FakeClient(['2024-02-02']);
    await helper(root, client, afterClose('2024-02-05')).save('aapl');

    const history = readHistory(root);
    expect(history.sessions.map((session) => session.date)).toEqual(HISTORY_START);
    expect(history.sessions[0].samples).toHaveLength(13);
    expect(history.sessions[0].samples.find((sample) => sample.time === '11:00:00')).toEqual({ status: 'unmeasured', time: '11:00:00', reason: 'no-priced-pair' });
    // 2024-03-01 is 29 days from 2024-02-02, the nearest to 30.
    expect(history.sessions[1].samples.find((sample) => sample.time === '11:00:00')).toMatchObject({
      status: 'measured',
      putSymbol: 'AAPL240301P00100000',
      putPrice: 3,
      callPrice: 4,
    });
  });

  it('carries on after the last session it holds rather than sweeping again from the start', async () => {
    await helper(root, new FakeClient(), afterClose('2024-02-05')).save('AAPL');

    const client = new FakeClient();
    await helper(root, client, afterClose('2024-02-07')).save('AAPL');

    expect(client.stockDates).toEqual(['2024-02-06', '2024-02-07']);
    expect(readHistory(root).sessions.map((session) => session.date)).toEqual([...HISTORY_START, '2024-02-06', '2024-02-07']);
  });

  it('leaves a session still trading for the next save', async () => {
    const client = new FakeClient();
    await helper(root, client, easternClock.timestamp('2024-02-05', '15:00:00')).save('AAPL');
    expect(client.stockDates).toEqual(['2024-02-01', '2024-02-02']);
  });

  it('stops at the last session to close before the contract listing was refreshed', async () => {
    const client = new FakeClient();
    await helper(root, client, afterClose('2024-02-07'), afterClose('2024-02-02')).save('AAPL');
    expect(client.stockDates).toEqual(['2024-02-01', '2024-02-02']);
  });

  it('keeps every 50 sessions it swept when a later one fails, and the next save carries on from there', async () => {
    const now = afterClose('2024-04-19');
    const failing = new FakeClient();
    failing.failOn = '2024-04-17';
    await expect(helper(root, failing, now).save('AAPL')).rejects.toThrow('429');

    const kept = readHistory(root).sessions;
    expect(kept).toHaveLength(50);
    expect(kept[kept.length - 1].date).toBe('2024-04-12');

    const client = new FakeClient();
    await helper(root, client, now).save('AAPL');
    expect(client.stockDates[0]).toBe('2024-04-15');
    expect(readHistory(root).sessions).toHaveLength(55);
  });

  it('writes nothing when there is nothing new to sweep', async () => {
    await helper(root, new FakeClient(), afterClose('2024-02-05')).save('AAPL');
    const before = readFileSync(join(root, 'implied-volatility', 'AAPL.json'), 'utf8');

    const client = new FakeClient();
    await helper(root, client, afterClose('2024-02-05') + MINUTE).save('AAPL');

    expect(client.stockDates).toEqual([]);
    expect(readFileSync(join(root, 'implied-volatility', 'AAPL.json'), 'utf8')).toBe(before);
  });

  it('sweeps on the first read when nothing has been swept, and answers later reads from memory', async () => {
    const client = new FakeClient();
    const subject = helper(root, client, afterClose('2024-02-05'));

    expect((await subject.sessions('AAPL')).map((session) => session.date)).toEqual(HISTORY_START);
    await subject.sessions('AAPL');
    expect(client.stockDates).toHaveLength(3);
  });

  it('refuses a file it cannot read rather than sweeping over it', async () => {
    mkdirSync(join(root, 'implied-volatility'), { recursive: true });
    writeFileSync(
      join(root, 'implied-volatility', 'AAPL.json'),
      JSON.stringify({ underlying: 'AAPL', refreshedAt: 0, sessions: [{ date: DAY, samples: [{ status: 'measured', time: '11:05' }] }] }),
    );

    await expect(helper(root, new FakeClient(), afterClose('2024-02-05')).sessions('AAPL')).rejects.toThrow('Delete it to sweep AAPL again from scratch');
  });

  describe('impliedVolatilityHistory', () => {
    const PUT = 'AAPL240405P00100000';
    const CALL = 'AAPL240405C00100000';
    const RATE = 0.043;
    const NEXT = '2024-03-05';
    const LATER = '2024-03-06';

    /** A sample at `time` whose legs were priced at 30 vol, so each point solves to it. */
    function priced(date: string, time: string): MeasuredSample {
      const minute = easternClock.timestamp(date, time);
      const tYears = (easternClock.timestamp('2024-04-05', '16:00:00') - (minute + MINUTE)) / (365 * 24 * 60 * 60 * 1000);
      const input = { spot: 100, strike: 100, tYears, rate: RATE, vol: 0.3 };
      return {
        status: 'measured',
        time,
        spot: 100,
        spotAt: minute,
        putSymbol: PUT,
        putPrice: blackScholesPrice({ ...input, type: 'put' }),
        putAt: minute,
        callSymbol: CALL,
        callPrice: blackScholesPrice({ ...input, type: 'call' }),
        callAt: minute,
      };
    }

    const SESSIONS: ReadonlyArray<SessionSamples> = [
      { date: DAY, samples: [priced(DAY, '10:30:00'), priced(DAY, '11:00:00')] },
      { date: NEXT, samples: [{ status: 'unmeasured', time: '11:00:00', reason: 'no-priced-pair' }] },
      { date: LATER, samples: [priced(LATER, '11:00:00')] },
    ];

    function subject(): ImpliedVolatilityHistoryHelperImpl {
      mkdirSync(join(root, 'implied-volatility'), { recursive: true });
      const history: ImpliedVolatilityHistory = { underlying: 'AAPL', refreshedAt: 0, sessions: SESSIONS };
      writeFileSync(join(root, 'implied-volatility', 'AAPL.json'), JSON.stringify(history));
      return helper(root, new FakeClient(), afterClose(LATER));
    }

    function request(timestamp: number, limit = 10): ImpliedVolatilityHistoryRequest {
      return { underlying: 'aapl', time: '11:00:00', timestamp, limit, riskFreeRate: RATE, dividendYield: 0 };
    }

    it('shows a sample only once its bar would have been published, a minute and four seconds after it starts', async () => {
      const history = subject();
      const atPublish = await history.impliedVolatilityHistory(request(easternClock.timestamp(LATER, '11:01:04')));
      const after = await history.impliedVolatilityHistory(request(easternClock.timestamp(LATER, '11:01:05')));

      expect(atPublish.points.map((point) => point.date)).toEqual([DAY]);
      expect(after.points.map((point) => point.date)).toEqual([DAY, LATER]);
    });

    it('solves each leg at the rate and yield asked for, and leaves out a session with nothing measured at that time', async () => {
      const { points } = await subject().impliedVolatilityHistory(request(afterClose(LATER)));

      expect(points).toHaveLength(2);
      expect(points[1]).toMatchObject({ date: LATER, spot: 100, putSymbol: PUT, callSymbol: CALL });
      expect(points[1].putIv).toBeCloseTo(0.3, 4);
      expect(points[1].callIv).toBeCloseTo(0.3, 4);
    });

    it('keeps the most recent points up to the limit', async () => {
      const { points } = await subject().impliedVolatilityHistory(request(afterClose(LATER), 1));
      expect(points.map((point) => point.date)).toEqual([LATER]);
    });

    it('refuses a time off the half-hour grid rather than answering with no history', async () => {
      await expect(subject().impliedVolatilityHistory({ ...request(afterClose(LATER)), time: '11:05:00' })).rejects.toThrow('not a sample time');
    });
  });
});
