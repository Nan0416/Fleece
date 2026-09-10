import { easternClock, InternalServiceError, InvalidRequestError } from '@fleece/utilities';

import { AlpacaMarketDataClient, ALPACA_TRADING_LIVE_URL, ALPACA_TRADING_PAPER_URL } from '../../src/alpaca';
import { DataProviderError } from '../../src/data-models';
import { marketHoursCoverage } from '../../src/market-hours';
import { FakeHttpClient } from '../fake-http-client';

import { bars, calendar, conditionDictionary, corporateActions, optionBars, optionContracts, optionSnapshots, optionTrades, quotes, trades, withPageToken } from './fake-responses';

const SESSION = '2024-12-19';
const at = (date: string, time: string): number => easternClock.timestamp(date, time);
const utc = (iso: string): string => iso;

function client(http: FakeHttpClient): AlpacaMarketDataClient {
  return new AlpacaMarketDataClient({ apiKey: 'key', secretKey: 'secret', httpClient: http });
}

describe('every request', () => {
  it('authenticates with the key and secret in headers, not the query', async () => {
    const http = new FakeHttpClient().reply(bars('AAPL'));
    await client(http).dailyBars({ symbol: 'AAPL', from: SESSION, to: SESSION });

    // Unlike Polygon's key, which rides in the query string and has to be redacted.
    expect(http.lastRequest.query['apiKey']).toBeUndefined();
    expect(http.lastRequest.query['secret']).toBeUndefined();
  });

  it('asks for the consolidated tape by default', async () => {
    const http = new FakeHttpClient().reply(bars('AAPL'));
    await client(http).dailyBars({ symbol: 'AAPL', from: SESSION, to: SESSION });

    expect(http.lastRequest.query['feed']).toBe('sip');
  });

  it('takes a cheaper feed when one is asked for', async () => {
    const http = new FakeHttpClient().reply(bars('AAPL'));
    await new AlpacaMarketDataClient({ apiKey: 'key', secretKey: 'secret', feed: 'iex', httpClient: http }).dailyBars({ symbol: 'AAPL', from: SESSION, to: SESSION });

    expect(http.lastRequest.query['feed']).toBe('iex');
  });

  it('reports a non-200 as a provider error naming the status', async () => {
    const http = new FakeHttpClient().replyWithStatus(403, { message: 'subscription does not permit querying recent sip data' });
    const send = client(http).dailyBars({ symbol: 'AAPL', from: SESSION, to: SESSION });

    await expect(send).rejects.toThrow(DataProviderError);
    await expect(send).rejects.toThrow(/returned 403/);
  });

  it('reports a failure with an empty body as a provider error, not a TypeError', async () => {
    const http = new FakeHttpClient().replyWithStatus(502, undefined);
    await expect(client(http).dailyBars({ symbol: 'AAPL', from: SESSION, to: SESSION })).rejects.toThrow(/returned 502/);
  });
});

describe('bars', () => {
  it('asks for the timeframe as a multiplier and a unit', async () => {
    const http = new FakeHttpClient().reply(bars('AAPL'));
    const alpaca = client(http);

    await alpaca.bars({ symbol: 'AAPL', from: SESSION, to: SESSION, multiplier: 5, timespan: 'minute', marketHoursOnly: false });
    expect(http.lastRequest.query['timeframe']).toBe('5Min');

    await alpaca.bars({ symbol: 'AAPL', from: SESSION, to: SESSION, multiplier: 1, timespan: 'day' });
    expect(http.lastRequest.query['timeframe']).toBe('1Day');
  });

  it('refuses a timeframe Alpaca does not aggregate, naming what it takes', async () => {
    const alpaca = client(new FakeHttpClient().reply(bars('AAPL')));

    await expect(alpaca.bars({ symbol: 'AAPL', from: SESSION, to: SESSION, multiplier: 1, timespan: 'quarter' })).rejects.toThrow(/does not aggregate by quarter/);
    await expect(alpaca.bars({ symbol: 'AAPL', from: SESSION, to: SESSION, multiplier: 2, timespan: 'day' })).rejects.toThrow(/takes only 1 for a day timeframe/);
    await expect(alpaca.bars({ symbol: 'AAPL', from: SESSION, to: SESSION, multiplier: 90, timespan: 'minute' })).rejects.toThrow(/takes 1 to 59 for a minute timeframe/);
  });

  it('asks for split-adjusted prices only when told to', async () => {
    const http = new FakeHttpClient().reply(bars('AAPL'));
    const alpaca = client(http);

    await alpaca.dailyBars({ symbol: 'AAPL', from: SESSION, to: SESSION });
    expect(http.lastRequest.query['adjustment']).toBe('raw');

    await alpaca.dailyBars({ symbol: 'AAPL', from: SESSION, to: SESSION, adjustForSplit: true });
    expect(http.lastRequest.query['adjustment']).toBe('split');
  });

  it('reads a date as the whole Eastern day', async () => {
    const http = new FakeHttpClient().reply(bars('AAPL'));
    await client(http).dailyBars({ symbol: 'AAPL', from: SESSION, to: SESSION });

    expect(http.lastRequest.query['start']).toBe('2024-12-19T05:00:00.000Z');
    expect(http.lastRequest.query['end']).toBe('2024-12-20T04:59:59.000Z');
  });

  it('parses an RFC 3339 timestamp with nanoseconds, which is what Alpaca sends', async () => {
    const http = new FakeHttpClient().reply(bars('AAPL', { t: utc('2024-12-19T14:30:00.000052256Z'), c: 250.5 }));
    const { bars: result } = await client(http).minuteBars({ symbol: 'AAPL', from: SESSION, to: SESSION });

    expect(result).toStrictEqual([{ S: 'AAPL', o: 1, h: 3, l: 0.5, c: 250.5, v: 100, t: at(SESSION, '09:30:00') }]);
  });

  it('keeps only bars inside regular hours by default', async () => {
    const http = new FakeHttpClient().reply(bars('AAPL', { t: utc('2024-12-19T13:00:00Z') }, { t: utc('2024-12-19T15:30:00Z') }, { t: utc('2024-12-19T22:00:00Z') }));
    const { bars: result } = await client(http).minuteBars({ symbol: 'AAPL', from: SESSION, to: SESSION });

    expect(result.map((bar) => easternClock.time(bar.t))).toStrictEqual(['10:30:00']);
  });

  it('keeps the extended session when asked explicitly', async () => {
    const http = new FakeHttpClient().reply(bars('AAPL', { t: utc('2024-12-19T13:00:00Z') }, { t: utc('2024-12-19T15:30:00Z') }));
    const { bars: result } = await client(http).minuteBars({ symbol: 'AAPL', from: SESSION, to: SESSION, marketHoursOnly: false });

    expect(result).toHaveLength(2);
  });

  // Quarter and year are Polygon's; Alpaca refuses them, which its own test covers.
  it.each(['day', 'week', 'month'] as const)('never filters a %s bar, which spans whole sessions anyway', async (timespan) => {
    // A weekly bar is stamped at the start of its week, which is not a moment the market
    // is open — filtering by regular hours emptied every one of them.
    const http = new FakeHttpClient().reply(bars('AAPL', { t: utc('2024-12-15T05:00:00Z') }));
    const { bars: result } = await client(http).bars({ symbol: 'AAPL', from: '2024-12-01', to: SESSION, multiplier: 1, timespan });

    expect(result).toHaveLength(1);
  });

  it.each(['day', 'week', 'month'] as const)('does not consult the market-hours table for a %s bar', async (timespan) => {
    // The table stops in 2024, and a bar spanning whole sessions never needed it.
    const beyond = easternClock.shiftDate(marketHoursCoverage.to, 30);
    const http = new FakeHttpClient().reply(bars('AAPL', { t: utc('2026-01-05T05:00:00Z') }));
    const { bars: result } = await client(http).bars({ symbol: 'AAPL', from: beyond, to: easternClock.shiftDate(beyond, 60), multiplier: 1, timespan });

    expect(result).toHaveLength(1);
  });

  it('says the market-hours table needs refreshing rather than filtering every bar away', async () => {
    const past = easternClock.shiftDate(marketHoursCoverage.to, 30);
    const http = new FakeHttpClient();
    const send = client(http).minuteBars({ symbol: 'AAPL', from: past, to: past });

    await expect(send).rejects.toThrow(InternalServiceError);
    expect(http.requests).toHaveLength(0);
  });

  it('has nothing for a symbol Alpaca does not know, which it omits from the map', async () => {
    const http = new FakeHttpClient().reply({ bars: {} });
    expect((await client(http).dailyBars({ symbol: 'NOSUCH', from: SESSION, to: SESSION })).bars).toStrictEqual([]);
  });

  it('refuses a range that ends before it starts, and a date that does not exist', async () => {
    const alpaca = client(new FakeHttpClient());
    await expect(alpaca.dailyBars({ symbol: 'AAPL', from: '2024-12-20', to: SESSION })).rejects.toThrow(/must start before it ends/);
    await expect(alpaca.dailyBars({ symbol: 'AAPL', from: '2024-02-30', to: SESSION })).rejects.toThrow(InvalidRequestError);
  });
});

describe('paging', () => {
  it('follows the page token until Alpaca stops sending one', async () => {
    const http = new FakeHttpClient().reply(
      withPageToken(trades('AAPL', { t: utc('2024-12-19T15:00:00Z'), p: 1 }), 'token-2'),
      withPageToken(trades('AAPL', { t: utc('2024-12-19T15:00:01Z'), p: 2 }), null),
    );
    const { trades: result } = await client(http).trades({ symbol: 'AAPL', date: SESSION });

    expect(result.map((trade) => trade.p)).toStrictEqual([1, 2]);
    expect(http.requests).toHaveLength(2);
    expect(http.requests[0].query['page_token']).toBeUndefined();
    expect(http.requests[1].query['page_token']).toBe('token-2');
  });

  it('treats an empty page token as the end, like an absent one', async () => {
    const http = new FakeHttpClient().reply(withPageToken(trades('AAPL', { t: utc('2024-12-19T15:00:00Z'), p: 1 }), ''));
    const { trades: result } = await client(http).trades({ symbol: 'AAPL', date: SESSION });

    expect(result).toHaveLength(1);
    expect(http.requests).toHaveLength(1);
  });

  it('clamps a page size above what Alpaca will serve', async () => {
    const http = new FakeHttpClient().reply(trades('AAPL'));
    await client(http).trades({ symbol: 'AAPL', date: SESSION, itemsPerRequest: 100_000 });

    expect(http.lastRequest.query['limit']).toBe('10000');
  });

  it('refuses a page size of zero or less', async () => {
    const alpaca = client(new FakeHttpClient());
    await expect(alpaca.trades({ symbol: 'AAPL', date: SESSION, itemsPerRequest: 0 })).rejects.toThrow(/at least one item per request/);
  });
});

describe('trades and quotes', () => {
  it('covers a trading day from pre-market open to after-hours close', async () => {
    const http = new FakeHttpClient().reply(trades('AAPL', { t: utc('2024-12-19T15:00:00Z'), p: 250 }));
    const { trades: result } = await client(http).trades({ symbol: 'AAPL', date: SESSION });

    expect(http.lastRequest.query['start']).toBe(new Date(at(SESSION, '04:00:00')).toISOString());
    expect(http.lastRequest.query['end']).toBe(new Date(at(SESSION, '20:00:00')).toISOString());
    expect(result).toStrictEqual([{ S: 'AAPL', i: 0, x: 'Q', p: 250, s: 10, t: at(SESSION, '10:00:00'), c: ['@'], z: 'C' }]);
  });

  it('has nothing for a day the market was shut', async () => {
    const http = new FakeHttpClient();
    expect((await client(http).trades({ symbol: 'AAPL', date: '2024-12-25' })).trades).toStrictEqual([]);
    expect(http.requests).toHaveLength(0);
  });

  it('allows a window spanning two days, which Polygon cannot', async () => {
    // Alpaca pages by an opaque token, so nothing about a day boundary truncates a walk.
    const http = new FakeHttpClient().reply(trades('AAPL', { t: utc('2024-12-19T20:00:00Z'), p: 1 }));
    const { trades: result } = await client(http).trades({ symbol: 'AAPL', from: at(SESSION, '19:00:00'), to: at('2024-12-20', '10:00:00') });

    expect(result).toHaveLength(1);
  });

  it('normalises both sides of the book', async () => {
    const http = new FakeHttpClient().reply(quotes('AAPL', { t: utc('2024-12-19T15:00:00Z'), bid: 249.9, ask: 250.1 }));
    const { quotes: result } = await client(http).quotes({ symbol: 'AAPL', date: SESSION });

    expect(result).toStrictEqual([{ S: 'AAPL', bx: 'U', bp: 249.9, bs: 3, ax: 'Q', ap: 250.1, as: 2, t: at(SESSION, '10:00:00'), c: ['R'], z: 'C' }]);
  });

  it('restates a price recorded before a split when asked, and leaves a later one alone', async () => {
    // Alpaca's trade endpoint refuses an `adjustment` parameter, so this is arithmetic
    // done here — and it used to be dropped, returning raw prints as though adjusted.
    const http = new FakeHttpClient().reply(trades('AAPL', { t: utc('2020-08-28T14:00:00Z'), p: 503.5 }), corporateActions({ forward: [{ date: '2020-08-31', from: 1, to: 4 }] }));
    const { trades: result } = await client(http).trades({
      symbol: 'AAPL',
      from: Date.parse('2020-08-28T14:00:00Z'),
      to: Date.parse('2020-08-28T14:00:01Z'),
      adjustForSplit: true,
    });

    expect(result[0].p).toBeCloseTo(125.875, 4);
  });

  it('restates both sides of a quote across a split', async () => {
    const http = new FakeHttpClient().reply(
      quotes('AAPL', { t: utc('2020-08-28T14:00:00Z'), bid: 400, ask: 404 }),
      corporateActions({ forward: [{ date: '2020-08-31', from: 1, to: 4 }] }),
    );
    const { quotes: result } = await client(http).quotes({
      symbol: 'AAPL',
      from: Date.parse('2020-08-28T14:00:00Z'),
      to: Date.parse('2020-08-28T14:00:01Z'),
      adjustForSplit: true,
    });

    expect(result[0].bp).toBeCloseTo(100, 6);
    expect(result[0].ap).toBeCloseTo(101, 6);
  });

  it('does not ask for splits when no adjustment was requested', async () => {
    const http = new FakeHttpClient().reply(trades('AAPL', { t: utc('2024-12-19T15:00:00Z'), p: 250 }));
    const { trades: result } = await client(http).trades({ symbol: 'AAPL', date: SESSION });

    expect(result[0].p).toBe(250);
    expect(http.requests.map((request) => request.url)).toStrictEqual(['/v2/stocks/trades']);
  });

  it('refuses a timestamp it cannot read rather than dating a trade to NaN', async () => {
    const http = new FakeHttpClient().reply({ trades: { AAPL: [{ t: 'yesterday', x: 'Q', p: 1, s: 1, i: 1, z: 'C' }] } });
    const send = client(http).trades({ symbol: 'AAPL', date: SESSION });

    await expect(send).rejects.toThrow(DataProviderError);
    await expect(send).rejects.toThrow(/RFC 3339 timestamp/);
  });
});

describe('stockSplits', () => {
  it('returns forward and reverse splits as one list, oldest first', async () => {
    // The endpoint keys them separately and the only difference is which way the rates
    // run, which is not a distinction the caller makes.
    const http = new FakeHttpClient().reply(corporateActions({ forward: [{ date: '2020-08-31', from: 1, to: 4 }], reverse: [{ date: '2016-05-02', from: 8, to: 1 }] }));
    const { splits } = await client(http).stockSplits({ symbol: 'AAPL' });

    expect(splits).toStrictEqual([
      { ticker: 'AAPL', executionDate: '2016-05-02', splitFrom: 8, splitTo: 1 },
      { ticker: 'AAPL', executionDate: '2020-08-31', splitFrom: 1, splitTo: 4 },
    ]);
  });

  it('asks for a range, because with none Alpaca answers for today alone', async () => {
    const http = new FakeHttpClient().reply(corporateActions({}));
    await client(http).stockSplits({ symbol: 'AAPL' });

    expect(http.lastRequest.query['types']).toBe('forward_split,reverse_split');
    expect(http.lastRequest.query['start']).toBe('2000-01-01');
    // Ahead of today, because a split is announced before it happens.
    expect(http.lastRequest.query['end'] > easternClock.date()).toBe(true);
  });

  it('narrows to one execution date when given one', async () => {
    const http = new FakeHttpClient().reply(corporateActions({ forward: [{ date: '2020-08-31', from: 1, to: 4 }] }));
    await client(http).stockSplits({ symbol: 'AAPL', executionDate: '2020-08-31' });

    expect(http.lastRequest.query['start']).toBe('2020-08-31');
    expect(http.lastRequest.query['end']).toBe('2020-08-31');
  });

  it('refuses an execution date that is not a real calendar date', async () => {
    await expect(client(new FakeHttpClient()).stockSplits({ symbol: 'AAPL', executionDate: '2020-02-30' })).rejects.toThrow(InvalidRequestError);
  });

  it('reports no splits rather than throwing when a symbol has none', async () => {
    const http = new FakeHttpClient().reply({ corporate_actions: {} });
    expect((await client(http).stockSplits({ symbol: 'AAPL' })).splits).toStrictEqual([]);
  });

  it('follows the page token across pages', async () => {
    const http = new FakeHttpClient().reply(
      withPageToken(corporateActions({ forward: [{ date: '2016-06-01', from: 1, to: 2 }] }), 'page-2'),
      withPageToken(corporateActions({ forward: [{ date: '2020-08-31', from: 1, to: 4 }] }), null),
    );
    const { splits } = await client(http).stockSplits({ symbol: 'AAPL' });

    expect(splits.map((split) => split.executionDate)).toStrictEqual(['2016-06-01', '2020-08-31']);
    expect(http.requests[1].query['page_token']).toBe('page-2');
  });
});

describe('marketHours', () => {
  it('turns the calendar into sessions with instants on both boundaries', async () => {
    const http = new FakeHttpClient().reply(calendar({ date: '2024-12-23' }));
    const { sessions } = await client(http).marketHours({ fromDate: '2024-12-23', toDate: '2024-12-23' });

    expect(sessions).toStrictEqual([
      {
        date: '2024-12-23',
        open: '09:30',
        close: '16:00',
        openAt: at('2024-12-23', '09:30:00'),
        closeAt: at('2024-12-23', '16:00:00'),
        preMarketOpenAt: at('2024-12-23', '04:00:00'),
        afterMarketCloseAt: at('2024-12-23', '20:00:00'),
      },
    ]);
  });

  it('reads a half day, including the after-hours close no rule derives', async () => {
    // 2024-12-24 closes at 13:00 and its extended session ends at 17:00, not 20:00 —
    // which is the field the stored table could not have been computed from.
    const http = new FakeHttpClient().reply(calendar({ date: '2024-12-24', close: '13:00', sessionClose: '1700' }));
    const [session] = (await client(http).marketHours({ fromDate: '2024-12-24', toDate: '2024-12-24' })).sessions;

    expect(session.close).toBe('13:00');
    expect(easternClock.time(session.closeAt)).toBe('13:00:00');
    expect(easternClock.time(session.afterMarketCloseAt)).toBe('17:00:00');
  });

  it('asks for the range on the trading host, not the data one', async () => {
    const http = new FakeHttpClient().reply(calendar());
    await client(http).marketHours({ fromDate: '2024-12-23', toDate: '2024-12-27' });

    expect(http.lastRequest.url).toBe('/v2/calendar');
    expect(http.lastRequest.baseUrl).toBe(ALPACA_TRADING_PAPER_URL);
    expect(http.lastRequest.query['start']).toBe('2024-12-23');
    expect(http.lastRequest.query['end']).toBe('2024-12-27');
  });

  it('reads the calendar from paper by default, and from live when told to', async () => {
    // The calendar is the same on both, so paper is the safer default: a paper key never
    // reaches the live host, and a live key would be refused by paper.
    const paper = new FakeHttpClient().reply(calendar());
    await client(paper).marketHours({ fromDate: '2024-12-23', toDate: '2024-12-23' });
    expect(paper.lastRequest.baseUrl).toBe(ALPACA_TRADING_PAPER_URL);

    const live = new FakeHttpClient().reply(calendar());
    await new AlpacaMarketDataClient({ apiKey: 'key', secretKey: 'secret', tradingBaseUrl: ALPACA_TRADING_LIVE_URL, httpClient: live }).marketHours({
      fromDate: '2024-12-23',
      toDate: '2024-12-23',
    });
    expect(live.lastRequest.baseUrl).toBe(ALPACA_TRADING_LIVE_URL);
  });

  it('reads market data from the one host there is, paper or not', async () => {
    const http = new FakeHttpClient().reply(bars('AAPL'));
    await client(http).dailyBars({ symbol: 'AAPL', from: SESSION, to: SESSION });

    // No paper variant exists for market data; entitlement is the subscription's business.
    expect(http.lastRequest.baseUrl).toBeUndefined();
  });

  it('refuses a range that is backwards or not a real date', async () => {
    const alpaca = client(new FakeHttpClient());
    await expect(alpaca.marketHours({ fromDate: '2024-12-27', toDate: '2024-12-23' })).rejects.toThrow(/must start before it ends/);
    await expect(alpaca.marketHours({ fromDate: '2024-02-30', toDate: '2024-12-23' })).rejects.toThrow(InvalidRequestError);
  });

  it('refuses a calendar that is not a list of days', async () => {
    const http = new FakeHttpClient().reply({ message: 'nope' });
    await expect(client(http).marketHours({ fromDate: '2024-12-23', toDate: '2024-12-27' })).rejects.toThrow(/not a list of days/);
  });

  it('refuses a session time it cannot read', async () => {
    const http = new FakeHttpClient().reply([{ date: '2024-12-23', open: '09:30', close: '16:00', session_open: '4am', session_close: '2000' }]);
    await expect(client(http).marketHours({ fromDate: '2024-12-23', toDate: '2024-12-23' })).rejects.toThrow(/four-digit HHmm session time/);
  });
});

const CONTRACT = 'AAPL260918C00230000';
const PUT = 'AAPL260918P00230000';

describe('a contract listing', () => {
  it('asks the trading host, which is where contracts live and market data does not', async () => {
    const http = new FakeHttpClient().reply(optionContracts({ symbol: CONTRACT }));
    await client(http).listOptionContracts({ underlying: 'AAPL' });

    expect(http.lastRequest.url).toBe('/v2/options/contracts');
    expect(http.lastRequest.baseUrl).toBe(ALPACA_TRADING_PAPER_URL);
  });

  it('sends the filters under the names Alpaca reads', async () => {
    const http = new FakeHttpClient().reply(optionContracts({ symbol: CONTRACT }));
    await client(http).listOptionContracts({
      underlying: 'AAPL',
      status: 'inactive',
      root: 'AAPL1',
      type: 'call',
      style: 'american',
      expirationFrom: '2026-09-01',
      expirationTo: '2026-10-30',
      strikeFrom: 200,
      strikeTo: 260,
      withDeliverables: true,
    });

    expect(http.lastRequest.query).toMatchObject({
      underlying_symbols: 'AAPL',
      status: 'inactive',
      root_symbol: 'AAPL1',
      type: 'call',
      style: 'american',
      expiration_date_gte: '2026-09-01',
      expiration_date_lte: '2026-10-30',
      strike_price_gte: '200',
      strike_price_lte: '260',
      show_deliverables: 'true',
    });
  });

  it('lists active contracts when the request names no status, as Alpaca does', async () => {
    const http = new FakeHttpClient().reply(optionContracts({ symbol: CONTRACT }));
    await client(http).listOptionContracts({ underlying: 'AAPL' });

    expect(http.lastRequest.query['status']).toBe('active');
    expect(http.lastRequest.query['show_deliverables']).toBeUndefined();
  });

  it('asks for a full page by default, and caps one asked for above the maximum', async () => {
    const http = new FakeHttpClient().reply(optionContracts({ symbol: CONTRACT }));
    await client(http).listOptionContracts({ underlying: 'AAPL' });
    expect(http.lastRequest.query['limit']).toBe('10000');

    await client(http).listOptionContracts({ underlying: 'AAPL', limit: 50_000 });
    expect(http.lastRequest.query['limit']).toBe('10000');
  });

  it('refuses a listing with no underlying to list the contracts of', async () => {
    const http = new FakeHttpClient().reply(optionContracts({ symbol: CONTRACT }));
    await expect(client(http).listOptionContracts({ underlying: '  ' })).rejects.toThrow(InvalidRequestError);
  });

  it('reads a contract, leaving the symbol for the caller to take apart', async () => {
    const http = new FakeHttpClient().reply(optionContracts({ symbol: CONTRACT }));
    const { contracts } = await client(http).listOptionContracts({ underlying: 'AAPL' });

    expect(contracts).toEqual([
      {
        S: CONTRACT,
        f: 'a',
        status: 'active',
        tradable: true,
        style: 'american',
        multiplier: 100,
        size: 100,
        openInterest: 1234,
        openInterestDate: '2024-12-19',
        closePrice: 1.25,
        closePriceDate: '2024-12-19',
      },
    ]);
  });

  it('reads what an adjusted contract delivers, where the multiplier and the size disagree', async () => {
    const http = new FakeHttpClient().reply(
      optionContracts({
        symbol: CONTRACT,
        size: '75',
        deliverables: [
          {
            type: 'equity',
            symbol: 'AAPL',
            asset_id: 'b0b6dd9d',
            amount: '75',
            allocation_percentage: '75',
            settlement_type: 'T+1',
            settlement_method: 'BTOB',
            delayed_settlement: false,
          },
          { type: 'cash', amount: '2500', allocation_percentage: '25', settlement_type: 'T+1', settlement_method: 'CCC', delayed_settlement: false },
        ],
      }),
    );
    const { contracts } = await client(http).listOptionContracts({ underlying: 'AAPL', withDeliverables: true });

    expect(contracts[0].multiplier).toBe(100);
    expect(contracts[0].size).toBe(75);
    expect(contracts[0].deliverables).toEqual([
      { type: 'equity', symbol: 'AAPL', amount: 75, allocationPercentage: 75, settlementType: 'T+1', settlementMethod: 'BTOB' },
      { type: 'cash', amount: 2500, allocationPercentage: 25, settlementType: 'T+1', settlementMethod: 'CCC' },
    ]);
  });

  it('leaves out an open interest and a close Alpaca has none for', async () => {
    const http = new FakeHttpClient().reply(optionContracts({ symbol: CONTRACT, openInterest: null, closePrice: null }));
    const { contracts } = await client(http).listOptionContracts({ underlying: 'AAPL' });

    expect(contracts[0].openInterest).toBeUndefined();
    expect(contracts[0].closePrice).toBeUndefined();
  });

  it('reports a missing multiplier rather than reading it as NaN', async () => {
    const http = new FakeHttpClient().reply(optionContracts({ symbol: CONTRACT, multiplier: null }));
    await expect(client(http).listOptionContracts({ underlying: 'AAPL' })).rejects.toThrow(DataProviderError);
  });

  it('reports a status it does not recognise rather than carrying it through', async () => {
    const http = new FakeHttpClient().reply(optionContracts({ symbol: CONTRACT, status: 'expired' }));
    await expect(client(http).listOptionContracts({ underlying: 'AAPL' })).rejects.toThrow(/neither active nor inactive/);
  });

  it('reports a listing that is not a list', async () => {
    const http = new FakeHttpClient().reply({ option_contracts: { AAPL: [] } });
    await expect(client(http).listOptionContracts({ underlying: 'AAPL' })).rejects.toThrow(DataProviderError);
  });

  it('hands back a cursor rather than walking a listing of thousands itself', async () => {
    const http = new FakeHttpClient().reply(withPageToken(optionContracts({ symbol: CONTRACT }), 'QUFQTA=='));
    const { contracts, resumeFrom } = await client(http).listOptionContracts({ underlying: 'AAPL' });

    expect(contracts).toHaveLength(1);
    expect(resumeFrom).toBe('QUFQTA==');
    expect(http.requests).toHaveLength(1);
  });

  it('resumes from where a previous page stopped', async () => {
    const http = new FakeHttpClient().reply(optionContracts({ symbol: CONTRACT }));
    await client(http).listOptionContracts({ underlying: 'AAPL', status: 'inactive', startAfter: 'QUFQTA==' });

    expect(http.lastRequest.query['status']).toBe('inactive');
    expect(http.lastRequest.query['page_token']).toBe('QUFQTA==');
  });

  it.each([null, ''])('reports a %p page token as the end of the listing', async (token) => {
    const http = new FakeHttpClient().reply(withPageToken(optionContracts({ symbol: CONTRACT }), token));
    const { resumeFrom } = await client(http).listOptionContracts({ underlying: 'AAPL' });

    expect(resumeFrom).toBeUndefined();
  });
});

describe('an option chain', () => {
  it('asks for the underlying by path, since the endpoint is keyed by it rather than by symbols', async () => {
    const http = new FakeHttpClient().reply(optionSnapshots({ symbol: CONTRACT }));
    await client(http).optionChain({ underlying: 'AAPL' });

    expect(http.lastRequest.url).toBe('/v1beta1/options/snapshots/AAPL');
    expect(http.lastRequest.query['symbols']).toBeUndefined();
  });

  it('asks for the consolidated options tape by default', async () => {
    const http = new FakeHttpClient().reply(optionSnapshots({ symbol: CONTRACT }));
    await client(http).optionChain({ underlying: 'AAPL' });

    expect(http.lastRequest.query['feed']).toBe('opra');
  });

  it("takes Alpaca's synthetic quote when one is asked for", async () => {
    const http = new FakeHttpClient().reply(optionSnapshots({ symbol: CONTRACT }));
    await new AlpacaMarketDataClient({ apiKey: 'key', secretKey: 'secret', optionFeed: 'indicative', httpClient: http }).optionChain({ underlying: 'AAPL' });

    expect(http.lastRequest.query['feed']).toBe('indicative');
  });

  it('sends the expiration and strike filters under the names Alpaca reads', async () => {
    const http = new FakeHttpClient().reply(optionSnapshots({ symbol: CONTRACT }));
    await client(http).optionChain({ underlying: 'AAPL', type: 'call', expirationFrom: '2026-09-01', expirationTo: '2026-10-30', strikeFrom: 200, strikeTo: 260 });

    expect(http.lastRequest.query).toMatchObject({
      type: 'call',
      expiration_date_gte: '2026-09-01',
      expiration_date_lte: '2026-10-30',
      strike_price_gte: '200',
      strike_price_lte: '260',
    });
  });

  it('asks for a full page by default, and caps one asked for above the maximum', async () => {
    const http = new FakeHttpClient().reply(optionSnapshots({ symbol: CONTRACT }));
    await client(http).optionChain({ underlying: 'AAPL' });
    expect(http.lastRequest.query['limit']).toBe('1000');

    await client(http).optionChain({ underlying: 'AAPL', limit: 5000 });
    expect(http.lastRequest.query['limit']).toBe('1000');
  });

  it('takes apart every contract symbol, which is the only place a strike or an expiry appears', async () => {
    const http = new FakeHttpClient().reply(optionSnapshots({ symbol: CONTRACT }, { symbol: PUT }));
    const { contracts } = await client(http).optionChain({ underlying: 'AAPL' });

    expect(contracts.map((contract) => contract.contract)).toEqual([
      { symbol: CONTRACT, underlying: 'AAPL', root: 'AAPL', expiration: '2026-09-18', type: 'call', strike: 230, strikeMils: 230000 },
      { symbol: PUT, underlying: 'AAPL', root: 'AAPL', expiration: '2026-09-18', type: 'put', strike: 230, strikeMils: 230000 },
    ]);
  });

  it('keeps the order the chain paged in, which is what the cursor continues from', async () => {
    const http = new FakeHttpClient().reply(optionSnapshots({ symbol: PUT }, { symbol: CONTRACT }));
    const { contracts } = await client(http).optionChain({ underlying: 'AAPL' });

    expect(contracts.map((contract) => contract.S)).toEqual([PUT, CONTRACT]);
  });

  it('hands back a cursor rather than walking a chain of thousands itself', async () => {
    const http = new FakeHttpClient().reply(withPageToken(optionSnapshots({ symbol: CONTRACT }), 'QUFQTA=='));
    const { contracts, resumeFrom } = await client(http).optionChain({ underlying: 'AAPL' });

    expect(contracts).toHaveLength(1);
    expect(resumeFrom).toBe('QUFQTA==');
    expect(http.requests).toHaveLength(1);
  });

  it('resumes from where a previous page stopped', async () => {
    const http = new FakeHttpClient().reply(optionSnapshots({ symbol: CONTRACT }));
    await client(http).optionChain({ underlying: 'AAPL', startAfter: 'QUFQTA==' });

    expect(http.lastRequest.query['page_token']).toBe('QUFQTA==');
  });

  it.each([null, ''])('reports a %p page token as the end of the listing', async (token) => {
    const http = new FakeHttpClient().reply(withPageToken(optionSnapshots({ symbol: CONTRACT }), token));
    const { resumeFrom } = await client(http).optionChain({ underlying: 'AAPL' });

    expect(resumeFrom).toBeUndefined();
  });

  it('leaves a section Alpaca did not send absent rather than inventing one', async () => {
    // Around four contracts in ten of a large chain have no greeks, and a contract that
    // did not trade yesterday has no previous daily bar.
    const http = new FakeHttpClient().reply(optionSnapshots({ symbol: CONTRACT, greeks: false, prevDailyBar: false }));
    const [contract] = (await client(http).optionChain({ underlying: 'AAPL' })).contracts;

    expect(contract.greeks).toBeUndefined();
    expect(contract.iv).toBeUndefined();
    expect(contract.pdb).toBeUndefined();
    expect(contract.db).toBeDefined();
    expect(contract.lq).toBeDefined();
  });

  it('carries the greeks and the implied volatility when they are solved', async () => {
    const http = new FakeHttpClient().reply(optionSnapshots({ symbol: CONTRACT }));
    const [contract] = (await client(http).optionChain({ underlying: 'AAPL' })).contracts;

    expect(contract.greeks).toEqual({ delta: 0.5, gamma: 0.02, theta: -0.03, vega: 0.04, rho: 0.01 });
    expect(contract.iv).toBe(0.69);
  });

  it('reports a symbol it cannot take apart, rather than serving a contract with no strike', async () => {
    const http = new FakeHttpClient().reply({ snapshots: { NOTANOCCSYMBOL: {} } });
    const send = client(http).optionChain({ underlying: 'AAPL' });

    await expect(send).rejects.toThrow(DataProviderError);
    await expect(send).rejects.toThrow(/not an OCC contract symbol/);
  });

  it('rejects an expiration range that runs backwards', async () => {
    const http = new FakeHttpClient().reply(optionSnapshots({ symbol: CONTRACT }));
    await expect(client(http).optionChain({ underlying: 'AAPL', expirationFrom: '2026-10-30', expirationTo: '2026-09-01' })).rejects.toThrow(InvalidRequestError);
  });

  it('rejects an expiration that is not a real date', async () => {
    const http = new FakeHttpClient().reply(optionSnapshots({ symbol: CONTRACT }));
    await expect(client(http).optionChain({ underlying: 'AAPL', expirationFrom: '2026-02-30' })).rejects.toThrow(InvalidRequestError);
  });

  it.each([
    ['a strike range that runs backwards', { strikeFrom: 260, strikeTo: 200 }],
    ['a strike of zero', { strikeFrom: 0 }],
    ['a negative strike', { strikeTo: -5 }],
  ])('rejects %s', async (_name, filters) => {
    const http = new FakeHttpClient().reply(optionSnapshots({ symbol: CONTRACT }));
    await expect(client(http).optionChain({ underlying: 'AAPL', ...filters })).rejects.toThrow(InvalidRequestError);
  });
});

describe('option bars', () => {
  const range = { symbol: CONTRACT, from: SESSION, to: SESSION, multiplier: 1, timespan: 'day' as const };

  it('sends neither an adjustment nor a feed, both of which the endpoint refuses', async () => {
    const http = new FakeHttpClient().reply(optionBars(CONTRACT, { t: utc('2024-12-19T05:00:00Z') }));
    await client(http).optionBars(range);

    expect(http.lastRequest.url).toBe('/v1beta1/options/bars');
    expect(http.lastRequest.query['adjustment']).toBeUndefined();
    expect(http.lastRequest.query['feed']).toBeUndefined();
  });

  it('refuses a symbol that is not a contract, before spending a request on it', async () => {
    const http = new FakeHttpClient();
    await expect(client(http).optionBars({ ...range, symbol: 'AAPL' })).rejects.toThrow(InvalidRequestError);
    expect(http.requests).toHaveLength(0);
  });

  it('refuses a monthly multiplier of 4, which the documentation lists and the API rejects', async () => {
    const http = new FakeHttpClient();
    const send = client(http).optionBars({ ...range, timespan: 'month', multiplier: 4 });

    await expect(send).rejects.toThrow(InvalidRequestError);
    await expect(send).rejects.toThrow(/1, 2, 3, 6 or 12/);
    expect(http.requests).toHaveLength(0);
  });

  it.each([1, 2, 3, 6, 12])('takes a monthly multiplier of %i', async (multiplier) => {
    const http = new FakeHttpClient().reply(optionBars(CONTRACT));
    await client(http).optionBars({ ...range, timespan: 'month', multiplier });

    expect(http.lastRequest.query['timeframe']).toBe(`${multiplier}Month`);
  });

  it('follows the page token to the end of the window', async () => {
    const http = new FakeHttpClient().reply(
      withPageToken(optionBars(CONTRACT, { t: utc('2024-12-19T05:00:00Z') }), 'next'),
      withPageToken(optionBars(CONTRACT, { t: utc('2024-12-20T05:00:00Z') }), null),
    );
    const { bars: got } = await client(http).optionBars({ ...range, to: '2024-12-20' });

    expect(got).toHaveLength(2);
    expect(http.requests[1].query['page_token']).toBe('next');
  });
});

describe('option trades', () => {
  it('carries no trade id and no tape, which OPRA does not report', async () => {
    const http = new FakeHttpClient().reply(optionTrades(CONTRACT, { t: utc('2024-12-19T15:34:44.382785953Z'), p: 91.6 }));
    const { trades: got } = await client(http).optionTrades({ symbol: CONTRACT, date: SESSION });

    expect(got).toEqual([{ S: CONTRACT, x: 'C', p: 91.6, s: 1, t: Date.parse('2024-12-19T15:34:44.382Z'), c: ['f'] }]);
  });

  it("wraps OPRA's single condition character in a list, so a print reads the same as an equity one", async () => {
    const http = new FakeHttpClient().reply(optionTrades(CONTRACT, { t: utc('2024-12-19T15:34:44Z'), p: 91.6, c: 'g' }));
    const { trades: got } = await client(http).optionTrades({ symbol: CONTRACT, date: SESSION });

    expect(got[0].c).toEqual(['g']);
  });

  it('reads a whole day as the session, open to after-hours close', async () => {
    const http = new FakeHttpClient().reply(optionTrades(CONTRACT));
    await client(http).optionTrades({ symbol: CONTRACT, date: SESSION });

    expect(http.lastRequest.query['start']).toBe(new Date(at(SESSION, '04:00:00')).toISOString());
    expect(http.lastRequest.query['end']).toBe(new Date(at(SESSION, '20:00:00')).toISOString());
  });

  it('answers with nothing for a day the market did not trade, without asking', async () => {
    const http = new FakeHttpClient();
    const { trades: got } = await client(http).optionTrades({ symbol: CONTRACT, date: '2024-12-25' });

    expect(got).toEqual([]);
    expect(http.requests).toHaveLength(0);
  });

  it('refuses a symbol that is not a contract', async () => {
    const http = new FakeHttpClient();
    await expect(client(http).optionTrades({ symbol: 'AAPL', date: SESSION })).rejects.toThrow(InvalidRequestError);
  });
});

describe('the condition and exchange dictionaries', () => {
  it('reads stock conditions from the tape they belong to', async () => {
    const http = new FakeHttpClient().reply(conditionDictionary({ '@': 'Regular Sale', I: 'Odd Lot Trade' }));
    const { conditions } = await client(http).conditions({ market: 'stocks', tickType: 'trade', tape: 'C' });

    expect(http.lastRequest.url).toBe('/v2/stocks/meta/conditions/trade');
    expect(http.lastRequest.query['tape']).toBe('C');
    expect(conditions.get('I')).toBe('Odd Lot Trade');
  });

  it('refuses a stock conditions request with no tape, which the endpoint requires', async () => {
    const http = new FakeHttpClient();
    await expect(client(http).conditions({ market: 'stocks', tickType: 'trade' })).rejects.toThrow(InvalidRequestError);
    expect(http.requests).toHaveLength(0);
  });

  it('refuses a tape on an options request rather than sending one the endpoint rejects', async () => {
    const http = new FakeHttpClient();
    await expect(client(http).conditions({ market: 'options', tickType: 'trade', tape: 'A' })).rejects.toThrow(InvalidRequestError);
    expect(http.requests).toHaveLength(0);
  });

  it('reads option conditions, where the multi-leg codes live', async () => {
    const http = new FakeHttpClient().reply(conditionDictionary({ f: 'MLET - Multi Leg autoelectronic trade', g: 'MLAT - Multi Leg Auction' }));
    const { conditions } = await client(http).conditions({ market: 'options', tickType: 'trade' });

    expect(http.lastRequest.url).toBe('/v1beta1/options/meta/conditions/trade');
    expect(http.lastRequest.query['tape']).toBeUndefined();
    expect(conditions.get('f')).toBe('MLET - Multi Leg autoelectronic trade');
  });

  it.each([
    ['stocks', '/v2/stocks/meta/exchanges'],
    ['options', '/v1beta1/options/meta/exchanges'],
  ] as const)('reads %s exchanges from their own path', async (market, path) => {
    const http = new FakeHttpClient().reply(conditionDictionary({ C: 'CBOE' }));
    const { exchanges } = await client(http).exchanges({ market });

    expect(http.lastRequest.url).toBe(path);
    expect(exchanges.get('C')).toBe('CBOE');
  });

  it('reports a description that is not a string, rather than a map with a number in it', async () => {
    const http = new FakeHttpClient().reply({ '@': 42 });
    const send = client(http).conditions({ market: 'options', tickType: 'trade' });

    await expect(send).rejects.toThrow(DataProviderError);
    await expect(send).rejects.toThrow(/not a description/);
  });
});

describe('what the option surface changed for stocks', () => {
  it('refuses a monthly multiplier of 4 on stock bars too, since the table is shared', async () => {
    // The option path is guarded above; this is the shipped path the same change altered.
    const http = new FakeHttpClient();
    const send = client(http).bars({ symbol: 'AAPL', from: SESSION, to: SESSION, timespan: 'month', multiplier: 4 });

    await expect(send).rejects.toThrow(InvalidRequestError);
    await expect(send).rejects.toThrow(/1, 2, 3, 6 or 12/);
    expect(http.requests).toHaveLength(0);
  });

  it.each([1, 2, 3, 6, 12])('still takes a monthly multiplier of %i on stock bars', async (multiplier) => {
    const http = new FakeHttpClient().reply(bars('AAPL'));
    await client(http).bars({ symbol: 'AAPL', from: SESSION, to: SESSION, timespan: 'month', multiplier });

    expect(http.lastRequest.query['timeframe']).toBe(`${multiplier}Month`);
  });
});

describe('an adjusted contract', () => {
  const ADJUSTED = 'AAPL1260918C00230000';

  it('reads as the same expiry and strike as an unadjusted one, with the root telling them apart', async () => {
    const http = new FakeHttpClient().reply(optionSnapshots({ symbol: CONTRACT }, { symbol: ADJUSTED }));
    const { contracts } = await client(http).optionChain({ underlying: 'AAPL' });

    expect(contracts.map((contract) => contract.contract.root)).toEqual(['AAPL', 'AAPL1']);
    expect(contracts.every((contract) => contract.contract.underlying === 'AAPL' && contract.contract.strike === 230 && contract.contract.expiration === '2026-09-18')).toBe(true);
  });

  it('does not cost the rest of the page, which refusing to parse it would', async () => {
    const http = new FakeHttpClient().reply(optionSnapshots({ symbol: ADJUSTED }, { symbol: CONTRACT }, { symbol: PUT }));
    const { contracts } = await client(http).optionChain({ underlying: 'AAPL' });

    expect(contracts).toHaveLength(3);
  });

  it('is history Alpaca will serve, so it is not refused before the request', async () => {
    const http = new FakeHttpClient().reply(optionBars(ADJUSTED, { t: utc('2024-12-19T05:00:00Z') }));
    const { bars: got } = await client(http).optionBars({ symbol: ADJUSTED, from: SESSION, to: SESSION, multiplier: 1, timespan: 'day' });

    expect(http.lastRequest.query['symbols']).toBe(ADJUSTED);
    expect(got[0].S).toBe(ADJUSTED);
  });
});

describe('a print with no condition', () => {
  it('has none, rather than a list holding nothing', async () => {
    const http = new FakeHttpClient().reply(optionTrades(CONTRACT, { t: utc('2024-12-19T15:34:44Z'), p: 91.6, c: undefined }));
    const { trades: got } = await client(http).optionTrades({ symbol: CONTRACT, date: SESSION });

    expect(got[0].c).toBeUndefined();
  });

  it('reads a null condition as no condition, not as a list holding null', async () => {
    const http = new FakeHttpClient().reply(optionTrades(CONTRACT, { t: utc('2024-12-19T15:34:44Z'), p: 91.6, c: null }));
    const { trades: got } = await client(http).optionTrades({ symbol: CONTRACT, date: SESSION });

    expect(got[0].c).toBeUndefined();
  });
});

describe('a malformed provider answer', () => {
  it('reports greeks missing a field rather than typing undefined as a number', async () => {
    // A summed gamma over a position would otherwise be NaN, with nothing to point at.
    const http = new FakeHttpClient().reply({ snapshots: { [CONTRACT]: { greeks: { delta: 0.5 }, impliedVolatility: 0.69 } } });
    const send = client(http).optionChain({ underlying: 'AAPL' });

    await expect(send).rejects.toThrow(DataProviderError);
    await expect(send).rejects.toThrow(/gamma/);
  });

  it('keeps an unmodelled greek out of the domain model', async () => {
    const greeks = { delta: 0.5, gamma: 0.02, theta: -0.03, vega: 0.04, rho: 0.01 };
    const http = new FakeHttpClient().reply({ snapshots: { [CONTRACT]: { greeks: { ...greeks, charm: 9 } } } });
    const [contract] = (await client(http).optionChain({ underlying: 'AAPL' })).contracts;

    expect(contract.greeks).toEqual(greeks);
  });

  it('reports a dictionary sent as a list, rather than keying the codes by position', async () => {
    const http = new FakeHttpClient().reply(['CBOE', 'AMEX']);
    const send = client(http).exchanges({ market: 'options' });

    await expect(send).rejects.toThrow(DataProviderError);
    await expect(send).rejects.toThrow(/as a list/);
  });

  it('still refuses a symbol that is no kind of contract', async () => {
    const http = new FakeHttpClient().reply({ snapshots: { NOTANOCCSYMBOL: {} } });
    await expect(client(http).optionChain({ underlying: 'AAPL' })).rejects.toThrow(/not an OCC contract symbol/);
  });
});

describe('a chain with no underlying', () => {
  it('is refused here rather than addressing the multi-symbol route by accident', async () => {
    const http = new FakeHttpClient();
    await expect(client(http).optionChain({ underlying: '  ' })).rejects.toThrow(InvalidRequestError);
    expect(http.requests).toHaveLength(0);
  });
});
