import { easternClock } from '@fleece/shared';

import { DataProviderError, type Bar, type MarketSession, type OccSymbol, type OptionSnapshot, type OptionTrade, type Quote, type StockSplit, type Trade } from '../data-models';

import type { AlpacaBar, AlpacaCalendarDay, AlpacaOptionQuote, AlpacaOptionSnapshot, AlpacaOptionTrade, AlpacaQuote, AlpacaSplit, AlpacaTrade } from './alpaca-rest-models';

const SOURCE = 'Alpaca';

/**
 * Alpaca timestamps in RFC 3339 rather than epoch nanoseconds, which is the one thing
 * that makes it easier to page than Polygon: the value survives JSON intact, so there is
 * no rounding for a cursor to work around.
 *
 * Checked rather than assumed — `Date.parse` answers `NaN` for anything it cannot read,
 * and a NaN timestamp would sort a trade nowhere and read as no time at all.
 */
export function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new DataProviderError(SOURCE, `sent ${JSON.stringify(value)} where an RFC 3339 timestamp was expected.`);
  }
  return parsed;
}

export function normalizeSplit(split: AlpacaSplit): StockSplit {
  return { ticker: split.symbol, executionDate: split.ex_date, splitFrom: split.old_rate, splitTo: split.new_rate };
}

export function normalizeBar(symbol: string, bar: AlpacaBar): Bar {
  return { S: symbol, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v, t: parseTimestamp(bar.t) };
}

export function normalizeTrade(symbol: string, trade: AlpacaTrade): Trade {
  return { S: symbol, i: trade.i, x: trade.x, p: trade.p, s: trade.s, t: parseTimestamp(trade.t), c: trade.c === undefined ? undefined : [...trade.c], z: trade.z };
}

export function normalizeQuote(symbol: string, quote: AlpacaQuote): Quote {
  return {
    S: symbol,
    bx: quote.bx,
    bp: quote.bp,
    bs: quote.bs,
    ax: quote.ax,
    ap: quote.ap,
    as: quote.as,
    t: parseTimestamp(quote.t),
    c: quote.c === undefined ? undefined : [...quote.c],
    z: quote.z,
  };
}

/**
 * The calendar states its regular hours as `HH:mm` and its extended session as `HHmm`,
 * so both are turned into instants here rather than left for a caller to guess at.
 */
export function normalizeSession(day: AlpacaCalendarDay): MarketSession {
  return {
    date: day.date,
    open: day.open,
    close: day.close,
    openAt: easternClock.timestamp(day.date, `${day.open}:00`),
    closeAt: easternClock.timestamp(day.date, `${day.close}:00`),
    preMarketOpenAt: easternClock.timestamp(day.date, compactTime(day.session_open)),
    afterMarketCloseAt: easternClock.timestamp(day.date, compactTime(day.session_close)),
  };
}

function compactTime(value: string): string {
  if (!/^\d{4}$/.test(value)) {
    throw new DataProviderError(SOURCE, `sent ${JSON.stringify(value)} where a four-digit HHmm session time was expected.`);
  }
  return `${value.slice(0, 2)}:${value.slice(2)}:00`;
}

export function normalizeOptionTrade(symbol: string, trade: AlpacaOptionTrade): OptionTrade {
  return { S: symbol, x: trade.x, p: trade.p, s: trade.s, t: parseTimestamp(trade.t), c: condition(trade.c) };
}

export function normalizeOptionQuote(symbol: string, quote: AlpacaOptionQuote): Quote {
  return { S: symbol, bx: quote.bx, bp: quote.bp, bs: quote.bs, ax: quote.ax, ap: quote.ap, as: quote.as, t: parseTimestamp(quote.t), c: condition(quote.c) };
}

export function normalizeOptionSnapshot(contract: OccSymbol, snapshot: AlpacaOptionSnapshot): OptionSnapshot {
  const symbol = contract.symbol;
  return {
    S: symbol,
    f: 'a',
    contract,
    lt: present(snapshot.latestTrade) ? normalizeOptionTrade(symbol, snapshot.latestTrade) : undefined,
    lq: present(snapshot.latestQuote) ? normalizeOptionQuote(symbol, snapshot.latestQuote) : undefined,
    mb: present(snapshot.minuteBar) ? normalizeBar(symbol, snapshot.minuteBar) : undefined,
    db: present(snapshot.dailyBar) ? normalizeBar(symbol, snapshot.dailyBar) : undefined,
    pdb: present(snapshot.prevDailyBar) ? normalizeBar(symbol, snapshot.prevDailyBar) : undefined,
    greeks: present(snapshot.greeks) ? { ...snapshot.greeks } : undefined,
    iv: present(snapshot.impliedVolatility) ? snapshot.impliedVolatility : undefined,
  };
}

/**
 * OPRA sends one condition character; the model holds an array so that the equity and
 * option shapes are the same thing to read.
 */
function condition(value: string | undefined): string[] | undefined {
  return value === undefined ? undefined : [value];
}

function present<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
