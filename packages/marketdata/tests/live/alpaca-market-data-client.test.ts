import { easternClock } from '@fleece/shared';

import { AlpacaMarketDataClient } from '../../src/alpaca';
import { DataProviderError } from '../../src/equity-data-models';
import { marketHour } from '../../src/market-hours';
import { PolygonRestClient } from '../../src/polygon';

/**
 * Against the real Alpaca API. Run with `npm run test:live`, having put the keys in
 * `.env`; `npm test` does not include this directory.
 *
 * Settled historical facts only, as with the Polygon suite — and where the two providers
 * describe the same window, this asserts they agree. Two independent tapes reporting the
 * same 390 bars and the same 642 trades is a stronger statement about our normalisation
 * than either one alone.
 */
const apiKey = process.env['ALPACA_PAPER_API_KEY'];
const secretKey = process.env['ALPACA_PAPER_SECRET_KEY'];
const polygonKey = process.env['POLYGON_KEY'] ?? process.env['FLEECE_POLYGON_API_KEY'];

if (apiKey === undefined || secretKey === undefined) {
  throw new Error('The live suite needs ALPACA_PAPER_API_KEY and ALPACA_PAPER_SECRET_KEY in .env.');
}

const alpaca = new AlpacaMarketDataClient({ apiKey, secretKey });

const SESSION = '2024-12-19';
const HALF_DAY = '2024-12-24';

jest.setTimeout(60_000);

describe('bars', () => {
  it('returns one daily bar per session in the range', async () => {
    const { bars } = await alpaca.dailyBars({ symbol: 'AAPL', from: '2024-12-16', to: '2024-12-20' });

    expect(bars.map((bar) => easternClock.date(bar.t))).toStrictEqual(['2024-12-16', '2024-12-17', '2024-12-18', '2024-12-19', '2024-12-20']);
    expect(bars.every((bar) => bar.S === 'AAPL' && bar.l <= bar.o && bar.o <= bar.h && bar.v > 0)).toBe(true);
  });

  it('returns exactly the regular session in one-minute bars', async () => {
    const { bars } = await alpaca.minuteBars({ symbol: 'AAPL', from: SESSION, to: SESSION });

    expect(bars).toHaveLength(390);
    expect(easternClock.time(bars[0].t)).toBe('09:30:00');
    expect(easternClock.time(bars[bars.length - 1].t)).toBe('15:59:00');
  });

  it('returns pre-market and after-hours bars too when not filtered', async () => {
    const { bars } = await alpaca.minuteBars({ symbol: 'AAPL', from: SESSION, to: SESSION, marketHoursOnly: false });

    expect(bars.length).toBeGreaterThan(390);
    expect(easternClock.time(bars[0].t) < '09:30:00').toBe(true);
  });

  it('adjusts historical prices for a later split only when asked', async () => {
    const { bars: raw } = await alpaca.dailyBars({ symbol: 'AAPL', from: '2020-08-28', to: '2020-08-28' });
    const { bars: adjusted } = await alpaca.dailyBars({ symbol: 'AAPL', from: '2020-08-28', to: '2020-08-28', adjustForSplit: true });

    expect(raw[0].c).toBeCloseTo(499.23, 2);
    expect(adjusted[0].c).toBeCloseTo(124.81, 2);
  });

  it('has nothing for a symbol that does not exist', async () => {
    expect((await alpaca.dailyBars({ symbol: 'ZZZZNOPE', from: SESSION, to: SESSION })).bars).toStrictEqual([]);
  });
});

describe('trades and quotes', () => {
  const from = easternClock.timestamp(SESSION, '10:00:00');
  const to = easternClock.timestamp(SESSION, '10:00:05');

  it('returns trades inside the window, in order', async () => {
    const { trades } = await alpaca.trades({ symbol: 'AAPL', from, to });

    expect(trades.length).toBeGreaterThan(100);
    expect(trades.every((trade) => trade.S === 'AAPL' && trade.t >= from && trade.t < to && trade.p > 0)).toBe(true);
    expect(trades.every((trade, index) => index === 0 || trade.t >= trades[index - 1].t)).toBe(true);
  });

  it.each([1, 10, 1000])('follows the page token to the same window with a page size of %i', async (itemsPerRequest) => {
    const { trades: paged } = await alpaca.trades({ symbol: 'AAPL', from, to: easternClock.timestamp(SESSION, '10:00:01'), itemsPerRequest });
    const { trades: single } = await alpaca.trades({ symbol: 'AAPL', from, to: easternClock.timestamp(SESSION, '10:00:01') });

    expect(paged.map((trade) => trade.t)).toStrictEqual(single.map((trade) => trade.t));
  });

  it('returns quotes with both sides of the book', async () => {
    const { quotes } = await alpaca.quotes({ symbol: 'AAPL', from, to: easternClock.timestamp(SESSION, '10:00:01') });

    expect(quotes.length).toBeGreaterThan(0);
    expect(quotes.every((quote) => quote.bp > 0 && quote.ap >= quote.bp)).toBe(true);
  });
});

describe('marketHours', () => {
  it('returns the trading days in the range, skipping the holiday', async () => {
    const { sessions } = await alpaca.marketHours({ fromDate: '2024-12-23', toDate: '2024-12-27' });

    // The 25th is Christmas and the 21st and 22nd are the weekend.
    expect(sessions.map((session) => session.date)).toStrictEqual(['2024-12-23', '2024-12-24', '2024-12-26', '2024-12-27']);
  });

  it('reports the half day, including the after-hours close no rule derives', async () => {
    const { sessions } = await alpaca.marketHours({ fromDate: HALF_DAY, toDate: HALF_DAY });

    expect(sessions[0].close).toBe('13:00');
    expect(easternClock.time(sessions[0].afterMarketCloseAt)).toBe('17:00:00');
  });

  it('agrees with the session table this repo ships, for a week it covers', async () => {
    // Which is what makes it a refresh: the same rows, from the exchange rather than a
    // file someone generated years ago.
    const { sessions } = await alpaca.marketHours({ fromDate: '2024-12-23', toDate: '2024-12-27' });

    for (const session of sessions) {
      const stored = marketHour(session.date);
      expect(stored).toBeDefined();
      // `index` is the row's position in the table and the only thing the calendar has
      // no opinion about; everything else has to match, or a refresh would rewrite rows.
      const { index, ...withoutIndex } = stored!;
      expect(withoutIndex).toStrictEqual(session);
      expect(index).toBeGreaterThanOrEqual(0);
    }
  });

  it('covers dates past the end of the shipped table, which is the point of it', async () => {
    const { sessions } = await alpaca.marketHours({ fromDate: '2026-01-02', toDate: '2026-01-09' });

    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((session) => session.open === '09:30')).toBe(true);
  });
});

describe('the two providers agree', () => {
  const runIfPolygon = polygonKey === undefined ? it.skip : it;

  runIfPolygon('on the minute bars of a session', async () => {
    const polygon = new PolygonRestClient({ apiKey: polygonKey! });
    const [fromAlpaca, fromPolygon] = await Promise.all([
      alpaca.minuteBars({ symbol: 'AAPL', from: SESSION, to: SESSION }),
      polygon.minuteBars({ symbol: 'AAPL', from: SESSION, to: SESSION }),
    ]);

    expect(fromAlpaca.bars.map((bar) => bar.t)).toStrictEqual(fromPolygon.bars.map((bar) => bar.t));
  });

  runIfPolygon('on the daily closes of a week', async () => {
    const polygon = new PolygonRestClient({ apiKey: polygonKey! });
    const [fromAlpaca, fromPolygon] = await Promise.all([
      alpaca.dailyBars({ symbol: 'AAPL', from: '2024-12-16', to: '2024-12-20' }),
      polygon.dailyBars({ symbol: 'AAPL', from: '2024-12-16', to: '2024-12-20' }),
    ]);

    expect(fromAlpaca.bars.map((bar) => bar.c)).toStrictEqual(fromPolygon.bars.map((bar) => bar.c));
  });
});

describe('failure', () => {
  it('reports a rejected key as a provider error, not as empty data', async () => {
    const send = new AlpacaMarketDataClient({ apiKey: 'not-a-real-key', secretKey: 'nor-this' }).dailyBars({ symbol: 'AAPL', from: SESSION, to: SESSION });

    await expect(send).rejects.toThrow(DataProviderError);
    await expect(send).rejects.toThrow(/returned 40/);
  });
});
