/** Alpaca's multi-symbol shapes: a map keyed by symbol, plus an opaque page token. */

export function bars(symbol: string, ...entries: ReadonlyArray<{ t: string; c?: number }>): unknown {
  return { bars: { [symbol]: entries.map((entry) => ({ t: entry.t, o: 1, h: 3, l: 0.5, c: entry.c ?? 2, v: 100, n: 10, vw: 1.5 })) } };
}

export function trades(symbol: string, ...entries: ReadonlyArray<{ t: string; p: number; i?: number }>): unknown {
  return { trades: { [symbol]: entries.map((entry, index) => ({ t: entry.t, x: 'Q', p: entry.p, s: 10, c: ['@'], i: entry.i ?? index, z: 'C' })) } };
}

export function quotes(symbol: string, ...entries: ReadonlyArray<{ t: string; bid: number; ask: number }>): unknown {
  return { quotes: { [symbol]: entries.map((entry) => ({ t: entry.t, ax: 'Q', ap: entry.ask, as: 2, bx: 'U', bp: entry.bid, bs: 3, c: ['R'], z: 'C' })) } };
}

export function withPageToken(body: unknown, token: string | null): unknown {
  return { ...(body as object), next_page_token: token };
}

export function calendar(...days: ReadonlyArray<{ date: string; open?: string; close?: string; sessionOpen?: string; sessionClose?: string }>): unknown {
  return days.map((day) => ({
    date: day.date,
    open: day.open ?? '09:30',
    close: day.close ?? '16:00',
    session_open: day.sessionOpen ?? '0400',
    session_close: day.sessionClose ?? '2000',
    settlement_date: day.date,
  }));
}

export function corporateActions(actions: {
  forward?: ReadonlyArray<{ date: string; from: number; to: number }>;
  reverse?: ReadonlyArray<{ date: string; from: number; to: number }>;
}): unknown {
  const split = (symbol: string) => (entry: { date: string; from: number; to: number }) => ({
    symbol,
    ex_date: entry.date,
    old_rate: entry.from,
    new_rate: entry.to,
    record_date: entry.date,
    payable_date: entry.date,
    process_date: entry.date,
  });
  return {
    corporate_actions: {
      ...(actions.forward === undefined ? {} : { forward_splits: actions.forward.map(split('AAPL')) }),
      ...(actions.reverse === undefined ? {} : { reverse_splits: actions.reverse.map(split('AAPL')) }),
    },
  };
}

export function optionBars(symbol: string, ...entries: ReadonlyArray<{ t: string; c?: number }>): unknown {
  return { bars: { [symbol]: entries.map((entry) => ({ t: entry.t, o: 1, h: 3, l: 0.5, c: entry.c ?? 2, v: 100, n: 10, vw: 1.5 })) } };
}

/**
 * An option print: no trade id, no tape, and one condition character rather than a list.
 *
 * `c` is taken as given — including `null` and absent, which are the two shapes a print
 * with no condition arrives in and which a fixture that always supplies one cannot reach.
 */
export function optionTrades(symbol: string, ...entries: ReadonlyArray<{ t: string; p: number; c?: string | null; s?: number }>): unknown {
  return {
    trades: {
      [symbol]: entries.map((entry) => ({ t: entry.t, x: 'C', p: entry.p, s: entry.s ?? 1, ...('c' in entry ? { c: entry.c } : { c: 'f' }) })),
    },
  };
}

export interface FakeContract {
  readonly symbol: string;
  readonly price?: number;
  readonly greeks?: boolean;
  readonly prevDailyBar?: boolean;
}

export function optionSnapshots(...contracts: ReadonlyArray<FakeContract>): unknown {
  const snapshots: Record<string, unknown> = {};
  for (const contract of contracts) {
    const price = contract.price ?? 1.25;
    snapshots[contract.symbol] = {
      dailyBar: { t: '2024-12-19T05:00:00Z', o: price, h: price, l: price, c: price, v: 5, n: 2, vw: price },
      minuteBar: { t: '2024-12-19T15:30:00Z', o: price, h: price, l: price, c: price, v: 1, n: 1, vw: price },
      ...(contract.prevDailyBar === false ? {} : { prevDailyBar: { t: '2024-12-18T05:00:00Z', o: price, h: price, l: price, c: price, v: 3, n: 1, vw: price } }),
      latestTrade: { t: '2024-12-19T15:34:44.382785953Z', x: 'C', p: price, s: 1, c: 'g' },
      latestQuote: { t: '2024-12-19T15:34:45.1Z', ax: 'S', ap: price + 0.1, as: 13, bx: 'S', bp: price - 0.1, bs: 11, c: 'A' },
      ...(contract.greeks === false ? {} : { greeks: { delta: 0.5, gamma: 0.02, theta: -0.03, vega: 0.04, rho: 0.01 }, impliedVolatility: 0.69 }),
    };
  }
  return { snapshots };
}

export function conditionDictionary(entries: Record<string, string>): unknown {
  return entries;
}
