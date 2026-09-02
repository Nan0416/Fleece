import {
  AppError,
  ConflictError,
  ErrorCode,
  ForbiddenError,
  InternalServiceError,
  InvalidRequestError,
  LoggerFactory,
  NotFoundError,
  ServiceUnreachableError,
  UnauthenticatedError,
} from '@fleece/shared';

const logger = LoggerFactory.getLogger('HttpClient');

export interface HttpClientProps {
  /** e.g. `http://127.0.0.1:3100` */
  readonly baseUrl: string;
  readonly token?: string;
  readonly timeoutMs?: number;
}

export type Query = Record<string, string | number | boolean | undefined>;

function toAppError(status: number, message: string, errorCode: ErrorCode | undefined): AppError {
  switch (errorCode) {
    case 'INVALID_REQUEST':
      return new InvalidRequestError(message);
    case 'UNAUTHENTICATED':
      return new UnauthenticatedError(message);
    case 'FORBIDDEN':
      return new ForbiddenError(message);
    case 'NOT_FOUND':
      return new NotFoundError(message);
    case 'CONFLICT':
      return new ConflictError(message);
    default:
      return new InternalServiceError(`${message} (HTTP ${status})`);
  }
}

/**
 * Thin wrapper over `fetch` that rebuilds the service's typed errors on the caller's
 * side, so `catch (err) { if (err instanceof NotFoundError) ... }` works the same in
 * the CLI as it does inside the service.
 */
export class HttpClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;

  constructor(props: HttpClientProps) {
    this.baseUrl = props.baseUrl.replace(/\/+$/, '');
    this.token = props.token;
    this.timeoutMs = props.timeoutMs ?? 10_000;
  }

  async request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, options: { query?: Query; body?: unknown } = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (this.token !== undefined) {
      headers['authorization'] = `Bearer ${this.token}`;
    }

    // Without a deadline a hung service would leave the CLI blocked forever.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (err) {
      // Both branches are `ServiceUnreachableError` rather than `InternalServiceError`:
      // nothing was served, so blaming the service for an internal fault is wrong, and
      // callers want to say "start the service" rather than "the service has a bug".
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ServiceUnreachableError(`${method} ${path} timed out after ${this.timeoutMs}ms. The service at ${this.baseUrl} did not answer.`);
      }
      throw new ServiceUnreachableError(`${method} ${path} could not reach ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    const payload = text.length === 0 ? {} : this.parseJson(text, method, path);

    if (!response.ok) {
      const record: Record<string, unknown> = typeof payload === 'object' && payload !== null ? { ...payload } : {};
      const message = typeof record['error'] === 'string' ? record['error'] : `${method} ${path} failed`;
      const errorCode = typeof record['errorCode'] === 'string' ? record['errorCode'] : undefined;
      logger.debug(`${method} ${path} -> ${response.status} ${message}`);
      throw toAppError(response.status, message, this.toErrorCode(errorCode));
    }

    return this.narrow<T>(payload);
  }

  private parseJson(text: string, method: string, path: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      throw new InternalServiceError(`${method} ${path} returned a response that is not JSON.`);
    }
  }

  /**
   * The response shape is the API contract; the service is the only writer and both
   * sides compile against the same interfaces, so this is the single narrowing point
   * rather than re-validating every field on arrival.
   */
  private narrow<T>(payload: unknown): T {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the one sanctioned cast: this is the client/server type boundary.
    return payload as T;
  }

  private toErrorCode(value: string | undefined): ErrorCode | undefined {
    const codes: ReadonlyArray<ErrorCode> = ['INVALID_REQUEST', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'INTERNAL'];
    return codes.find((code) => code === value);
  }
}
