import type { HttpClient, HttpRequest, HttpResponse } from '@fleece/shared';

import { FakeHttpClient, type RecordedRequest } from '../fake-http-client';

export { FakeHttpClient };

export function aggregates(...bars: ReadonlyArray<{ t: number; c?: number }>): unknown {
  return { status: 'OK', results: bars.map((bar) => ({ v: 100, vw: 1, o: 1, c: bar.c ?? 2, h: 3, l: 0.5, t: bar.t })) };
}

// `sequence_number` is derived from the timestamp so that the same logical trade keeps
// its identity across two pages, which is what the paging de-duplication turns on.
export function trades(...entries: ReadonlyArray<{ ms: number; price: number }>): unknown {
  return {
    status: 'OK',
    results: entries.map((entry, index) => ({
      participant_timestamp: entry.ms * 1_000_000,
      sip_timestamp: entry.ms * 1_000_000,
      sequence_number: entry.ms,
      id: `t${index}`,
      exchange: 4,
      size: 10,
      conditions: [12],
      price: entry.price,
      tape: 3,
    })),
  };
}

export function quotes(...entries: ReadonlyArray<{ ms: number; bid: number; ask: number }>): unknown {
  return {
    results: entries.map((entry) => ({
      participant_timestamp: entry.ms * 1_000_000,
      sip_timestamp: entry.ms * 1_000_000,
      ask_exchange: 11,
      ask_price: entry.ask,
      ask_size: 2,
      bid_exchange: 12,
      bid_price: entry.bid,
      bid_size: 3,
      sequence_number: entry.ms,
      tape: 3,
    })),
  };
}

export function splits(...entries: ReadonlyArray<{ date: string; from: number; to: number }>): unknown {
  return { status: 'OK', results: entries.map((entry) => ({ execution_date: entry.date, split_from: entry.from, split_to: entry.to, ticker: 'AAPL' })) };
}

export function snapshot(ticker: string, updatedMs: number): unknown {
  return {
    ticker,
    todaysChange: 1,
    todaysChangePerc: 0.4,
    updated: updatedMs * 1_000_000,
    prevDay: { o: 1, h: 2, l: 0.5, c: 1.5, v: 10, vw: 1 },
    day: { o: 2, h: 3, l: 1.5, c: 2.5, v: 20, vw: 2 },
    lastQuote: { p: 2.4, s: 1, P: 2.6, S: 2, t: updatedMs * 1_000_000 },
    lastTrade: { c: [12], i: 99, p: 2.5, s: 5, t: updatedMs * 1_000_000, x: 4, z: 3 },
    min: { av: 100, o: 2.2, h: 2.7, l: 2.1, c: 2.5, v: 15, vw: 2.3 },
  };
}

/**
 * Answers `/v3/trades` the way Polygon does, rather than replaying a queue: ascending,
 * honouring `timestamp.gte`, `timestamp.lt` and `limit`.
 *
 * Timestamps are held as bigint and sent as `Number`, which is what makes this faithful
 * — the value on the wire is the rounded double `JSON.parse` would produce, while the
 * filtering uses the exact one the provider holds. The paging cursor's whole difficulty
 * is that gap, and a fake that replays fixed pages cannot show it.
 */
export class FakeTradeFeed implements HttpClient {
  readonly requests: RecordedRequest[] = [];

  constructor(private readonly ticks: ReadonlyArray<{ sip: bigint; price: number }>) {}

  async send(request: HttpRequest): Promise<HttpResponse> {
    const query: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) {
        query[key] = String(value);
      }
    }
    this.requests.push({ url: request.url, query });

    const gte = BigInt(query['timestamp.gte'] ?? '0');
    const lt = BigInt(query['timestamp.lt'] ?? '0');
    const limit = Number(query['limit'] ?? '0');
    // Numbered once, from its position in the feed, so a trade keeps its identity
    // wherever it lands. Numbering by position in the *page* gave the same trade a
    // different sequence number on every page, which is the client's de-duplication key
    // — the fake would have reported duplicates as distinct trades and blamed the client.
    const matching = this.ticks
      .map((tick, sequence) => ({ ...tick, sequence }))
      .filter((tick) => tick.sip >= gte && tick.sip < lt)
      .slice(0, limit);

    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: {
        status: 'OK',
        results: matching.map((tick) => ({
          participant_timestamp: Number(tick.sip),
          sip_timestamp: Number(tick.sip),
          sequence_number: tick.sequence,
          id: `t${tick.price}`,
          exchange: 4,
          size: 10,
          conditions: [12],
          price: tick.price,
          tape: 3,
        })),
      },
    };
  }
}

/**
 * Trades far enough apart that the cursor moves between pages, which is the ordinary
 * shape of a window and the one this client spends its time in.
 *
 * The gap has to clear `CURSOR_BACKOFF_NS`, or every trade lands in the backoff window
 * and the walk never leaves its first timestamp.
 */
export function spacedTicks(startMs: number, count: number, gapNs: number = 5_000): Array<{ sip: bigint; price: number }> {
  const base = BigInt(startMs) * BigInt(1_000_000);
  return Array.from({ length: count }, (_, index) => ({ sip: base + BigInt(index * gapNs), price: 100 + index }));
}

/**
 * Trades on one timestamp, as the opening cross prints them — the shape that makes a
 * small page unable to step past them.
 *
 * A nanosecond apart would do as well: at this magnitude a double's step is 256ns, so
 * anything closer than that arrives as the same wire timestamp anyway.
 */
export function tiedTicks(startMs: number, count: number): Array<{ sip: bigint; price: number }> {
  const base = BigInt(startMs) * BigInt(1_000_000);
  return Array.from({ length: count }, (_, index) => ({ sip: base, price: 100 + index }));
}
