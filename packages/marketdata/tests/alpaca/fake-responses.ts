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
