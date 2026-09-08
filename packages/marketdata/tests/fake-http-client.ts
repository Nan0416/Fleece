import type { HttpClient, HttpRequest, HttpResponse } from '@fleece/utilities';

export interface RecordedRequest {
  readonly url: string;
  readonly query: Record<string, string>;
  /** Set only when a request overrides the client's own base URL. */
  readonly baseUrl?: string;
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
    this.requests.push({ url: request.url, query, baseUrl: request.baseUrl });

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
