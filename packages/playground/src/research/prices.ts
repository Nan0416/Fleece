/**
 * One session's minute closes for an underlying and a set of its contracts.
 */
import { regularHoursOnly, type Bar, type OccSymbol } from '@fleece/marketdata';

import { cached, marketDataClient, settled } from './client';

export interface OptionPrice {
  readonly occSymbol: OccSymbol;
  /** The minute bar's close, per share. A contract cost this times its multiplier. */
  readonly price: number;
  /**
   * The minute that close printed in, which is at or before the enclosing
   * `MarketMinute.timestamp` — the only way to tell a fresh price from a stale one.
   */
  readonly at: number;
}

/**
 * The market at one minute: what the underlying closed that minute at, and what each
 * contract did.
 *
 * `stockSpotPrice` is absent for a minute the underlying itself did not print in, which
 * happens even in liquid names.
 *
 * `optionPrices` holds every contract that has printed *by* this minute, at its last
 * close, because an option chain is mostly silent minute to minute and a strategy needs
 * its legs quoted at the same instant. A price is therefore not necessarily one anyone
 * traded at this minute — `at` says which minute it came from. A contract absent from the
 * map has not printed at all yet today.
 */
export interface MarketMinute {
  readonly timestamp: number;
  readonly stockSpotPrice?: number;
  /** Keyed by OCC contract symbol. */
  readonly optionPrices: ReadonlyMap<string, OptionPrice>;
}

/** Cached shape: JSON survives arrays and plain objects, not a `Map`. */
interface RawSession {
  readonly stock: ReadonlyArray<Bar>;
  readonly options: Record<string, ReadonlyArray<Bar>>;
}

/**
 * Regular trading hours only, and unadjusted: a split re-issues an option rather than
 * restating it, so adjusting the underlying's prints would put the two on different
 * footings within the same minute.
 */
export async function loadTradingMinuteBars(date: string, underlying: string, contracts: ReadonlyArray<OccSymbol>): Promise<ReadonlyArray<MarketMinute>> {
  const ticker = underlying.trim().toUpperCase();
  const bySymbol = new Map(contracts.map((contract) => [contract.symbol, contract]));
  const symbols = [...bySymbol.keys()].sort();

  const raw = await cached(`session-${date}-${ticker}-${fingerprint(symbols)}`, settled(date), async () => await session(date, ticker, symbols));

  const minutes = new Map<number, Map<string, OptionPrice>>();
  const spots = new Map<number, number>();
  for (const bar of raw.stock) {
    spots.set(bar.t, bar.c);
    minutes.set(bar.t, new Map());
  }
  for (const [symbol, bars] of Object.entries(raw.options)) {
    const occSymbol = bySymbol.get(symbol);
    if (occSymbol === undefined) {
      continue;
    }
    for (const bar of bars) {
      let minute = minutes.get(bar.t);
      if (minute === undefined) {
        minute = new Map();
        minutes.set(bar.t, minute);
      }
      minute.set(symbol, { occSymbol, price: bar.c, at: bar.t });
    }
  }

  const timestamps = [...minutes.keys()].sort((left, right) => left - right);
  const carried = new Map<string, OptionPrice>();
  return timestamps.map((timestamp) => {
    for (const [symbol, price] of minutes.get(timestamp) ?? []) {
      carried.set(symbol, price);
    }
    // Copied per minute: the running map keeps changing, and a caller holding an earlier
    // minute must not find its prices quietly updated to a later one's.
    return { timestamp, stockSpotPrice: spots.get(timestamp), optionPrices: new Map(carried) };
  });
}

/**
 * The last minute at or before `timestamp`, which is what "the price then" means for a
 * series that only has a row where something traded. `undefined` before the first one:
 * there is no price yet, and the opening print is not it.
 */
export function findPrice(timestamp: number, prices: ReadonlyArray<MarketMinute>): MarketMinute | undefined {
  let low = 0;
  let high = prices.length - 1;
  let found: MarketMinute | undefined;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (prices[mid].timestamp <= timestamp) {
      found = prices[mid];
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

async function session(date: string, ticker: string, symbols: ReadonlyArray<string>): Promise<RawSession> {
  const client = marketDataClient();
  const { bars: stock } = await client.minuteBars({ symbol: ticker, from: date, to: date });
  const { bars } = await client.optionBarsBySymbol({ symbols, from: date, to: date, multiplier: 1, timespan: 'minute' });

  const options: Record<string, ReadonlyArray<Bar>> = {};
  for (const [symbol, contractBars] of bars) {
    // The option endpoints do no session filtering — that table is the equity calendar —
    // so the stray print outside 09:30-16:00 is dropped here rather than by the client.
    options[symbol] = regularHoursOnly([...contractBars]);
  }
  return { stock: [...stock], options };
}

/** Short, stable and order-independent, so the same set of contracts hits the same file. */
function fingerprint(symbols: ReadonlyArray<string>): string {
  let hash = 0x811c9dc5;
  for (const character of symbols.join(',')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${symbols.length}x${hash.toString(36)}`;
}
