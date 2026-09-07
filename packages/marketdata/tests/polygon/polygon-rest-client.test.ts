import { easternClock, InternalServiceError, InvalidRequestError } from '@fleece/shared';

import { DataProviderError } from '../../src/equity-data-models';
import { marketHoursCoverage } from '../../src/market-hours';
import { PolygonRestClient } from '../../src/polygon';

import { aggregates, FakeHttpClient, quotes, snapshot, splits, trades } from './fake-http-client';

// 2024-12-19 is a full trading session; 2024-12-24 is a half day closing at 13:00.
const SESSION = '2024-12-19';
const at = (date: string, time: string): number => easternClock.timestamp(date, time);

function client(http: FakeHttpClient): PolygonRestClient {
  return new PolygonRestClient({ apiKey: 'test-key', httpClient: http });
}

function page(count: number, prefix: string): unknown {
  return {
    status: 'OK',
    results: Array.from({ length: count }, (_, index) => ({
      ticker: `${prefix}${index}`,
      name: `${prefix} ${index}`,
      market: 'stocks',
      locale: 'us',
      primary_exchange: 'XNAS',
      type: 'CS',
      active: true,
      currency_name: 'usd',
      cik: '1',
      composite_figi: 'f',
      share_class_figi: 'g',
      last_updated_utc: '2024-12-19T00:00:00Z',
    })),
  };
}

describe('every request', () => {
  it('carries the API key', async () => {
    const http = new FakeHttpClient().reply(aggregates());
    await client(http).bars({ symbol: 'AAPL', from: SESSION, to: SESSION, multiplier: 1, timespan: 'day' });

    expect(http.lastRequest.query['apiKey']).toBe('test-key');
  });

  it('reports a non-200 as a provider error naming the status', async () => {
    const http = new FakeHttpClient().replyWithStatus(429, { error: 'rate limited' });
    const send = client(http).bars({ symbol: 'AAPL', from: SESSION, to: SESSION, multiplier: 1, timespan: 'day' });

    await expect(send).rejects.toThrow(DataProviderError);
    await expect(send).rejects.toThrow(/returned 429/);
  });

  it('reports a failure with an empty body as a provider error, not a TypeError', async () => {
    // A 502 from a proxy in front of Polygon has no body, and an empty body parses to
    // undefined — which the error path itself used to choke on.
    const http = new FakeHttpClient().replyWithStatus(502, undefined);
    const send = client(http).bars({ symbol: 'AAPL', from: SESSION, to: SESSION, multiplier: 1, timespan: 'day' });

    await expect(send).rejects.toThrow(DataProviderError);
    await expect(send).rejects.toThrow(/returned 502/);
  });

  it('escapes a symbol rather than letting it change the path or the query', async () => {
    const http = new FakeHttpClient().reply({ status: 'OK', results: null });
    await client(http).tickerDetails({ symbol: 'BRK B?limit=1' });

    expect(http.lastRequest.url).toBe('/v3/reference/tickers/BRK%20B%3Flimit%3D1');
    expect(http.lastRequest.query['limit']).toBeUndefined();
  });

  it('refuses a body that is not a JSON object', async () => {
    const http = new FakeHttpClient().reply('<html>maintenance</html>');
    await expect(client(http).bars({ symbol: 'AAPL', from: SESSION, to: SESSION, multiplier: 1, timespan: 'day' })).rejects.toThrow(/not a JSON object/);
  });
});

describe('bars', () => {
  it('asks for one daily range and normalises the result', async () => {
    const http = new FakeHttpClient().reply(aggregates({ t: at(SESSION, '09:30:00'), c: 250.5 }));
    const { bars } = await client(http).bars({ symbol: 'AAPL', from: '2024-12-16', to: SESSION, multiplier: 1, timespan: 'day' });

    expect(http.requests).toHaveLength(1);
    expect(http.lastRequest.url).toBe(`/v2/aggs/ticker/AAPL/range/1/day/${at('2024-12-16', '00:00:00')}/${at(SESSION, '23:59:59')}`);
    expect(bars).toStrictEqual([{ S: 'AAPL', o: 1, h: 3, l: 0.5, c: 250.5, v: 100, t: at(SESSION, '09:30:00') }]);
  });

  it('asks Polygon for split-adjusted prices only when told to', async () => {
    const http = new FakeHttpClient().reply(aggregates());
    const polygon = client(http);

    await polygon.bars({ symbol: 'AAPL', from: SESSION, to: SESSION, multiplier: 1, timespan: 'day' });
    expect(http.lastRequest.query['adjusted']).toBe('false');

    await polygon.bars({ symbol: 'AAPL', from: SESSION, to: SESSION, multiplier: 1, timespan: 'day', adjustForSplit: true });
    expect(http.lastRequest.query['adjusted']).toBe('true');
  });

  it('reads a date as the whole Eastern day, not as midnight UTC', async () => {
    const http = new FakeHttpClient().reply(aggregates());
    await client(http).bars({ symbol: 'AAPL', from: SESSION, to: SESSION, multiplier: 1, timespan: 'day' });

    const [from, to] = http.lastRequest.url.split('/day/')[1].split('/').map(Number);
    // 2024-12-19 in New York is 05:00Z to 04:59:59Z the next day, in December.
    expect(from).toBe(Date.parse('2024-12-19T05:00:00Z'));
    expect(to).toBe(Date.parse('2024-12-20T04:59:59Z'));
  });

  it('splits an intraday range into windows rather than asking for years at once', async () => {
    const http = new FakeHttpClient().reply(aggregates());
    // 2023-01-03 to 2024-12-19 is a little under two years, so four 50-day windows and more.
    await client(http).bars({ symbol: 'AAPL', from: '2023-01-03', to: SESSION, multiplier: 1, timespan: 'minute', marketHoursOnly: false });

    expect(http.requests.length).toBeGreaterThan(10);
    const ranges = http.requests.map((request) => request.url.split('/minute/')[1].split('/').map(Number));
    // Contiguous and non-overlapping: each window starts the millisecond the last ended.
    for (let index = 1; index < ranges.length; index += 1) {
      expect(ranges[index][0]).toBe(ranges[index - 1][1] + 1);
    }
  });

  it('keeps only bars inside regular hours by default', async () => {
    const preMarket = at(SESSION, '08:00:00');
    const open = at(SESSION, '10:30:00');
    const afterHours = at(SESSION, '17:00:00');
    const http = new FakeHttpClient().reply(aggregates({ t: preMarket }, { t: open }, { t: afterHours }));

    const { bars } = await client(http).bars({ symbol: 'AAPL', from: SESSION, to: SESSION, multiplier: 1, timespan: 'minute' });
    expect(bars.map((bar) => bar.t)).toStrictEqual([open]);
  });

  it('keeps the extended session when asked explicitly', async () => {
    const http = new FakeHttpClient().reply(aggregates({ t: at(SESSION, '08:00:00') }, { t: at(SESSION, '10:30:00') }));
    const { bars } = await client(http).bars({ symbol: 'AAPL', from: SESSION, to: SESSION, multiplier: 1, timespan: 'minute', marketHoursOnly: false });

    expect(bars).toHaveLength(2);
  });

  it('never filters a daily bar, which spans the whole session anyway', async () => {
    const http = new FakeHttpClient().reply(aggregates({ t: at(SESSION, '00:00:00') }));
    const { bars } = await client(http).bars({ symbol: 'AAPL', from: SESSION, to: SESSION, multiplier: 1, timespan: 'day' });

    expect(bars).toHaveLength(1);
  });

  it('refuses a timespan or multiplier Polygon does not aggregate', async () => {
    const polygon = client(new FakeHttpClient().reply(aggregates()));

    await expect(polygon.bars({ symbol: 'AAPL', from: SESSION, to: SESSION, multiplier: 1, timespan: 'fortnight' as never })).rejects.toThrow(InvalidRequestError);
    await expect(polygon.bars({ symbol: 'AAPL', from: SESSION, to: SESSION, multiplier: 7, timespan: 'minute' })).rejects.toThrow(/not a valid minute multiplier/);
  });

  it('says the market-hours table needs refreshing rather than filtering every bar away', async () => {
    const past = easternClock.shiftDate(marketHoursCoverage.to, 30);
    const http = new FakeHttpClient().reply(aggregates({ t: at(past, '10:30:00') }));
    const send = client(http).bars({ symbol: 'AAPL', from: past, to: past, multiplier: 1, timespan: 'minute' });

    // Ours, not Polygon's: nothing was asked of them, and no caller can fix it.
    await expect(send).rejects.toThrow(InternalServiceError);
    await expect(send).rejects.toThrow(/market-hours table stops at 2024-12-31/);
    expect(http.requests).toHaveLength(0);
  });

  it('refuses a range that ends before it starts', async () => {
    const polygon = client(new FakeHttpClient().reply(aggregates()));

    await expect(polygon.bars({ symbol: 'AAPL', from: '2024-12-20', to: '2024-12-19', multiplier: 1, timespan: 'day' })).rejects.toThrow(/must start before it ends/);
    await expect(polygon.bars({ symbol: 'AAPL', from: '2023-01-03', to: '2022-01-03', multiplier: 1, timespan: 'minute' })).rejects.toThrow(/must start before it ends/);
  });

  it('guards the start of the market-hours table as well as its end', async () => {
    // Before 2001 every bar reads as closed too, which would empty the result silently.
    const http = new FakeHttpClient().reply(aggregates({ t: Date.parse('1999-01-04T15:00:00Z') }));
    const send = client(http).bars({ symbol: 'AAPL', from: '1999-01-04', to: '1999-01-05', multiplier: 1, timespan: 'minute' });

    await expect(send).rejects.toThrow(/market-hours table starts at 2001-01-02/);
    // Refused before the requests, not after paying for them.
    expect(http.requests).toHaveLength(0);
  });

  it('refuses a window Polygon truncated instead of reporting it as the whole of one', async () => {
    // Aggregates carry no cursor, so a page that comes back exactly full is a cut-off
    // window that reads like a symbol which stopped trading.
    const full = Array.from({ length: 50_000 }, (_, index) => ({ t: at(SESSION, '00:00:00') + index }));
    const http = new FakeHttpClient().reply(aggregates(...full));
    const send = client(http).bars({ symbol: 'AAPL', from: SESSION, to: SESSION, multiplier: 1, timespan: 'day' });

    await expect(send).rejects.toThrow(DataProviderError);
    await expect(send).rejects.toThrow(/the window is truncated/);
  });

  it('refuses a date that is shaped right but does not exist', async () => {
    // 2024-02-30 passed the shape check and has no session, so `trades` reported a day
    // that never existed as one the market was shut, and `bars` reached the clock and
    // threw a bare Error — a 500 for something a caller sent.
    const http = new FakeHttpClient();
    const polygon = client(http);

    await expect(polygon.trades({ symbol: 'AAPL', date: '2024-02-30' })).rejects.toThrow(InvalidRequestError);
    await expect(polygon.bars({ symbol: 'AAPL', from: '2024-02-30', to: SESSION, multiplier: 1, timespan: 'day' })).rejects.toThrow(InvalidRequestError);
    await expect(polygon.historicalBars({ symbol: 'AAPL', endDate: '2023-02-29', days: 1 })).rejects.toThrow(/real ISO YYYY-MM-DD calendar date/);
    expect(http.requests).toHaveLength(0);
  });

  it('refuses a date that is not ISO, rather than blaming the market-hours table', async () => {
    const polygon = client(new FakeHttpClient());
    // A typo sorts after 2024-12-31, so an unchecked comparison sends an operator off to
    // refresh a data file.
    await expect(polygon.bars({ symbol: 'AAPL', from: 'yesterday', to: SESSION, multiplier: 1, timespan: 'day' })).rejects.toThrow(InvalidRequestError);
    await expect(polygon.trades({ symbol: 'AAPL', date: 'yesterday' })).rejects.toThrow(/expected a real ISO YYYY-MM-DD calendar date/);
  });

  it('returns nothing for a symbol Polygon has no aggregates for', async () => {
    const http = new FakeHttpClient().reply({ status: 'OK', resultsCount: 0 });
    expect((await client(http).bars({ symbol: 'NOSUCH', from: SESSION, to: SESSION, multiplier: 1, timespan: 'day' })).bars).toStrictEqual([]);
  });
});

describe('minuteBars and dailyBars', () => {
  it('are the one-multiplier cases of bars', async () => {
    const http = new FakeHttpClient().reply(aggregates());
    const polygon = client(http);

    await polygon.minuteBars({ symbol: 'AAPL', from: SESSION, to: SESSION, marketHoursOnly: false });
    expect(http.lastRequest.url).toContain('/range/1/minute/');

    await polygon.dailyBars({ symbol: 'AAPL', from: SESSION, to: SESSION });
    expect(http.lastRequest.url).toContain('/range/1/day/');
  });
});

describe('trades', () => {
  it('covers a trading day from pre-market open to after-hours close', async () => {
    const http = new FakeHttpClient().reply(trades({ ms: at(SESSION, '09:30:01'), price: 250 }));
    const { trades: result } = await client(http).trades({ symbol: 'AAPL', date: SESSION });

    expect(http.lastRequest.url).toBe('/v3/trades/AAPL');
    expect(http.lastRequest.query['timestamp.gte']).toBe(String(BigInt(at(SESSION, '04:00:00')) * BigInt(1_000_000)));
    expect(http.lastRequest.query['timestamp.lt']).toBe(String(BigInt(at(SESSION, '20:00:00')) * BigInt(1_000_000)));
    expect(result).toStrictEqual([{ S: 'AAPL', t: at(SESSION, '09:30:01'), s: 10, c: [12], p: 250, i: 't0', x: 4, z: 3 }]);
  });

  it('has nothing for a day the market was shut', async () => {
    const http = new FakeHttpClient();
    expect((await client(http).trades({ symbol: 'AAPL', date: '2024-12-25' })).trades).toStrictEqual([]);
    expect(http.requests).toHaveLength(0);
  });

  it('pages from just before the last trade seen, and stops on a short page', async () => {
    const first = trades({ ms: at(SESSION, '10:00:00'), price: 1 }, { ms: at(SESSION, '10:00:01'), price: 2 });
    const second = trades({ ms: at(SESSION, '10:00:02'), price: 3 });
    const http = new FakeHttpClient().reply(first, second);

    const { trades: result } = await client(http).trades({ symbol: 'AAPL', date: SESSION, itemsPerRequest: 2 });

    expect(result.map((trade) => trade.p)).toStrictEqual([1, 2, 3]);
    expect(http.requests).toHaveLength(2);
    // Behind the last timestamp by more than a double's rounding error at that magnitude.
    expect(http.requests[1].query['timestamp.gte']).toBe(String(BigInt(at(SESSION, '10:00:01')) * BigInt(1_000_000) - BigInt(1024)));
  });

  it('drops the trades the backoff re-reads rather than returning them twice', async () => {
    const boundary = { ms: at(SESSION, '10:00:01'), price: 2 };
    const http = new FakeHttpClient().reply(
      trades({ ms: at(SESSION, '10:00:00'), price: 1 }, boundary),
      trades(boundary, { ms: at(SESSION, '10:00:02'), price: 3 }),
      trades({ ms: at(SESSION, '10:00:03'), price: 4 }),
    );

    const { trades: result } = await client(http).trades({ symbol: 'AAPL', date: SESSION, itemsPerRequest: 2 });
    expect(result.map((trade) => trade.p)).toStrictEqual([1, 2, 3, 4]);
  });

  it('refuses a window where paging cannot advance, rather than returning half of it', async () => {
    // Every page identical: the cursor is stuck, and what we hold is part of a session
    // a caller could not tell from the whole of one.
    const http = new FakeHttpClient().reply(trades({ ms: at(SESSION, '10:00:00'), price: 1 }, { ms: at(SESSION, '10:00:01'), price: 2 }));
    const send = client(http).trades({ symbol: 'AAPL', date: SESSION, itemsPerRequest: 2 });

    await expect(send).rejects.toThrow(DataProviderError);
    await expect(send).rejects.toThrow(/paging cannot advance past/);
  });

  it('refuses a window that crosses an Eastern day boundary', async () => {
    const send = client(new FakeHttpClient()).trades({ symbol: 'AAPL', from: at(SESSION, '19:00:00'), to: at('2024-12-20', '10:00:00') });
    await expect(send).rejects.toThrow(/must stay inside one Eastern day/);
  });

  it('refuses a day past the market-hours table rather than reporting no trades', async () => {
    // The hole this closes: a backfill over recent days would record nothing and succeed.
    const past = easternClock.shiftDate(marketHoursCoverage.to, 30);
    const http = new FakeHttpClient();
    const send = client(http).trades({ symbol: 'AAPL', date: past });

    await expect(send).rejects.toThrow(/market-hours table stops at 2024-12-31/);
    expect(http.requests).toHaveLength(0);
  });

  it('refuses a timestamp window past the table too', async () => {
    const past = easternClock.timestamp(easternClock.shiftDate(marketHoursCoverage.to, 30), '10:00:00');
    await expect(client(new FakeHttpClient()).quotes({ symbol: 'AAPL', from: past, to: past + 1000 })).rejects.toThrow(/market-hours table stops/);
  });

  it('clamps a page size above what Polygon will serve, so a full page still ends the walk', async () => {
    const http = new FakeHttpClient().reply(trades({ ms: at(SESSION, '10:00:00'), price: 1 }));
    await client(http).trades({ symbol: 'AAPL', date: SESSION, itemsPerRequest: 100_000 });

    expect(http.lastRequest.query['limit']).toBe('50000');
  });

  it('refuses a page size of zero or less', async () => {
    const polygon = client(new FakeHttpClient());
    await expect(polygon.trades({ symbol: 'AAPL', date: SESSION, itemsPerRequest: 0 })).rejects.toThrow(/at least one item per request/);
    await expect(polygon.trades({ symbol: 'AAPL', date: SESSION, itemsPerRequest: -5 })).rejects.toThrow(/at least one item per request/);
  });

  it('refuses a window that ends before it starts, and one with no start at all', async () => {
    const polygon = client(new FakeHttpClient());
    await expect(polygon.trades({ symbol: 'AAPL', from: at(SESSION, '11:00:00'), to: at(SESSION, '10:00:00') })).rejects.toThrow(/must start before it ends/);
    await expect(polygon.trades({ symbol: 'AAPL' })).rejects.toThrow(/needs either a date or a from timestamp/);
  });

  it('adjusts a price recorded before a split, and leaves a later one alone', async () => {
    const beforeSplit = at('2020-08-28', '10:00:00');
    const http = new FakeHttpClient().reply(trades({ ms: beforeSplit, price: 499.23 }), splits({ date: '2020-08-31', from: 1, to: 4 }));

    const { trades: tradeResults } = await client(http).trades({ symbol: 'AAPL', from: beforeSplit, to: beforeSplit + 60_000, adjustForSplit: true });
    expect(tradeResults[0].p).toBeCloseTo(124.8075, 4);
  });

  it('does not ask for splits when no adjustment was requested', async () => {
    const http = new FakeHttpClient().reply(trades({ ms: at(SESSION, '10:00:00'), price: 250 }));
    await client(http).trades({ symbol: 'AAPL', date: SESSION });

    expect(http.requests.map((request) => request.url)).toStrictEqual(['/v3/trades/AAPL']);
  });
});

describe('quotes', () => {
  it('normalises both sides of the book', async () => {
    const http = new FakeHttpClient().reply(quotes({ ms: at(SESSION, '10:00:00'), bid: 249.9, ask: 250.1 }));
    const { quotes: quoteResults } = await client(http).quotes({ symbol: 'AAPL', date: SESSION });

    expect(quoteResults[0]).toStrictEqual({ S: 'AAPL', t: at(SESSION, '10:00:00'), bx: 12, bp: 249.9, bs: 3, ax: 11, ap: 250.1, as: 2, z: 3 });
  });

  it('adjusts both bid and ask across a split', async () => {
    const beforeSplit = at('2020-08-28', '10:00:00');
    const http = new FakeHttpClient().reply(quotes({ ms: beforeSplit, bid: 400, ask: 404 }), splits({ date: '2020-08-31', from: 1, to: 4 }));

    const { quotes: quoteResults } = await client(http).quotes({ symbol: 'AAPL', from: beforeSplit, to: beforeSplit + 60_000, adjustForSplit: true });
    expect(quoteResults[0].bp).toBeCloseTo(100, 6);
    expect(quoteResults[0].ap).toBeCloseTo(101, 6);
  });
});

describe('snapshot', () => {
  it('says the market-hours table needs refreshing rather than reporting the market shut', async () => {
    // Frozen past the table rather than trusting that today is: refreshing the data file
    // is what the error tells an operator to do, and that must not turn this red.
    jest.spyOn(Date, 'now').mockReturnValue(easternClock.timestamp(easternClock.shiftDate(marketHoursCoverage.to, 30), '10:00:00'));
    try {
      const http = new FakeHttpClient();
      await expect(client(http).snapshot({ symbol: 'AAPL' })).rejects.toThrow(/market-hours table stops at 2024-12-31/);
      expect(http.requests).toHaveLength(0);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('asks for nothing when given no symbols', async () => {
    const http = new FakeHttpClient();
    expect((await client(http).snapshots({ symbols: [] })).snapshots).toStrictEqual([]);
    expect(http.requests).toHaveLength(0);
  });

  describe('during a session the table covers', () => {
    const during = at(SESSION, '10:00:00');

    beforeEach(() => {
      jest.spyOn(Date, 'now').mockReturnValue(during);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('stamps the day bar at Eastern midnight, the same base as the previous day bar', async () => {
      const http = new FakeHttpClient().reply({ status: 'OK', ticker: snapshot('AAPL', during) });
      const { snapshot: result } = await client(http).snapshot({ symbol: 'AAPL' });

      // A UTC day floor would put this on 2024-12-18, the previous trading day.
      expect(easternClock.date(result!.db.t)).toBe(SESSION);
      expect(easternClock.time(result!.db.t)).toBe('00:00:00');
      expect(easternClock.date(result!.pdb.t)).toBe('2024-12-18');
      expect(easternClock.time(result!.pdb.t)).toBe('00:00:00');
    });

    it('stamps the minute bar at the start of its minute', async () => {
      const http = new FakeHttpClient().reply({ status: 'OK', ticker: snapshot('AAPL', during + 42_000) });
      const { snapshot: result } = await client(http).snapshot({ symbol: 'AAPL' });

      expect(easternClock.time(result!.mb.t)).toBe('10:00:00');
    });

    it('has no snapshot for a symbol Polygon returned no ticker for', async () => {
      const http = new FakeHttpClient().reply({ status: 'OK' });
      expect((await client(http).snapshot({ symbol: 'NOSUCH' })).snapshot).toBeUndefined();
    });

    it('refuses a payload whose timestamp is missing rather than throwing a TypeError', async () => {
      // `BigInt(undefined)` throws bare; the sections are all present here, so only the
      // timestamp check catches it.
      const withoutUpdated = { ...(snapshot('AAPL', during) as Record<string, unknown>) };
      delete withoutUpdated['updated'];
      const http = new FakeHttpClient().reply({ status: 'OK', ticker: withoutUpdated });

      await expect(client(http).snapshot({ symbol: 'AAPL' })).rejects.toThrow(DataProviderError);
    });

    it('has no snapshot for a name that has not traded, whose sections are missing', async () => {
      const http = new FakeHttpClient().reply({ status: 'OK', ticker: { ticker: 'THIN', updated: during * 1_000_000 } });
      expect((await client(http).snapshot({ symbol: 'THIN' })).snapshot).toBeUndefined();
    });

    it('skips the tickers it cannot read rather than throwing on the batch', async () => {
      const http = new FakeHttpClient().reply({ status: 'OK', count: 2, tickers: [snapshot('AAPL', during), { ticker: 'THIN', updated: during * 1_000_000 }] });
      const { snapshots } = await client(http).snapshots({ symbols: ['AAPL', 'THIN'] });

      expect(snapshots.map((entry) => entry.S)).toStrictEqual(['AAPL']);
    });

    it('reports no snapshots when Polygon omits the list entirely', async () => {
      const http = new FakeHttpClient().reply({ status: 'OK', count: 0 });
      expect((await client(http).snapshots({ symbols: ['AAPL'] })).snapshots).toStrictEqual([]);
    });
  });
});

describe('tickers', () => {
  it('pages by the last ticker seen rather than by cursor', async () => {
    // A page only continues the walk when it comes back full, and Polygon's reference
    // page is 1000 — so anything smaller here would test the stop, not the paging.
    const http = new FakeHttpClient().reply(page(1000, 'A'), page(500, 'B'));

    const { tickers: result } = await client(http).tickers({ limit: 1500 });

    expect(result).toHaveLength(1500);
    expect(http.requests).toHaveLength(2);
    expect(http.requests[0].query['limit']).toBe('1000');
    expect(http.requests[1].query['ticker.gt']).toBe('A999');
    expect(http.requests[1].query['limit']).toBe('500');
  });

  it('says where to resume when it stops before the listing runs out', async () => {
    // There are more US tickers than one call walks, so this is an ordinary outcome —
    // and throwing would discard every page already paid for.
    // A full page at the limit: the caller has what it asked for, and there is more.
    const http = new FakeHttpClient().reply(page(1000, 'A'));
    const { tickers, resumeFrom } = await client(http).tickers({ limit: 1000 });

    expect(tickers).toHaveLength(1000);
    expect(resumeFrom).toBe('A999');
    expect(http.requests).toHaveLength(1);
  });

  it('resumes exactly after the ticker a previous call stopped at', async () => {
    const http = new FakeHttpClient().reply(page(2, 'B'));
    await client(http).tickers({ startAfter: 'A999', limit: 2 });

    expect(http.requests[0].query['ticker.gt']).toBe('A999');
    expect(http.requests[0].query['ticker.gte']).toBeUndefined();
  });

  it('stops as soon as a page comes back short', async () => {
    const http = new FakeHttpClient().reply(page(3, 'A'));
    const { tickers: result, resumeFrom } = await client(http).tickers({});

    expect(result.map((ticker) => ticker.ticker)).toStrictEqual(['A0', 'A1', 'A2']);
    expect(http.requests).toHaveLength(1);
    // A short page is the end of the listing, so there is nothing to resume from.
    expect(resumeFrom).toBeUndefined();
  });

  it('starts from a given ticker and stops at the limit', async () => {
    const http = new FakeHttpClient().reply(page(0, 'A'));
    await client(http).tickers({ startTicker: 'MSFT', limit: 10, type: 'CS', active: true });

    expect(http.lastRequest.query['ticker.gte']).toBe('MSFT');
    expect(http.lastRequest.query['limit']).toBe('10');
    expect(http.lastRequest.query['type']).toBe('CS');
    expect(http.lastRequest.query['active']).toBe('true');
  });
});

describe('tickerDetails', () => {
  it('has nothing for a symbol Polygon does not know, whether it says null or says nothing', async () => {
    // Asked for a date before the ticker existed, Polygon omits `results` entirely.
    expect((await client(new FakeHttpClient().reply({ status: 'OK', results: null })).tickerDetails({ symbol: 'NOSUCH' })).details).toBeUndefined();
    expect((await client(new FakeHttpClient().reply({ status: 'OK' })).tickerDetails({ symbol: 'AAPL', date: '1990-01-01' })).details).toBeUndefined();
  });

  it('refuses an impossible as-of date, which Polygon answers with a 400', async () => {
    const http = new FakeHttpClient();
    await expect(client(http).tickerDetails({ symbol: 'AAPL', date: '2024-02-30' })).rejects.toThrow(InvalidRequestError);
    expect(http.requests).toHaveLength(0);
  });

  it('asks for the details as of a date when given one', async () => {
    const http = new FakeHttpClient().reply({ status: 'OK', results: null });
    await client(http).tickerDetails({ symbol: 'AAPL', date: SESSION });

    expect(http.lastRequest.url).toBe('/v3/reference/tickers/AAPL');
    expect(http.lastRequest.query['date']).toBe(SESSION);
  });
});

describe('stockSplits and dividends', () => {
  it('follows next_url as given, keeping every filter Polygon put in it', async () => {
    const nextUrl = 'https://api.polygon.io/v3/reference/splits?ticker=AAPL&order=asc&cursor=abc123&limit=500';
    const withCursor = { ...(splits({ date: '2020-08-31', from: 1, to: 4 }) as object), next_url: nextUrl };
    const http = new FakeHttpClient().reply(withCursor, splits({ date: '2014-06-09', from: 1, to: 7 }));

    const { splits: result } = await client(http).stockSplits({ symbol: 'AAPL' });

    expect(result.map((split) => split.executionDate)).toStrictEqual(['2020-08-31', '2014-06-09']);
    // The whole URL, not a request rebuilt from its cursor: rebuilding drops `ticker`,
    // and a page of every issuer's splits would look exactly like this symbol's.
    expect(http.requests[1].url).toBe(nextUrl);
    expect(http.requests[1].query['apiKey']).toBe('test-key');
  });

  it('reports no splits rather than throwing when Polygon omits results', async () => {
    const http = new FakeHttpClient().reply({ status: 'OK' });
    expect((await client(http).stockSplits({ symbol: 'BRK.A' })).splits).toStrictEqual([]);
  });

  it('refuses an impossible date rather than reporting a 400 from Polygon as a provider failure', async () => {
    // These two endpoints consult no market-hours table, so nothing else here looks at
    // their dates. Unchecked, 2024-02-30 goes to Polygon and the 400 comes back to the
    // caller as a `DataProviderError` — the provider blamed for a typo.
    const http = new FakeHttpClient();
    const polygon = client(http);

    await expect(polygon.dividends({ symbol: 'AAPL', dateType: 'ex_dividend_date', fromDate: '2024-02-30', toDate: '2024-12-31' })).rejects.toThrow(InvalidRequestError);
    await expect(polygon.dividends({ symbol: 'AAPL', dateType: 'ex_dividend_date', fromDate: '2024-01-01', toDate: '2023-02-29' })).rejects.toThrow(
      /real ISO YYYY-MM-DD calendar date/,
    );
    await expect(polygon.stockSplits({ symbol: 'AAPL', executionDate: '2026-13-01' })).rejects.toThrow(InvalidRequestError);
    expect(http.requests).toHaveLength(0);
  });

  it('puts the date range on the field the caller chose', async () => {
    const http = new FakeHttpClient().reply({ status: 'OK', results: [] });
    await client(http).dividends({ symbol: 'AAPL', dateType: 'ex_dividend_date', fromDate: '2024-01-01', toDate: '2024-12-31' });

    expect(http.lastRequest.query['ex_dividend_date.gte']).toBe('2024-01-01');
    expect(http.lastRequest.query['ex_dividend_date.lte']).toBe('2024-12-31');
  });

  it('states a dividend frequency as a schedule', async () => {
    const http = new FakeHttpClient().reply({
      status: 'OK',
      results: [
        {
          cash_amount: 0.25,
          currency: 'USD',
          dividend_type: 'CD',
          ticker: 'AAPL',
          frequency: 4,
          declaration_date: '2024-11-01',
          ex_dividend_date: '2024-11-08',
          record_date: '2024-11-11',
          pay_date: '2024-11-14',
        },
      ],
    });

    const { dividends: dividendResults } = await client(http).dividends({ symbol: 'AAPL', dateType: 'ex_dividend_date', fromDate: '2024-01-01', toDate: '2024-12-31' });
    expect(dividendResults[0]).toStrictEqual({
      ticker: 'AAPL',
      cashAmount: 0.25,
      currency: 'USD',
      dividendType: 'CD',
      frequency: 'quarterly',
      declarationDate: '2024-11-01',
      exDividendDate: '2024-11-08',
      recordDate: '2024-11-11',
      payDate: '2024-11-14',
    });
  });

  it('keeps a dividend whose type or frequency Polygon has newly invented', async () => {
    const http = new FakeHttpClient().reply({
      status: 'OK',
      results: [{ cash_amount: 1, currency: 'USD', dividend_type: 'XX', ticker: 'AAPL', frequency: 3, declaration_date: '', ex_dividend_date: '', record_date: '', pay_date: '' }],
    });

    const { dividends: dividendResults } = await client(http).dividends({ symbol: 'AAPL', dateType: 'pay_date', fromDate: '2024-01-01', toDate: '2024-12-31' });
    expect(dividendResults[0].dividendType).toBe('SC');
    expect(dividendResults[0].frequency).toBe('one-time');
  });
});

describe('historicalBars', () => {
  it('walks back over trading days, skipping the weekend', async () => {
    const http = new FakeHttpClient().reply(aggregates({ t: at(SESSION, '10:00:00') }));
    const { days } = await client(http).historicalBars({ symbol: 'AAPL', endDate: '2024-12-23', days: 3, marketHoursOnly: false });

    expect([...days.keys()]).toStrictEqual(['2024-12-23', '2024-12-20', '2024-12-19']);
  });

  it('refuses an end date past the market-hours table', async () => {
    const send = client(new FakeHttpClient()).historicalBars({ symbol: 'AAPL', endDate: easternClock.shiftDate(marketHoursCoverage.to, 1), days: 1 });
    await expect(send).rejects.toThrow(/market-hours table stops/);
  });

  it('stops at the start of the table instead of looping forever', async () => {
    const http = new FakeHttpClient().reply(aggregates());
    const send = client(http).historicalBars({ symbol: 'AAPL', endDate: '2001-01-05', days: 10, marketHoursOnly: false });

    await expect(send).rejects.toThrow(/are in the market-hours table, which starts at 2001-01-02/);
  });
});
