import { FetchHttpClient, InvalidRequestError, LoggerFactory, type HttpClient, type HttpHeaders, type Query } from '@fleece/shared';

import {
  DataProviderError,
  type AlpacaStockRestClient,
  type BarsRequest,
  type BarsResponse,
  type DailyBarsRequest,
  type MarketHoursRequest,
  type MarketHoursResponse,
  type MinuteBarsRequest,
  type QuotesRequest,
  type QuotesResponse,
  type Timespan,
  type TradesRequest,
  type TradesResponse,
} from '../equity-data-models';
import { endOfDay, regularHoursOnly, requireCoveredRange, requireForwardRange, requireIsoDate, requireMarketHoursCover, spansWholeSessions, startOfDay } from '../request-window';
import { marketHour } from '../market-hours';

import type { AlpacaBar, AlpacaBarsResponse, AlpacaCalendarDay, AlpacaQuote, AlpacaQuotesResponse, AlpacaTrade, AlpacaTradesResponse } from './alpaca-rest-models';
import { normalizeBar, normalizeQuote, normalizeSession, normalizeTrade } from './normalizers';

const logger = LoggerFactory.getLogger('AlpacaMarketDataClient');

const SOURCE = 'Alpaca';

/**
 * Market data and the trading API are different hosts, and only the second has a paper
 * variant: `data.alpaca.markets` serves paper and live accounts alike, because what a key
 * may read is a matter of its subscription rather than the account it belongs to. There
 * is no paper endpoint to point market data at.
 *
 * The calendar is on the trading host, and that defaults to paper — the exchange calendar
 * is identical on both, so the safer host costs nothing, and it means a paper key never
 * reaches the live one. A live key needs `tradingBaseUrl` set to `ALPACA_TRADING_LIVE_URL`.
 *
 * Spelled out here rather than imported from `@fleece/alpaca`: that package is the trading
 * API, and market data depending on it would point an arrow the dependency graph does not
 * have.
 */
const ALPACA_DATA_URL = 'https://data.alpaca.markets';
export const ALPACA_TRADING_PAPER_URL = 'https://paper-api.alpaca.markets';
export const ALPACA_TRADING_LIVE_URL = 'https://api.alpaca.markets';

const DEFAULT_TIMEOUT_MS = 40_000;

/** Alpaca's page maximum for bars, trades and quotes. */
const MAX_PAGE = 10_000;

/** A stop, so a broken page token cannot spin forever against a paid API. */
const MAX_PAGES = 500;

/**
 * Which multipliers Alpaca aggregates, per unit. Checked here rather than left to a 422,
 * because "unprocessable entity" does not say that `2Day` is the problem.
 */
const TIMEFRAMES: Partial<Record<Timespan, { readonly unit: string; readonly allows: (multiplier: number) => boolean; readonly limit: string }>> = {
  minute: { unit: 'Min', allows: (multiplier) => multiplier >= 1 && multiplier <= 59, limit: '1 to 59' },
  hour: { unit: 'Hour', allows: (multiplier) => multiplier >= 1 && multiplier <= 23, limit: '1 to 23' },
  day: { unit: 'Day', allows: (multiplier) => multiplier === 1, limit: 'only 1' },
  week: { unit: 'Week', allows: (multiplier) => multiplier === 1, limit: 'only 1' },
  month: { unit: 'Month', allows: (multiplier) => [1, 2, 3, 4, 6, 12].includes(multiplier), limit: '1, 2, 3, 4, 6 or 12' },
};

export type AlpacaFeed = 'sip' | 'iex' | 'otc';

export interface AlpacaMarketDataClientProps {
  readonly apiKey: string;
  readonly secretKey: string;
  /**
   * `sip` is the consolidated tape and needs a paid subscription; `iex` is one exchange,
   * free, and reports a fraction of the volume. Defaulting to `sip` so a missing
   * subscription fails loudly rather than silently returning a tenth of the market.
   */
  readonly feed?: AlpacaFeed;
  readonly dataBaseUrl?: string;
  /** Where the calendar is read from. Defaults to paper; a live key needs the live host. */
  readonly tradingBaseUrl?: string;
  readonly timeoutMs?: number;
  readonly httpClient?: HttpClient;
}

export class AlpacaMarketDataClient implements AlpacaStockRestClient {
  private readonly headers: HttpHeaders;
  private readonly feed: AlpacaFeed;
  private readonly tradingBaseUrl: string;
  private readonly http: HttpClient;

  constructor(props: AlpacaMarketDataClientProps) {
    this.headers = { 'APCA-API-KEY-ID': props.apiKey, 'APCA-API-SECRET-KEY': props.secretKey };
    this.feed = props.feed ?? 'sip';
    this.tradingBaseUrl = props.tradingBaseUrl ?? ALPACA_TRADING_PAPER_URL;
    this.http = props.httpClient ?? new FetchHttpClient({ baseUrl: props.dataBaseUrl ?? ALPACA_DATA_URL, timeoutMs: props.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  }

  async minuteBars(request: MinuteBarsRequest): Promise<BarsResponse> {
    return await this.bars({ ...request, to: request.to ?? Date.now(), multiplier: 1, timespan: 'minute' });
  }

  async dailyBars(request: DailyBarsRequest): Promise<BarsResponse> {
    return await this.bars({ ...request, to: request.to ?? Date.now(), multiplier: 1, timespan: 'day', marketHoursOnly: false });
  }

  async bars(request: BarsRequest): Promise<BarsResponse> {
    const timeframe = TIMEFRAMES[request.timespan];
    if (timeframe === undefined) {
      throw new InvalidRequestError(`Alpaca does not aggregate by ${request.timespan}. Use one of [${Object.keys(TIMEFRAMES).join(', ')}].`);
    }
    if (!timeframe.allows(request.multiplier)) {
      throw new InvalidRequestError(`Alpaca takes ${timeframe.limit} for a ${request.timespan} timeframe, not ${request.multiplier}.`);
    }

    const from = startOfDay(request.from);
    const to = endOfDay(request.to);
    requireForwardRange(from, to, 'bars');
    const filterToRegularHours = request.marketHoursOnly !== false && !spansWholeSessions(request.timespan);
    if (filterToRegularHours) {
      requireCoveredRange(from, to, 'filter bars to market hours');
    }

    const raw = await this.page<AlpacaBar, AlpacaBarsResponse>('/v2/stocks/bars', request.symbol, (body) => body.bars, {
      timeframe: `${request.multiplier}${timeframe.unit}`,
      // `raw` is the tape as it printed; `split` restates earlier prices in today's shares.
      adjustment: request.adjustForSplit === true ? 'split' : 'raw',
      start: new Date(from).toISOString(),
      end: new Date(to).toISOString(),
    });

    const bars = raw.map((bar) => normalizeBar(request.symbol, bar));
    return { bars: filterToRegularHours ? regularHoursOnly(bars) : bars };
  }

  async trades(request: TradesRequest): Promise<TradesResponse> {
    const window = this.resolveWindow(request, 'trades');
    if (window === undefined) {
      return { trades: [] };
    }
    const raw = await this.page<AlpacaTrade, AlpacaTradesResponse>('/v2/stocks/trades', request.symbol, (body) => body.trades, window);
    return { trades: raw.map((trade) => normalizeTrade(request.symbol, trade)) };
  }

  async quotes(request: QuotesRequest): Promise<QuotesResponse> {
    const window = this.resolveWindow(request, 'quotes');
    if (window === undefined) {
      return { quotes: [] };
    }
    const raw = await this.page<AlpacaQuote, AlpacaQuotesResponse>('/v2/stocks/quotes', request.symbol, (body) => body.quotes, window);
    return { quotes: raw.map((quote) => normalizeQuote(request.symbol, quote)) };
  }

  /**
   * The exchange calendar, which is what the session table in `market-hours.ts` is made
   * of. Trading days only: a weekend or a holiday is absent from the answer.
   */
  async marketHours(request: MarketHoursRequest): Promise<MarketHoursResponse> {
    requireIsoDate(request.fromDate, 'read the start of the calendar range');
    requireIsoDate(request.toDate, 'read the end of the calendar range');
    if (request.fromDate > request.toDate) {
      throw new InvalidRequestError(`A market-hours request must start before it ends, got ${request.fromDate} to ${request.toDate}.`);
    }

    const body = await this.get<ReadonlyArray<AlpacaCalendarDay>>('/v2/calendar', { start: request.fromDate, end: request.toDate }, this.tradingBaseUrl);
    if (!Array.isArray(body)) {
      throw new DataProviderError(SOURCE, 'returned a calendar that is not a list of days.');
    }
    return { sessions: body.map((day) => normalizeSession(day)) };
  }

  /**
   * Either a whole trading day by `date` — pre-market open to after-hours close — or a
   * `from`/`to` window. Unlike Polygon, a window may span days: Alpaca pages by an opaque
   * token rather than by timestamp, so nothing about a day boundary can truncate it.
   */
  private resolveWindow(request: TradesRequest, what: string): Query | undefined {
    if (request.date !== undefined) {
      requireMarketHoursCover(request.date, `tell whether the market traded, to fetch ${what}`);
      const session = marketHour(request.date);
      if (session === undefined) {
        return undefined;
      }
      return { start: new Date(session.preMarketOpenAt).toISOString(), end: new Date(session.afterMarketCloseAt).toISOString(), limit: pageSize(request.itemsPerRequest, what) };
    }

    if (request.from === undefined) {
      throw new InvalidRequestError(`A ${what} request needs either a date or a from timestamp.`);
    }
    const to = request.to ?? Date.now();
    requireForwardRange(request.from, to, what);
    return { start: new Date(request.from).toISOString(), end: new Date(to).toISOString(), limit: pageSize(request.itemsPerRequest, what) };
  }

  private async page<T, R>(path: string, symbol: string, read: (body: R) => Record<string, ReadonlyArray<T> | null> | null | undefined, query: Query): Promise<T[]> {
    const results: T[] = [];
    let pageToken: string | undefined = undefined;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body: R = await this.get<R>(path, { ...query, symbols: symbol, feed: this.feed, page_token: pageToken });
      const bySymbol = read(body) ?? {};
      results.push(...(bySymbol[symbol] ?? []));

      const next = readPageToken(body);
      // Absent, null and empty all mean the same thing: this was the last page.
      if (next === undefined || next.length === 0) {
        return results;
      }
      pageToken = next;
    }

    throw new DataProviderError(SOURCE, `has more than ${MAX_PAGES} pages of ${path}. Ask for a shorter window.`);
  }

  private async get<T>(path: string, query: Query, baseUrl?: string): Promise<T> {
    const response = await this.http.send({ method: 'GET', url: path, query, headers: this.headers, baseUrl });

    if (response.status !== 200) {
      logger.warn(`Alpaca returned ${response.status} for ${path}: ${JSON.stringify(response.body ?? '').slice(0, 300)}`);
      throw new DataProviderError(SOURCE, `returned ${response.status} for ${path}.`, response.status);
    }
    if (typeof response.body !== 'object' || response.body === null) {
      throw new DataProviderError(SOURCE, `returned a body for ${path} that is not JSON.`);
    }

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the boundary with Alpaca's schema; the body is checked to be an object here, every collection read from it is guarded before it is walked, and each timestamp is parsed rather than trusted.
    return response.body as T;
  }
}

function readPageToken(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('next_page_token' in body)) {
    return undefined;
  }
  const token = Reflect.get(body, 'next_page_token');
  return typeof token === 'string' ? token : undefined;
}

/** Alpaca caps a page at 10,000 whatever is asked for. */
function pageSize(requested: number | undefined, what: string): number {
  if (requested === undefined) {
    return MAX_PAGE;
  }
  if (!Number.isFinite(requested) || requested < 1) {
    throw new InvalidRequestError(`A ${what} request needs at least one item per request, got ${requested}.`);
  }
  return Math.min(Math.round(requested), MAX_PAGE);
}
