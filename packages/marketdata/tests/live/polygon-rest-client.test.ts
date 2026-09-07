import { easternClock } from '@fleece/shared';

import { DataProviderError } from '../../src/equity-data-models';
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
    const bars = await polygon.dailyBars({ symbol: 'AAPL', from: '2024-12-16', to: '2024-12-20' });

    expect(bars.map((bar) => easternClock.date(bar.t))).toStrictEqual(['2024-12-16', '2024-12-17', '2024-12-18', '2024-12-19', '2024-12-20']);
    expect(bars.every((bar) => bar.S === 'AAPL' && bar.l <= bar.o && bar.o <= bar.h && bar.v > 0)).toBe(true);
  });

  it('adjusts historical prices for a later split only when asked', async () => {
    // AAPL split 4-for-1 on 2020-08-31, so its 2020-08-28 close reads either way.
    const [raw] = await polygon.dailyBars({ symbol: 'AAPL', from: '2020-08-28', to: '2020-08-28' });
    const [adjusted] = await polygon.dailyBars({ symbol: 'AAPL', from: '2020-08-28', to: '2020-08-28', adjustForSplit: true });

    expect(raw.c).toBeCloseTo(499.23, 2);
    expect(adjusted.c).toBeCloseTo(124.81, 2);
  });

  it('returns exactly the regular session in one-minute bars', async () => {
    const bars = await polygon.minuteBars({ symbol: 'AAPL', from: SESSION, to: SESSION });

    expect(bars).toHaveLength(390); // 09:30 to 15:59 inclusive
    expect(easternClock.time(bars[0].t)).toBe('09:30:00');
    expect(easternClock.time(bars[bars.length - 1].t)).toBe('15:59:00');
  });

  it('returns pre-market and after-hours bars too when not filtered', async () => {
    const extended = await polygon.minuteBars({ symbol: 'AAPL', from: SESSION, to: SESSION, marketHoursOnly: false });

    expect(extended.length).toBeGreaterThan(390);
    expect(easternClock.time(extended[0].t) < '09:30:00').toBe(true);
  });

  it('stops at 13:00 on a half day', async () => {
    const bars = await polygon.minuteBars({ symbol: 'AAPL', from: HALF_DAY, to: HALF_DAY });

    expect(easternClock.time(bars[bars.length - 1].t)).toBe('12:59:00');
  });

  it('has nothing for a symbol that does not exist', async () => {
    expect(await polygon.dailyBars({ symbol: 'ZZZZNOPE', from: SESSION, to: SESSION })).toStrictEqual([]);
  });
});

describe('trades and quotes', () => {
  const from = easternClock.timestamp(SESSION, '10:00:00');
  const to = easternClock.timestamp(SESSION, '10:00:05');

  it('returns trades inside the window, in order', async () => {
    const result = await polygon.trades({ symbol: 'AAPL', from, to });

    expect(result.length).toBeGreaterThan(100);
    expect(result.every((trade) => trade.S === 'AAPL' && trade.t >= from && trade.t < to && trade.p > 0)).toBe(true);
    expect(result.every((trade, index) => index === 0 || trade.t >= result[index - 1].t)).toBe(true);
  });

  it('pages past its own limit to return the whole window', async () => {
    // A page smaller than the window forces the timestamp cursor to be exercised.
    const paged = await polygon.trades({ symbol: 'AAPL', from, to, itemsPerRequest: 50 });
    const single = await polygon.trades({ symbol: 'AAPL', from, to });

    expect(paged).toHaveLength(single.length);
    expect(paged[paged.length - 1].t).toBe(single[single.length - 1].t);
  });

  it('returns quotes with both sides of the book', async () => {
    const result = await polygon.quotes({ symbol: 'AAPL', from, to: easternClock.timestamp(SESSION, '10:00:01') });

    expect(result.length).toBeGreaterThan(0);
    expect(result.every((quote) => quote.bp > 0 && quote.ap >= quote.bp)).toBe(true);
  });

  it('has nothing for a day the market never opened', async () => {
    expect(await polygon.trades({ symbol: 'AAPL', date: '2024-12-25' })).toStrictEqual([]);
  });
});

describe('reference data', () => {
  it('lists every AAPL split Polygon knows', async () => {
    const splits = await polygon.stockSplits({ symbol: 'AAPL' });

    expect(splits.map((split) => `${split.executionDate} ${split.splitFrom}:${split.splitTo}`)).toStrictEqual([
      '1987-06-16 1:2',
      '2000-06-21 1:2',
      '2005-02-28 1:2',
      '2014-06-09 1:7',
      '2020-08-31 1:4',
    ]);
  });

  it("lists AAPL's four 2024 dividends, quarterly", async () => {
    const dividends = await polygon.dividends({ symbol: 'AAPL', dateType: 'ex_dividend_date', fromDate: '2024-01-01', toDate: '2024-12-31' });

    expect(dividends).toHaveLength(4);
    expect(dividends.map((dividend) => dividend.exDividendDate)).toStrictEqual(['2024-02-09', '2024-05-10', '2024-08-12', '2024-11-08']);
    expect(dividends.every((dividend) => dividend.frequency === 'quarterly' && dividend.dividendType === 'CD' && dividend.currency === 'USD')).toBe(true);
  });

  it('describes a ticker', async () => {
    const details = await polygon.tickerDetails({ symbol: 'AAPL' });

    expect(details?.name).toMatch(/Apple/);
    expect(details?.primaryExchange).toBe('XNAS');
    expect(details?.type).toBe('CS');
    expect(details?.outstandingShares).toBeGreaterThan(0);
  });

  it('lists tickers in symbol order, up to the limit asked for', async () => {
    const tickers = await polygon.tickers({ limit: 5, type: 'CS', active: true });

    expect(tickers).toHaveLength(5);
    expect(tickers.map((ticker) => ticker.ticker)).toStrictEqual([...tickers.map((ticker) => ticker.ticker)].sort());
    expect(tickers.every((ticker) => ticker.f === 'p' && ticker.market === 'stocks')).toBe(true);
  });

  it('resumes from a given ticker', async () => {
    const tickers = await polygon.tickers({ startTicker: 'MSFT', limit: 3 });

    expect(tickers[0].ticker >= 'MSFT').toBe(true);
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
