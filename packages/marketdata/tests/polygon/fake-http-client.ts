import type { HttpClient, HttpRequest, HttpResponse } from '@fleece/shared';

export interface RecordedRequest {
  readonly url: string;
  readonly query: Record<string, string>;
}

/**
 * An `HttpClient` that answers from a queue and keeps what it was asked.
 *
 * A fake rather than a mock: the assertions below are about the request Polygon would
 * have received — its path, its cursor, its window — which is the part of this client
 * that can be wrong without any test noticing.
 */
export class FakeHttpClient implements HttpClient {
  readonly requests: RecordedRequest[] = [];
  private readonly bodies: unknown[] = [];
  private status = 200;

  /** Queued one per call; the last repeats once the queue empties. */
  reply(...bodies: ReadonlyArray<unknown>): this {
    this.bodies.push(...bodies);
    return this;
  }

  replyWithStatus(status: number, body: unknown): this {
    this.status = status;
    this.bodies.push(body);
    return this;
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    const query: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) {
        query[key] = String(value);
      }
    }
    this.requests.push({ url: request.url, query });

    if (this.bodies.length === 0) {
      throw new Error(`FakeHttpClient has no reply queued for ${request.url}`);
    }
    const body = this.bodies.length > 1 ? this.bodies.shift() : this.bodies[0];
    return { status: this.status, headers: { 'content-type': 'application/json' }, body };
  }

  get lastRequest(): RecordedRequest {
    return this.requests[this.requests.length - 1];
  }
}

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
