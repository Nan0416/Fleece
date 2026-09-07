export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** An `undefined` value drops the parameter rather than sending the string "undefined". */
export interface Query {
  readonly [key: string]: string | number | boolean | undefined;
}

export interface HttpHeaders {
  readonly [key: string]: string;
}

interface BaseHttpRequest {
  readonly url: string;
  readonly method: HttpMethod;
  readonly query?: Query;
  readonly headers?: HttpHeaders;
  /** Takes precedence over `timeoutMs`: a caller that brings a signal owns the deadline. */
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Overrides the client's own base URL for this one request. */
  readonly baseUrl?: string;
}

export interface HttpGetRequest extends BaseHttpRequest {
  readonly method: 'GET';
}

export interface HttpPostRequest extends BaseHttpRequest {
  readonly method: 'POST';
  readonly body?: unknown;
}

export interface HttpPutRequest extends BaseHttpRequest {
  readonly method: 'PUT';
  readonly body?: unknown;
}

export interface HttpPatchRequest extends BaseHttpRequest {
  readonly method: 'PATCH';
  readonly body?: unknown;
}

export interface HttpDeleteRequest extends BaseHttpRequest {
  readonly method: 'DELETE';
}

export type HttpRequest = HttpGetRequest | HttpPostRequest | HttpPutRequest | HttpPatchRequest | HttpDeleteRequest;

export interface HttpResponse {
  readonly status: number;
  readonly headers: HttpHeaders;
  /**
   * Parsed when the response says JSON, the raw text when it does not, `undefined` when
   * empty. Deliberately not generic: a type parameter here would promise a shape rather
   * than establish one, and for the decimals this system carries as strings it would be
   * promising something untrue. The caller validates.
   */
  readonly body: unknown;
}

/**
 * The seam between a client and whatever sends the bytes, so swapping fetch for another
 * transport is one new implementation rather than an edit to every caller.
 *
 * Two rules make an implementation substitutable. A status the server chose is a result,
 * not a failure — 4xx and 5xx come back rather than throw, because what a 404 means is
 * the caller's to decide. Every failure to get an answer at all throws
 * `ServiceUnreachableError`, so a transport's own error types never reach a caller.
 */
export interface HttpClient {
  send(request: HttpRequest): Promise<HttpResponse>;
}
