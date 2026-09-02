import { InternalServiceError, LoggerFactory, ServiceUnreachableError } from '@fleece/shared';
import { Dividend, DividendFrequency, DividendType, ListDividendsInput, ListDividendsOutput, ListStockSplitsInput, ListStockSplitsOutput, MarketDataClient } from './models';

const logger = LoggerFactory.getLogger('PolygonClient');

const DEFAULT_BASE_URL = 'https://api.polygon.io';

/** Polygon caps a page at 1000; asking for the maximum keeps the paging loop short. */
const PAGE_LIMIT = 1000;

/** A stop so a broken cursor cannot spin forever against a paid API. */
const MAX_PAGES = 50;

interface PolygonStockSplit {
  readonly execution_date: string;
  readonly split_from: number;
  readonly split_to: number;
  readonly ticker: string;
}

interface PolygonDividend {
  readonly cash_amount: number;
  readonly currency: string;
  readonly dividend_type: string;
  readonly ticker: string;
  readonly frequency: number;
  readonly declaration_date: string;
  readonly ex_dividend_date: string;
  readonly record_date: string;
  readonly pay_date: string;
}

interface PolygonPage<T> {
  readonly results?: ReadonlyArray<T>;
  readonly status?: string;
  readonly next_url?: string;
}

export interface PolygonClientProps {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

export class PolygonClient implements MarketDataClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly props: PolygonClientProps) {
    this.baseUrl = props.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = props.timeoutMs ?? 15_000;
  }

  async listDividends(input: ListDividendsInput): Promise<ListDividendsOutput> {
    const query = new URLSearchParams({
      ticker: input.symbol,
      [`${input.dateType}.gte`]: input.fromDate,
      [`${input.dateType}.lte`]: input.toDate,
      sort: 'pay_date',
      order: 'asc',
      limit: String(PAGE_LIMIT),
    });

    const raw = await this.collectPages<PolygonDividend>('/v3/reference/dividends', query);
    return { dividends: raw.map((entry) => this.toDividend(entry)) };
  }

  async listStockSplits(input: ListStockSplitsInput): Promise<ListStockSplitsOutput> {
    const query = new URLSearchParams({
      ticker: input.symbol,
      sort: 'execution_date',
      order: 'asc',
      limit: String(PAGE_LIMIT),
    });
    if (input.executionDate !== undefined) {
      query.set('execution_date', input.executionDate);
    }

    const raw = await this.collectPages<PolygonStockSplit>('/v3/reference/splits', query);
    return {
      splits: raw.map((entry) => ({
        ticker: entry.ticker,
        executionDate: entry.execution_date,
        splitFrom: entry.split_from,
        splitTo: entry.split_to,
      })),
    };
  }

  /**
   * Follows Polygon's `next_url` cursor.
   *
   * `next_url` comes back as a full URL that already carries the original filters but
   * *not* the API key, so the key is re-attached to each page. The legacy client split
   * the URL on `cursor=` and rebuilt the request by hand, which broke whenever a query
   * parameter happened to sort after the cursor.
   */
  private async collectPages<T>(path: string, query: URLSearchParams): Promise<ReadonlyArray<T>> {
    const results: T[] = [];
    let url: string | undefined = `${this.baseUrl}${path}?${query.toString()}`;

    for (let page = 0; url !== undefined; page += 1) {
      if (page >= MAX_PAGES) {
        throw new InternalServiceError(`Polygon returned more than ${MAX_PAGES} pages for ${path}; refusing to keep paging.`);
      }
      const body: PolygonPage<T> = await this.get<PolygonPage<T>>(url);
      for (const entry of body.results ?? []) {
        results.push(entry);
      }
      url = body.next_url === undefined ? undefined : this.withApiKey(body.next_url);
    }

    return results;
  }

  private withApiKey(rawUrl: string): string {
    const url = new URL(rawUrl);
    url.searchParams.set('apiKey', this.props.apiKey);
    return url.toString();
  }

  private async get<T>(rawUrl: string): Promise<T> {
    const url = this.withApiKey(rawUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
      const text = await response.text();

      if (!response.ok) {
        // The key is in the query string, so the URL must never reach a log.
        logger.warn(`Polygon returned ${response.status} for ${new URL(url).pathname}: ${text.slice(0, 300)}`);
        throw new InternalServiceError(`Polygon returned ${response.status} for ${new URL(url).pathname}.`);
      }

      try {
        return JSON.parse(text);
      } catch {
        throw new InternalServiceError(`Polygon returned a non-JSON response for ${new URL(url).pathname}.`);
      }
    } catch (err) {
      if (err instanceof InternalServiceError) {
        throw err;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ServiceUnreachableError(`Polygon did not answer ${new URL(url).pathname} within ${this.timeoutMs}ms.`);
      }
      throw new ServiceUnreachableError(`Polygon could not be reached: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private toDividend(entry: PolygonDividend): Dividend {
    return {
      ticker: entry.ticker,
      cashAmount: entry.cash_amount,
      currency: entry.currency,
      dividendType: this.toDividendType(entry.dividend_type),
      frequency: this.toFrequency(entry.frequency),
      declarationDate: entry.declaration_date,
      exDividendDate: entry.ex_dividend_date,
      recordDate: entry.record_date,
      payDate: entry.pay_date,
    };
  }

  private toDividendType(value: string): DividendType {
    if (value === 'CD' || value === 'SC' || value === 'LT' || value === 'ST') {
      return value;
    }
    // Polygon adding a type is not a reason to drop a dividend the account is owed.
    logger.warn(`Polygon reported an unrecognised dividend type "${value}"; treating it as a special dividend.`);
    return 'SC';
  }

  private toFrequency(value: number): DividendFrequency {
    if (value === 0 || value === 1 || value === 2 || value === 4 || value === 12) {
      return value;
    }
    logger.warn(`Polygon reported an unrecognised dividend frequency ${value}; treating it as a one-off.`);
    return 0;
  }
}
