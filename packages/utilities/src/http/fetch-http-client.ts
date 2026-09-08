import { InternalServiceError, ServiceUnreachableError } from '../errors';
import { LoggerFactory } from '../logger';

import type { HttpClient, HttpHeaders, HttpPatchRequest, HttpPostRequest, HttpPutRequest, HttpRequest, HttpResponse, Query } from './http-client';

const logger = LoggerFactory.getLogger('FetchHttpClient');

const JSON_CONTENT_TYPE = 'application/json';

/**
 * Query parameters whose value never appears in a log or an error message.
 *
 * Polygon carries its key in the query string, so a URL built here is a credential.
 * Guideline 35 says never to log one — and the trap is that the obvious places are not
 * the only ones: an error message becomes a log line the moment a caller catches it and
 * logs the stack, which is exactly what the dividend job does with a per-symbol failure.
 */
const SECRET_QUERY_PARAMS: ReadonlySet<string> = new Set(['apikey', 'api_key', 'key', 'token', 'access_token', 'secret', 'client_secret', 'password', 'signature', 'sig']);

const REDACTED = 'REDACTED';

export interface FetchHttpClientProps {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

export class FetchHttpClient implements HttpClient {
  private readonly baseUrl: string;
  private readonly timeoutMs?: number;

  constructor(props: FetchHttpClientProps = {}) {
    this.baseUrl = stripTrailingSlash(props.baseUrl ?? '');
    this.timeoutMs = props.timeoutMs;
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    const url = this.buildUrl(request);
    const timeoutMs = request.timeoutMs ?? this.timeoutMs;
    const body = hasBody(request) ? request.body : undefined;

    const init: RequestInit = {
      method: request.method,
      redirect: 'follow',
      headers: buildHeaders(request.headers, body !== undefined),
      signal: request.signal ?? timeoutSignal(timeoutMs),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    logger.debug(`${request.method} ${redact(url)}`);

    let response: Response;
    let text: string;
    try {
      response = await fetch(url, init);
      text = await response.text();
    } catch (err) {
      throw unreachable(request.method, redact(url), timeoutMs, err);
    }

    return {
      status: response.status,
      headers: collectHeaders(response.headers),
      body: parseBody(response.headers.get('content-type'), text, request.method, redact(url)),
    };
  }

  private buildUrl(request: HttpRequest): string {
    const baseUrl = request.baseUrl === undefined ? this.baseUrl : stripTrailingSlash(request.baseUrl);
    const url = `${baseUrl}${request.url}`;
    const query = buildQuery(request.query);
    return query.length === 0 ? url : `${url}${url.includes('?') ? '&' : '?'}${query}`;
  }
}

function hasBody(request: HttpRequest): request is HttpPostRequest | HttpPutRequest | HttpPatchRequest {
  return request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH';
}

/** Replaces the value of any credential-bearing query parameter, leaving the rest legible. */
export function redact(url: string): string {
  const start = url.indexOf('?');
  if (start === -1) {
    return url;
  }
  const params = new URLSearchParams(url.slice(start + 1));
  let redacted = false;
  for (const key of [...params.keys()]) {
    if (SECRET_QUERY_PARAMS.has(key.toLowerCase())) {
      params.set(key, REDACTED);
      redacted = true;
    }
  }
  return redacted ? `${url.slice(0, start)}?${params.toString()}` : url;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function buildQuery(query: Query | undefined): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }
  return params.toString();
}

function buildHeaders(headers: HttpHeaders | undefined, hasJsonBody: boolean): Record<string, string> {
  const result: Record<string, string> = hasJsonBody ? { 'content-type': JSON_CONTENT_TYPE } : {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    result[key] = value;
  }
  return result;
}

function collectHeaders(headers: globalThis.Headers): HttpHeaders {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

/** `AbortSignal.timeout` rather than a timer, so nothing is left to clear on the way out. */
function timeoutSignal(timeoutMs: number | undefined): AbortSignal | undefined {
  return typeof timeoutMs === 'number' && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
}

function parseBody(contentType: string | null, text: string, method: string, url: string): unknown {
  if (text.length === 0) {
    return undefined;
  }
  if (contentType === null || !contentType.includes(JSON_CONTENT_TYPE)) {
    return text;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new InternalServiceError(`${method} ${url} announced ${JSON_CONTENT_TYPE} and returned something that is not JSON.`);
  }
}

function unreachable(method: string, url: string, timeoutMs: number | undefined, err: unknown): ServiceUnreachableError {
  switch (abortName(err)) {
    case 'TimeoutError':
      return new ServiceUnreachableError(`${method} ${url} timed out after ${timeoutMs}ms.`);
    case 'AbortError':
      return new ServiceUnreachableError(`${method} ${url} was aborted before it answered.`);
    default:
      return new ServiceUnreachableError(`${method} ${url} could not be reached: ${describeCause(err)}`);
  }
}

/**
 * Walks the cause chain rather than reading one name, because an aborted `fetch` reports
 * itself two different ways: a deadline throws a DOMException directly, while a refused
 * connection throws a TypeError carrying the real reason as its cause. Neither is caught
 * by `instanceof Error` in Node — DOMException does not extend it.
 */
function abortName(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 4; depth += 1) {
    const name = stringField(current, 'name');
    if (name === 'TimeoutError' || name === 'AbortError') {
      return name;
    }
    current = field(current, 'cause');
  }
  return undefined;
}

/** `fetch` fails with a bare "fetch failed"; what actually happened is on the cause. */
function describeCause(err: unknown): string {
  const message = stringField(err, 'message');
  if (message === undefined) {
    return String(err);
  }
  const causeMessage = stringField(field(err, 'cause'), 'message');
  return causeMessage === undefined ? message : `${message}: ${causeMessage}`;
}

function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null && name in value ? Reflect.get(value, name) : undefined;
}

function stringField(value: unknown, name: string): string | undefined {
  const found = field(value, name);
  return typeof found === 'string' ? found : undefined;
}
