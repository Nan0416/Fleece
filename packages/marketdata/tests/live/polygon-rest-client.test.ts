import { easternClock } from '@fleece/shared';

import { DataProviderError } from '../../src/data-models';
import { marketState } from '../../src/market-hours';
import { PolygonRestClient } from '../../src/polygon';

/**
 * Against the real Polygon API. Run with `npm run test:live`, having put `POLYGON_KEY` in
 * `.env`; `npm test` does not include this directory.
 *
 * Every assertion is about a settled historical fact — a 2024 session, a 2020 split — so
 * the suite is deterministic despite talking to a live service. Nothing here asserts on
 * today, which would be a test that fails at the weekend.
 */
const apiKey = process.env['POLYGON_KEY'] ?? process.env['FLEECE_POLYGON_API_KEY'];

if (apiKey === undefined) {
  throw new Error('The live suite needs POLYGON_KEY in .env (or FLEECE_POLYGON_API_KEY in the environment).');
}

const polygon = new PolygonRestClient({ apiKey });

const SESSION = '2024-12-19';
const HALF_DAY = '2024-12-24';

jest.setTimeout(60_000);

describe('bars', () => {
  it('returns one daily bar per session in the range', async () => {
    const { bars } = await polygon.dailyBars({ symbol: 'AAPL', from: '2024-12-16', to: '2024-12-20' });

    expect(bars.map((bar) => easternClock.date(bar.t))).toStrictEqual(['2024-12-16', '2024-12-17', '2024-12-18', '2024-12-19', '2024-12-20']);
    expect(bars.every((bar) => bar.S === 'AAPL' && bar.l <= bar.o && bar.o <= bar.h && bar.v > 0)).toBe(true);
  });

  it('adjusts historical prices for a later split only when asked', async () => {
    // AAPL split 4-for-1 on 2020-08-31, so its 2020-08-28 close reads either way.
    const { bars: raw } = await polygon.dailyBars({ symbol: 'AAPL', from: '2020-08-28', to: '2020-08-28' });
    const { bars: adjusted } = await polygon.dailyBars({ symbol: 'AAPL', from: '2020-08-28', to: '2020-08-28', adjustForSplit: true });

    expect(raw[0].c).toBeCloseTo(499.23, 2);
    expect(adjusted[0].c).toBeCloseTo(124.81, 2);
  });

  it('returns exactly the regular session in one-minute bars', async () => {
    const { bars } = await polygon.minuteBars({ symbol: 'AAPL', from: SESSION, to: SESSION });

    expect(bars).toHaveLength(390); // 09:30 to 15:59 inclusive
    expect(easternClock.time(bars[0].t)).toBe('09:30:00');
    expect(easternClock.time(bars[bars.length - 1].t)).toBe('15:59:00');
  });

  it('returns pre-market and after-hours bars too when not filtered', async () => {
    const { bars: extended } = await polygon.minuteBars({ symbol: 'AAPL', from: SESSION, to: SESSION, marketHoursOnly: false });

    expect(extended.length).toBeGreaterThan(390);
    expect(easternClock.time(extended[0].t) < '09:30:00').toBe(true);
  });

  it('stops at 13:00 on a half day', async () => {
    const { bars } = await polygon.minuteBars({ symbol: 'AAPL', from: HALF_DAY, to: HALF_DAY });

    expect(easternClock.time(bars[bars.length - 1].t)).toBe('12:59:00');
  });

  it('has nothing for a symbol that does not exist', async () => {
    expect((await polygon.dailyBars({ symbol: 'ZZZZNOPE', from: SESSION, to: SESSION })).bars).toStrictEqual([]);
  });
});

describe('trades and quotes', () => {
  const from = easternClock.timestamp(SESSION, '10:00:00');
  const to = easternClock.timestamp(SESSION, '10:00:05');

  it('returns trades inside the window, in order', async () => {
    const { trades: result } = await polygon.trades({ symbol: 'AAPL', from, to });

    expect(result.length).toBeGreaterThan(100);
    expect(result.every((trade) => trade.S === 'AAPL' && trade.t >= from && trade.t < to && trade.p > 0)).toBe(true);
    expect(result.every((trade, index) => index === 0 || trade.t >= result[index - 1].t)).toBe(true);
  });

  it.each([1, 2, 50])('returns the same window with a page size of %i as in one page', async (itemsPerRequest) => {
    // Real tick density is the point: a page smaller than the number of trades sharing
    // the cursor's backoff window used to end the walk with an error, and 1 and 2 did it
    // on any ordinary window. A second is narrow enough that even one-at-a-time stays
    // inside the page cap.
    const narrow = easternClock.timestamp(SESSION, '10:00:01');
    const { trades: paged } = await polygon.trades({ symbol: 'AAPL', from, to: narrow, itemsPerRequest });
    const { trades: single } = await polygon.trades({ symbol: 'AAPL', from, to: narrow });

    expect(paged).toHaveLength(single.length);
    expect(paged.map((trade) => trade.t)).toStrictEqual(single.map((trade) => trade.t));
  });

  it('says the page size is the problem when a window needs more pages than it has', async () => {
    // 642 trades at four a page is past the cap, and the message has to say why.
    const send = polygon.trades({ symbol: 'AAPL', from, to, itemsPerRequest: 1 });
    await expect(send).rejects.toThrow(/Ask for a larger itemsPerRequest/);
  });

  it('returns quotes with both sides of the book', async () => {
    const { quotes: result } = await polygon.quotes({ symbol: 'AAPL', from, to: easternClock.timestamp(SESSION, '10:00:01') });

    expect(result.length).toBeGreaterThan(0);
    expect(result.every((quote) => quote.bp > 0 && quote.ap >= quote.bp)).toBe(true);
  });

  it('has nothing for a day the market never opened', async () => {
    expect((await polygon.trades({ symbol: 'AAPL', date: '2024-12-25' })).trades).toStrictEqual([]);
  });
});

describe('reference data', () => {
  it('lists every AAPL split Polygon knows', async () => {
    const { splits } = await polygon.stockSplits({ symbol: 'AAPL' });

    expect(splits.map((split) => `${split.executionDate} ${split.splitFrom}:${split.splitTo}`)).toStrictEqual([
      '1987-06-16 1:2',
      '2000-06-21 1:2',
      '2005-02-28 1:2',
      '2014-06-09 1:7',
      '2020-08-31 1:4',
    ]);
  });

  it("lists AAPL's four 2024 dividends, quarterly", async () => {
    const { dividends } = await polygon.dividends({ symbol: 'AAPL', dateType: 'ex_dividend_date', fromDate: '2024-01-01', toDate: '2024-12-31' });

    expect(dividends).toHaveLength(4);
    expect(dividends.map((dividend) => dividend.exDividendDate)).toStrictEqual(['2024-02-09', '2024-05-10', '2024-08-12', '2024-11-08']);
    expect(dividends.every((dividend) => dividend.frequency === 'quarterly' && dividend.dividendType === 'CD' && dividend.currency === 'USD')).toBe(true);
  });

  it('describes a ticker', async () => {
    const { details } = await polygon.tickerDetails({ symbol: 'AAPL' });

    expect(details?.name).toMatch(/Apple/);
    expect(details?.primaryExchange).toBe('XNAS');
    expect(details?.type).toBe('CS');
    expect(details?.outstandingShares).toBeGreaterThan(0);
  });

  it('lists tickers in symbol order, up to the limit asked for', async () => {
    const { tickers } = await polygon.tickers({ limit: 5, type: 'CS', active: true });

    expect(tickers).toHaveLength(5);
    expect(tickers.map((ticker) => ticker.ticker)).toStrictEqual([...tickers.map((ticker) => ticker.ticker)].sort());
    expect(tickers.every((ticker) => ticker.f === 'p' && ticker.market === 'stocks')).toBe(true);
  });

  it('resumes from a given ticker', async () => {
    const { tickers } = await polygon.tickers({ startTicker: 'MSFT', limit: 3 });

    expect(tickers[0].ticker >= 'MSFT').toBe(true);
  });
});

describe('historicalBars', () => {
  it('returns the trading days before the end date, most recent first', async () => {
    const { days } = await polygon.historicalBars({ symbol: 'AAPL', endDate: '2024-12-23', days: 3 });

    expect([...days.keys()]).toStrictEqual(['2024-12-23', '2024-12-20', '2024-12-19']);
    expect([...days.values()].every((bars) => bars.length === 390)).toBe(true);
  });
});

describe('failure', () => {
  it('reports a rejected key as a provider error, not as empty data', async () => {
    const send = new PolygonRestClient({ apiKey: 'not-a-real-key' }).tickerDetails({ symbol: 'AAPL' });

    await expect(send).rejects.toThrow(DataProviderError);
    await expect(send).rejects.toThrow(/returned 401/);
  });

  it('reports an unknown symbol as a 404 rather than inventing a ticker', async () => {
    await expect(polygon.tickerDetails({ symbol: 'ZZZZNOPE' })).rejects.toThrow(/returned 404/);
  });
});

/**
 * The one thing here that is about today, because Polygon serves a snapshot only while a
 * session is live and clears it at Eastern midnight. Both branches assert something: that
 * the minute bar is a real minute of the live session, or that a closed market is why
 * there is none.
 */
describe('the latest snapshot', () => {
  it("stamps its minute bar at a whole minute of today's session, or is absent because the market is shut", async () => {
    const { snapshot } = await polygon.snapshot({ symbol: 'AAPL' });

    if (snapshot === undefined) {
      expect(marketState()).toBe('closed');
      return;
    }

    // Reading the window as nanoseconds would date it to 1970; reading it from `updated`
    // would land on whatever minute this ran in rather than the bar's own.
    expect(snapshot.mb.t % 60_000).toBe(0);
    expect(easternClock.date(snapshot.mb.t)).toBe(easternClock.date());
    expect(snapshot.mb.t).toBeLessThanOrEqual(Date.now());
  });
});
