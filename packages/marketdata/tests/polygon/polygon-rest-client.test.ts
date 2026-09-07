import { easternClock, InvalidRequestError } from '@fleece/shared';

import { DataProviderError } from '../../src/equity-data-models';
import { marketHoursCoverage } from '../../src/market-hours';
import { PolygonRestClient } from '../../src/polygon';

import { aggregates, FakeHttpClient, quotes, splits, trades } from './fake-http-client';

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

  it('refuses a body that is not a JSON object', async () => {
    const http = new FakeHttpClient().reply('<html>maintenance</html>');
    await expect(client(http).bars({ symbol: 'AAPL', from: SESSION, to: SESSION, multiplier: 1, timespan: 'day' })).rejects.toThrow(/not a JSON object/);
  });
});

describe('bars', () => {
  it('asks for one daily range and normalises the result', async () => {
    const http = new FakeHttpClient().reply(aggregates({ t: at(SESSION, '09:30:00'), c: 250.5 }));
    const bars = await client(http).bars({ symbol: 'AAPL', from: '2024-12-16', to: SESSION, multiplier: 1, timespan: 'day' });

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

    const [, from, to] = http.lastRequest.url.split('/day/')[1].split('/').concat(['']);
    expect(Number(http.lastRequest.url.split('/day/')[1].split('/')[0])).toBe(Date.parse('2024-12-19T05:00:00Z'));
    expect(from ?? to).toBeDefined();
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

    const bars = await client(http).bars({ symbol: 'AAPL', from: SESSION, to: SESSION, multiplier: 1, timespan: 'minute' });
    expect(bars.map((bar) => bar.t)).toStrictEqual([open]);
  });

  it('keeps the extended session when asked explicitly', async () => {
    const http = new FakeHttpClient().reply(aggregates({ t: at(SESSION, '08:00:00') }, { t: at(SESSION, '10:30:00') }));
    const bars = await client(http).bars({ symbol: 'AAPL', from: SESSION, to: SESSION, multiplier: 1, timespan: 'minute', marketHoursOnly: false });

    expect(bars).toHaveLength(2);
  });

  it('never filters a daily bar, which spans the whole session anyway', async () => {
    const http = new FakeHttpClient().reply(aggregates({ t: at(SESSION, '00:00:00') }));
    const bars = await client(http).bars({ symbol: 'AAPL', from: SESSION, to: SESSION, multiplier: 1, timespan: 'day' });

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

    await expect(send).rejects.toThrow(DataProviderError);
    await expect(send).rejects.toThrow(/market-hours table stops at 2024-12-31/);
  });

  it('returns nothing for a symbol Polygon has no aggregates for', async () => {
    const http = new FakeHttpClient().reply({ status: 'OK', resultsCount: 0 });
    expect(await client(http).bars({ symbol: 'NOSUCH', from: SESSION, to: SESSION, multiplier: 1, timespan: 'day' })).toStrictEqual([]);
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
    const result = await client(http).trades({ symbol: 'AAPL', date: SESSION });

    expect(http.lastRequest.url).toBe('/v3/trades/AAPL');
    expect(http.lastRequest.query['timestamp.gte']).toBe(String(BigInt(at(SESSION, '04:00:00')) * BigInt(1_000_000)));
    expect(http.lastRequest.query['timestamp.lt']).toBe(String(BigInt(at(SESSION, '20:00:00')) * BigInt(1_000_000)));
    expect(result).toStrictEqual([{ S: 'AAPL', t: at(SESSION, '09:30:01'), s: 10, c: [12], p: 250, i: 't0', x: 4, z: 3 }]);
  });

  it('has nothing for a day the market was shut', async () => {
    const http = new FakeHttpClient();
    expect(await client(http).trades({ symbol: 'AAPL', date: '2024-12-25' })).toStrictEqual([]);
    expect(http.requests).toHaveLength(0);
  });

  it('pages from just before the last trade seen, and stops on a short page', async () => {
    const first = trades({ ms: at(SESSION, '10:00:00'), price: 1 }, { ms: at(SESSION, '10:00:01'), price: 2 });
    const second = trades({ ms: at(SESSION, '10:00:02'), price: 3 });
    const http = new FakeHttpClient().reply(first, second);

    const result = await client(http).trades({ symbol: 'AAPL', date: SESSION, itemsPerRequest: 2 });

    expect(result.map((trade) => trade.p)).toStrictEqual([1, 2, 3]);
    expect(http.requests).toHaveLength(2);
    // Behind the last timestamp by more than a double's rounding error at that magnitude.
    expect(http.requests[1].query['timestamp.gte']).toBe(String(BigInt(at(SESSION, '10:00:01')) * BigInt(1_000_000) - BigInt(1024)));
  });

  it('drops the trades the backoff re-reads rather than returning them twice', async () => {
    const boundary = { ms: at(SESSION, '10:00:01'), price: 2 };
    const http = new FakeHttpClient().reply(trades({ ms: at(SESSION, '10:00:00'), price: 1 }, boundary), trades(boundary, { ms: at(SESSION, '10:00:02'), price: 3 }));

    const result = await client(http).trades({ symbol: 'AAPL', date: SESSION, itemsPerRequest: 2 });
    expect(result.map((trade) => trade.p)).toStrictEqual([1, 2, 3]);
  });

  it('stops when a page is nothing but trades it has already read', async () => {
    const repeated = trades({ ms: at(SESSION, '10:00:00'), price: 1 }, { ms: at(SESSION, '10:00:01'), price: 2 });
    const http = new FakeHttpClient().reply(repeated);

    const result = await client(http).trades({ symbol: 'AAPL', date: SESSION, itemsPerRequest: 2 });
    expect(result).toHaveLength(2);
    expect(http.requests).toHaveLength(2);
  });

  it('refuses a window that crosses an Eastern day boundary', async () => {
    const send = client(new FakeHttpClient()).trades({ symbol: 'AAPL', from: at(SESSION, '19:00:00'), to: at('2024-12-20', '10:00:00') });
    await expect(send).rejects.toThrow(/must stay inside one Eastern day/);
  });

  it('refuses a window that ends before it starts, and one with no start at all', async () => {
    const polygon = client(new FakeHttpClient());
    await expect(polygon.trades({ symbol: 'AAPL', from: at(SESSION, '11:00:00'), to: at(SESSION, '10:00:00') })).rejects.toThrow(/must start before it ends/);
    await expect(polygon.trades({ symbol: 'AAPL' })).rejects.toThrow(/needs either a date or a from timestamp/);
  });

  it('adjusts a price recorded before a split, and leaves a later one alone', async () => {
    const beforeSplit = at('2020-08-28', '10:00:00');
    const http = new FakeHttpClient().reply(trades({ ms: beforeSplit, price: 499.23 }), splits({ date: '2020-08-31', from: 1, to: 4 }));

    const [trade] = await client(http).trades({ symbol: 'AAPL', from: beforeSplit, to: beforeSplit + 60_000, adjustForSplit: true });
    expect(trade.p).toBeCloseTo(124.8075, 4);
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
    const [quote] = await client(http).quotes({ symbol: 'AAPL', date: SESSION });

    expect(quote).toStrictEqual({ S: 'AAPL', t: at(SESSION, '10:00:00'), bx: 12, bp: 249.9, bs: 3, ax: 11, ap: 250.1, as: 2, z: 3 });
  });

  it('adjusts both bid and ask across a split', async () => {
    const beforeSplit = at('2020-08-28', '10:00:00');
    const http = new FakeHttpClient().reply(quotes({ ms: beforeSplit, bid: 400, ask: 404 }), splits({ date: '2020-08-31', from: 1, to: 4 }));

    const [quote] = await client(http).quotes({ symbol: 'AAPL', from: beforeSplit, to: beforeSplit + 60_000, adjustForSplit: true });
    expect(quote.bp).toBeCloseTo(100, 6);
    expect(quote.ap).toBeCloseTo(101, 6);
  });
});

describe('snapshot', () => {
  it('says the market-hours table needs refreshing rather than reporting the market shut', async () => {
    // Today is past the table's coverage, which is the state this repo is in.
    const send = client(new FakeHttpClient()).snapshot({ symbol: 'AAPL' });
    await expect(send).rejects.toThrow(/market-hours table stops at 2024-12-31/);
  });

  it('asks for nothing when given no symbols', async () => {
    const http = new FakeHttpClient();
    expect(await client(http).snapshots({ symbols: [] })).toStrictEqual([]);
    expect(http.requests).toHaveLength(0);
  });
});

describe('tickers', () => {
  it('pages by the last ticker seen rather than by cursor', async () => {
    // A page only continues the walk when it comes back full, and Polygon's reference
    // page is 1000 — so anything smaller here would test the stop, not the paging.
    const http = new FakeHttpClient().reply(page(1000, 'A'), page(500, 'B'));

    const result = await client(http).tickers({ limit: 1500 });

    expect(result).toHaveLength(1500);
    expect(http.requests).toHaveLength(2);
    expect(http.requests[0].query['limit']).toBe('1000');
    expect(http.requests[1].query['ticker.gt']).toBe('A999');
    expect(http.requests[1].query['limit']).toBe('500');
  });

  it('stops as soon as a page comes back short', async () => {
    const http = new FakeHttpClient().reply(page(3, 'A'));
    const result = await client(http).tickers({});

    expect(result.map((ticker) => ticker.ticker)).toStrictEqual(['A0', 'A1', 'A2']);
    expect(http.requests).toHaveLength(1);
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
  it('has nothing for a symbol Polygon does not know', async () => {
    const http = new FakeHttpClient().reply({ status: 'OK', results: null });
    expect(await client(http).tickerDetails({ symbol: 'NOSUCH' })).toBeUndefined();
  });

  it('asks for the details as of a date when given one', async () => {
    const http = new FakeHttpClient().reply({ status: 'OK', results: null });
    await client(http).tickerDetails({ symbol: 'AAPL', date: SESSION });

    expect(http.lastRequest.url).toBe('/v3/reference/tickers/AAPL');
    expect(http.lastRequest.query['date']).toBe(SESSION);
  });
});

describe('stockSplits and dividends', () => {
  it('follows next_url by its cursor parameter, whatever its position', async () => {
    const withCursor = { ...(splits({ date: '2020-08-31', from: 1, to: 4 }) as object), next_url: 'https://api.polygon.io/v3/reference/splits?order=asc&cursor=abc123&limit=500' };
    const http = new FakeHttpClient().reply(withCursor, splits({ date: '2014-06-09', from: 1, to: 7 }));

    const result = await client(http).stockSplits({ symbol: 'AAPL' });

    expect(result.map((split) => split.executionDate)).toStrictEqual(['2020-08-31', '2014-06-09']);
    expect(http.requests[1].query['cursor']).toBe('abc123');
  });

  it('refuses a next_url with no cursor rather than looping', async () => {
    const http = new FakeHttpClient().reply({ status: 'OK', results: [], next_url: 'https://api.polygon.io/v3/reference/splits?order=asc' });
    await expect(client(http).stockSplits({ symbol: 'AAPL' })).rejects.toThrow(/next_url with no cursor/);
  });

  it('reports no splits rather than throwing when Polygon omits results', async () => {
    const http = new FakeHttpClient().reply({ status: 'OK' });
    expect(await client(http).stockSplits({ symbol: 'BRK.A' })).toStrictEqual([]);
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

    const [dividend] = await client(http).dividends({ symbol: 'AAPL', dateType: 'ex_dividend_date', fromDate: '2024-01-01', toDate: '2024-12-31' });
    expect(dividend).toStrictEqual({
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

    const [dividend] = await client(http).dividends({ symbol: 'AAPL', dateType: 'pay_date', fromDate: '2024-01-01', toDate: '2024-12-31' });
    expect(dividend.dividendType).toBe('SC');
    expect(dividend.frequency).toBe('one-time');
  });
});

describe('historicalBars', () => {
  it('walks back over trading days, skipping the weekend', async () => {
    const http = new FakeHttpClient().reply(aggregates({ t: at(SESSION, '10:00:00') }));
    const days = await client(http).historicalBars({ symbol: 'AAPL', endDate: '2024-12-23', days: 3, marketHoursOnly: false });

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
