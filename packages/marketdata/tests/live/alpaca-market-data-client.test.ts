import { easternClock } from '@fleece/shared';

import { AlpacaMarketDataClient } from '../../src/alpaca';
import { DataProviderError } from '../../src/data-models';
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

  it.each(['week', 'month'] as const)('returns %s bars, which span whole sessions', async (timespan) => {
    // Filtering these by regular hours emptied every one of them: a weekly bar is stamped
    // at the start of its week, which is not a moment the market is open.
    const { bars } = await alpaca.bars({ symbol: 'AAPL', from: '2024-10-01', to: '2024-12-20', multiplier: 1, timespan });

    expect(bars.length).toBeGreaterThan(0);
    expect(bars.every((bar) => bar.S === 'AAPL' && bar.v > 0)).toBe(true);
  });

  it('returns weekly bars past the end of the market-hours table, which they never needed', async () => {
    const { bars } = await alpaca.bars({ symbol: 'AAPL', from: '2026-01-05', to: '2026-02-06', multiplier: 1, timespan: 'week' });

    expect(bars.length).toBeGreaterThan(0);
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

  it('restates prints from before a split when asked', async () => {
    // AAPL split four-for-one on 2020-08-31; the endpoint serves the prints as they
    // happened, so an adjusted price is arithmetic over the splits the client fetches.
    const beforeSplit = Date.parse('2020-08-28T14:00:00Z');
    const { trades: raw } = await alpaca.trades({ symbol: 'AAPL', from: beforeSplit, to: beforeSplit + 1_000 });
    const { trades: adjusted } = await alpaca.trades({ symbol: 'AAPL', from: beforeSplit, to: beforeSplit + 1_000, adjustForSplit: true });

    expect(raw[0].p).toBeCloseTo(503.5, 2);
    expect(adjusted[0].p).toBeCloseTo(raw[0].p / 4, 4);
  });

  it('returns quotes with both sides of the book', async () => {
    const { quotes } = await alpaca.quotes({ symbol: 'AAPL', from, to: easternClock.timestamp(SESSION, '10:00:01') });

    expect(quotes.length).toBeGreaterThan(0);
    expect(quotes.every((quote) => quote.bp > 0 && quote.ap >= quote.bp)).toBe(true);
  });
});

describe('stockSplits', () => {
  it("returns AAPL's 2020 four-for-one, the same way Polygon states it", async () => {
    const { splits } = await alpaca.stockSplits({ symbol: 'AAPL' });

    expect(splits).toContainEqual({ ticker: 'AAPL', executionDate: '2020-08-31', splitFrom: 1, splitTo: 4 });
  });

  it('returns a reverse split with its rates the same way round', async () => {
    const { splits } = await alpaca.stockSplits({ symbol: 'GE' });

    expect(splits).toContainEqual({ ticker: 'GE', executionDate: '2021-08-02', splitFrom: 8, splitTo: 1 });
  });

  it('narrows to a single execution date', async () => {
    const { splits } = await alpaca.stockSplits({ symbol: 'AAPL', executionDate: '2020-08-31' });

    expect(splits).toHaveLength(1);
    expect(splits[0].executionDate).toBe('2020-08-31');
  });

  it('has nothing for a symbol that never split', async () => {
    expect((await alpaca.stockSplits({ symbol: 'ZZZZNOPE' })).splits).toStrictEqual([]);
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

  runIfPolygon('on monthly bars, though not on weekly ones', async () => {
    const polygon = new PolygonRestClient({ apiKey: polygonKey! });
    const range = { symbol: 'AAPL', from: '2024-10-01', to: '2024-12-20', multiplier: 1 } as const;
    const [alpacaMonths, polygonMonths, alpacaWeeks, polygonWeeks] = await Promise.all([
      alpaca.bars({ ...range, timespan: 'month' }),
      polygon.bars({ ...range, timespan: 'month' }),
      alpaca.bars({ ...range, timespan: 'week' }),
      polygon.bars({ ...range, timespan: 'week' }),
    ]);

    expect(alpacaMonths.bars.map((bar) => bar.c)).toStrictEqual(polygonMonths.bars.map((bar) => bar.c));
    // Weeks are anchored differently — Alpaca on Monday, Polygon on Sunday — and Alpaca
    // drops the partial week at the start of a range where Polygon keeps it. Asserted so
    // that a future change to either makes a decision rather than a surprise.
    expect(alpacaWeeks.bars.length).not.toBe(polygonWeeks.bars.length);
    expect(easternClock.date(alpacaWeeks.bars[0].t)).toBe('2024-10-07');
    expect(easternClock.date(polygonWeeks.bars[0].t)).toBe('2024-09-29');
  });

  runIfPolygon('on a split-adjusted print, which neither provider adjusts for us', async () => {
    const polygon = new PolygonRestClient({ apiKey: polygonKey! });
    const beforeSplit = Date.parse('2020-08-28T14:00:00Z');
    const window = { symbol: 'AAPL', from: beforeSplit, to: beforeSplit + 1_000, adjustForSplit: true } as const;
    const [fromAlpaca, fromPolygon] = await Promise.all([alpaca.trades(window), polygon.trades(window)]);

    expect(fromAlpaca.trades[0].p).toBeCloseTo(fromPolygon.trades[0].p, 6);
  });

  runIfPolygon('on the splits they both hold, though Alpaca holds fewer', async () => {
    const polygon = new PolygonRestClient({ apiKey: polygonKey! });
    const [fromAlpaca, fromPolygon] = await Promise.all([alpaca.stockSplits({ symbol: 'AAPL' }), polygon.stockSplits({ symbol: 'AAPL' })]);

    // Every split Alpaca reports, Polygon reports identically.
    for (const split of fromAlpaca.splits) {
      expect(fromPolygon.splits).toContainEqual(split);
    }
    // Polygon reaches back to 1987; Alpaca's corporate actions begin around 2016, so the
    // one to reconstruct a long price history from is Polygon.
    expect(fromPolygon.splits.length).toBeGreaterThan(fromAlpaca.splits.length);
    expect(fromPolygon.splits.some((split) => split.executionDate < '2016-01-01')).toBe(true);
    expect(fromAlpaca.splits.every((split) => split.executionDate >= '2016-01-01')).toBe(true);
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

interface TradedContract {
  readonly symbol: string;
  /** The session that daily bar covers, which is the last one this contract traded in. */
  readonly date: string;
}

/**
 * A contract picked from the live chain rather than written down: an OCC symbol names a
 * date, so a hardcoded one stops existing.
 *
 * The session comes from the snapshot's own daily bar rather than from today. Before the
 * open — and on any day the contract did not trade — today's window is empty and the bar
 * is the last one there was.
 */
async function aTradedContract(): Promise<TradedContract> {
  const { contracts } = await alpaca.optionChain({ underlying: 'AAPL', type: 'call', limit: 200 });
  for (const contract of contracts) {
    const bar = contract.db;
    if (bar !== undefined && bar.v > 0) {
      return { symbol: contract.S, date: easternClock.date(bar.t) };
    }
  }
  throw new Error('No AAPL call in the first page of the chain has a daily bar with volume; the option suite needs one.');
}

describe('the option chain', () => {
  it('answers with contracts on the underlying asked for, each taken apart', async () => {
    const { contracts } = await alpaca.optionChain({ underlying: 'AAPL', limit: 50 });

    expect(contracts.length).toBeGreaterThan(0);
    expect(contracts.every((contract) => contract.contract.underlying === 'AAPL')).toBe(true);
    expect(contracts.every((contract) => contract.contract.strike > 0 && contract.S === contract.contract.symbol)).toBe(true);
  });

  it('honours the filters rather than answering with the whole chain', async () => {
    const { contracts } = await alpaca.optionChain({ underlying: 'AAPL', type: 'put', strikeFrom: 150, strikeTo: 250, limit: 100 });

    expect(contracts.length).toBeGreaterThan(0);
    expect(contracts.every((contract) => contract.contract.type === 'put')).toBe(true);
    expect(contracts.every((contract) => contract.contract.strike >= 150 && contract.contract.strike <= 250)).toBe(true);
  });

  it('pages a chain too large for one answer, and the cursor moves', async () => {
    const first = await alpaca.optionChain({ underlying: 'SPY', limit: 100 });
    expect(first.resumeFrom).toBeDefined();

    const second = await alpaca.optionChain({ underlying: 'SPY', limit: 100, startAfter: first.resumeFrom });
    const overlap = new Set(first.contracts.map((contract) => contract.S));

    expect(second.contracts.length).toBeGreaterThan(0);
    expect(second.contracts.some((contract) => overlap.has(contract.S))).toBe(false);
  });

  it('solves the greeks for some contracts and not others, and says which', async () => {
    const { contracts } = await alpaca.optionChain({ underlying: 'AAPL', limit: 500 });
    const withGreeks = contracts.filter((contract) => contract.greeks !== undefined);

    expect(withGreeks.length).toBeGreaterThan(0);
    expect(withGreeks.length).toBeLessThan(contracts.length);
    expect(withGreeks.every((contract) => typeof contract.iv === 'number' && contract.greeks !== undefined && Number.isFinite(contract.greeks.delta))).toBe(true);
  });
});

describe('option history', () => {
  it('returns daily bars for a contract, in order and within the day', async () => {
    const { symbol, date } = await aTradedContract();
    const { bars } = await alpaca.optionBars({ symbol, from: easternClock.shiftDate(date, -30), to: date, multiplier: 1, timespan: 'day' });

    expect(bars.length).toBeGreaterThan(0);
    expect(bars.every((bar) => bar.S === symbol && bar.l <= bar.o && bar.o <= bar.h && bar.v > 0)).toBe(true);
    expect(bars.map((bar) => bar.t)).toStrictEqual([...bars.map((bar) => bar.t)].sort((left, right) => left - right));
  });

  it('returns prints with a condition and an exchange, and no trade id', async () => {
    const { symbol, date } = await aTradedContract();
    const { trades } = await alpaca.optionTrades({ symbol, date });

    expect(trades.length).toBeGreaterThan(0);
    expect(trades.every((trade) => trade.p > 0 && trade.s > 0 && trade.x.length > 0)).toBe(true);
    expect(trades.every((trade) => trade.c === undefined || trade.c.length === 1)).toBe(true);
    expect(Object.keys(trades[0])).not.toContain('i');
  });

  it("agrees with its own daily bar on the day's volume", async () => {
    const { symbol, date } = await aTradedContract();
    const [{ trades }, { bars }] = await Promise.all([
      alpaca.optionTrades({ symbol, date }),
      alpaca.optionBars({ symbol, from: date, to: date, multiplier: 1, timespan: 'day' }),
    ]);

    expect(bars).toHaveLength(1);
    expect(trades.reduce((total, trade) => total + trade.s, 0)).toBe(bars[0].v);
  });
});

describe('the condition and exchange dictionaries', () => {
  it('still names the option trade conditions the model documents', async () => {
    // A guard, not a description: `OptionTrade.c` explains what `f`, `g` and the cancel
    // codes mean, and this fails if Alpaca renames or drops one of them.
    const { conditions } = await alpaca.conditions({ market: 'options', tickType: 'trade' });

    expect(conditions.get('f')).toMatch(/Multi Leg/);
    expect(conditions.get('g')).toMatch(/Multi Leg/);
    // By OPRA mnemonic rather than by the word: Alpaca's description of `A` is
    // "CANC - Transaction previously reported", which never says cancelled.
    for (const [code, mnemonic] of [
      ['A', 'CANC'],
      ['C', 'CNCL'],
      ['E', 'CNCO'],
      ['G', 'CNOL'],
    ]) {
      expect(conditions.get(code)).toMatch(new RegExp(`^${mnemonic} `));
    }
  });

  it('names the stock trade conditions per tape', async () => {
    const { conditions } = await alpaca.conditions({ market: 'stocks', tickType: 'trade', tape: 'C' });

    expect(conditions.get('@')).toBe('Regular Sale');
    expect(conditions.get('I')).toMatch(/Odd Lot/);
  });

  it('names option quote conditions, including the ones that are not firm', async () => {
    const { conditions } = await alpaca.conditions({ market: 'options', tickType: 'quote' });

    expect(conditions.get('F')).toMatch(/Non-Firm/i);
    expect(conditions.get('T')).toMatch(/Halted/i);
  });

  it.each(['stocks', 'options'] as const)('names the %s exchanges a print can come from', async (market) => {
    const { exchanges } = await alpaca.exchanges({ market });

    expect(exchanges.size).toBeGreaterThan(10);
    expect([...exchanges.values()].every((name) => name.length > 0)).toBe(true);
  });

  it('refuses a stocks conditions request with no tape rather than sending one', async () => {
    await expect(alpaca.conditions({ market: 'stocks', tickType: 'trade' })).rejects.toThrow(/needs one/);
  });
});
