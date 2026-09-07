import { FetchHttpClient, InternalServiceError, InvalidRequestError, LoggerFactory, easternClock, type HttpClient, type HttpResponse, type Query } from '@fleece/shared';

import {
  DataProviderError,
  type Bar,
  type BarsRequest,
  type BarsResponse,
  type DailyBarsRequest,
  type DateOrTimestamp,
  type DividendsRequest,
  type DividendsResponse,
  type HistoricalBarsRequest,
  type HistoricalBarsResponse,
  type MinuteBarsRequest,
  type PolygonStockRestClient,
  type QuotesRequest,
  type QuotesResponse,
  type SnapshotRequest,
  type SnapshotResponse,
  type SnapshotsRequest,
  type SnapshotsResponse,
  type StockSplitsRequest,
  type StockSplitsResponse,
  type Ticker,
  type TickerDetailsRequest,
  type TickerDetailsResponse,
  type TickersRequest,
  type TickersResponse,
  type Timespan,
  type TradesRequest,
  type TradesResponse,
} from '../equity-data-models';
import { marketHour, marketHourByIndex, marketHoursCoverage } from '../market-hours';
import { endOfDay, regularHoursOnly, requireCoveredRange, requireForwardRange, requireIsoDate, requireMarketHoursCover, startOfDay } from '../request-window';

import {
  nanosecondTimestamp,
  normalizeAggregateBar,
  normalizeQuote,
  normalizeDividend,
  normalizeSnapshot,
  normalizeStockSplit,
  normalizeTicker,
  normalizeTickerDetails,
  normalizeTrade,
} from './normalizers';
import type {
  PolygonAggregateResponse,
  PolygonLatestSnapshot,
  PolygonDividendResponse,
  PolygonLatestSnapshotResponse,
  PolygonLatestSnapshotsResponse,
  PolygonQuoteV3,
  PolygonQuotesResponseV3,
  PolygonStockSplitV3Response,
  PolygonTickerDetailsV3Response,
  PolygonTickersResponse,
  PolygonTradeV3,
  PolygonTradesResponseV3,
} from './polygon-rest-models';

const logger = LoggerFactory.getLogger('PolygonRestClient');

const SOURCE = 'Polygon';
const DEFAULT_BASE_URL = 'https://api.polygon.io';
const DEFAULT_TIMEOUT_MS = 40_000;

const ONE_DAY_MS = 86_400_000;

/** Polygon caps a page at 50,000 for aggregates, trades and quotes. */
const MAX_PAGE = 50_000;
const REFERENCE_PAGE = 1_000;

/** An intraday range is split into windows of this width and fetched in parallel. */
const INTRADAY_WINDOW_MS = 50 * ONE_DAY_MS;
const PARALLEL_WINDOWS = 10;

/** A stop, so a broken cursor cannot spin forever against a paid API. */
const MAX_PAGES = 200;

/**
 * How far back the trade and quote cursor steps before asking for the next page.
 *
 * Polygon timestamps these in nanoseconds — 1734620400042325000 — which is past
 * `Number.MAX_SAFE_INTEGER`, so `JSON.parse` has already rounded the value before any of
 * this code sees it. At that magnitude a double's step is 256ns, so the number we hold
 * can sit up to 128ns either side of the real one. The legacy client resumed at
 * `last + 1` and, when the rounding went down, re-fetched the trade it had just read;
 * had it gone up, the page boundary would have swallowed trades silently instead.
 * Stepping back further than the error and dropping what we have already seen is correct
 * whichever way it rounded.
 */
const CURSOR_BACKOFF_NS = BigInt(1024);

const TIMESPANS: ReadonlyArray<Timespan> = ['minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'];
const DAILY_OR_COARSER: ReadonlyArray<Timespan> = ['day', 'week', 'month', 'quarter', 'year'];

export interface PolygonRestClientProps {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Defaults to a `FetchHttpClient`. Injected so a test can answer without a network. */
  readonly httpClient?: HttpClient;
}

export class PolygonRestClient implements PolygonStockRestClient {
  private readonly apiKey: string;
  private readonly http: HttpClient;

  constructor(props: PolygonRestClientProps) {
    this.apiKey = props.apiKey;
    this.http = props.httpClient ?? new FetchHttpClient({ baseUrl: props.baseUrl ?? DEFAULT_BASE_URL, timeoutMs: props.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  }

  async minuteBars(request: MinuteBarsRequest): Promise<BarsResponse> {
    return await this.bars({ ...request, to: request.to ?? defaultEnd(request.from), multiplier: 1, timespan: 'minute' });
  }

  /**
   * Called during a session with today as the end date, the last bar is a partial one for
   * the session so far.
   */
  async dailyBars(request: DailyBarsRequest): Promise<BarsResponse> {
    return await this.bars({ ...request, to: request.to ?? defaultEnd(request.from), multiplier: 1, timespan: 'day', marketHoursOnly: false });
  }

  async bars(request: BarsRequest): Promise<BarsResponse> {
    if (!TIMESPANS.includes(request.timespan)) {
      throw new InvalidRequestError(`${request.timespan} is not a timespan Polygon aggregates. Use one of [${TIMESPANS.join(', ')}].`);
    }
    if (request.timespan === 'minute' && ![1, 5, 30].includes(request.multiplier)) {
      throw new InvalidRequestError(`${request.multiplier} is not a valid minute multiplier. Use 1, 5 or 30.`);
    }

    const path = `/v2/aggs/ticker/${encodeURIComponent(request.symbol)}/range/${request.multiplier}/${request.timespan}`;
    // Polygon's documented parameter. The legacy client sent the older `unadjusted`,
    // whose sense is inverted; both are still honoured and agree.
    const query: Query = { adjusted: request.adjustForSplit === true, sort: 'asc', limit: MAX_PAGE };

    const from = startOfDay(request.from);
    const to = endOfDay(request.to);
    requireForwardRange(from, to, 'bars');

    if (DAILY_OR_COARSER.includes(request.timespan)) {
      // 50,000 days is 136 years, so one request covers any range worth asking for, and
      // market hours do not apply to a bar that spans the whole day.
      return { bars: await this.aggregates(request.symbol, `${path}/${from}/${to}`, query) };
    }

    // Before the requests rather than after them: a two-decade minute range is 180 calls
    // against a paid API, and refusing it afterwards spends every one of them first.
    // Both ends, because outside the table every bar reads as closed — a range before
    // 2001 empties exactly as silently as one after 2024.
    if (request.marketHoursOnly !== false) {
      requireCoveredRange(from, to, 'filter bars to market hours');
    }

    const bars = await this.intradayBars(request.symbol, path, query, from, to);
    return { bars: request.marketHoursOnly === false ? bars : regularHoursOnly(bars) };
  }

  async trades(request: TradesRequest): Promise<TradesResponse> {
    const window = this.resolveWindow(request, 'trades');
    if (window === undefined) {
      return { trades: [] };
    }
    // Started together: the split table depends on the symbol, not on the trades, and
    // waiting for every page before asking for it serialises two independent calls.
    const [raw, ratios] = await Promise.all([
      this.pageByTimestamp<PolygonTradeV3, PolygonTradesResponseV3>(`/v3/trades/${encodeURIComponent(request.symbol)}`, window),
      window.adjustForSplit === true ? this.splitRatios(request.symbol) : Promise.resolve([]),
    ]);
    const trades = raw.map((trade) => normalizeTrade(request.symbol, trade));
    return { trades: ratios.length === 0 ? trades : trades.map((trade) => ({ ...trade, p: adjust(trade.p, trade.t, ratios) })) };
  }

  async quotes(request: QuotesRequest): Promise<QuotesResponse> {
    const window = this.resolveWindow(request, 'quotes');
    if (window === undefined) {
      return { quotes: [] };
    }
    const [raw, ratios] = await Promise.all([
      this.pageByTimestamp<PolygonQuoteV3, PolygonQuotesResponseV3>(`/v3/quotes/${encodeURIComponent(request.symbol)}`, window),
      window.adjustForSplit === true ? this.splitRatios(request.symbol) : Promise.resolve([]),
    ]);
    const quotes = raw.map((quote) => normalizeQuote(request.symbol, quote));
    return { quotes: ratios.length === 0 ? quotes : quotes.map((quote) => ({ ...quote, ap: adjust(quote.ap, quote.t, ratios), bp: adjust(quote.bp, quote.t, ratios) })) };
  }

  /**
   * Polygon serves this only while the session is live: it clears the data at Eastern
   * midnight and answers 404 until pre-market opens, and after 20:00 it repeats the last
   * trade before the close.
   */
  async snapshot(request: SnapshotRequest): Promise<SnapshotResponse> {
    const session = this.currentSession();
    if (session === undefined) {
      return {};
    }
    const body = await this.get<PolygonLatestSnapshotResponse>(`/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(request.symbol)}`, {});
    // A symbol with no session data comes back 200 with no `ticker` at all.
    if (!isSnapshot(body.ticker)) {
      return {};
    }
    return { snapshot: normalizeSnapshot(body.ticker, session.previousSessionStart) };
  }

  async snapshots(request: SnapshotsRequest): Promise<SnapshotsResponse> {
    if (request.symbols.length === 0) {
      return { snapshots: [] };
    }
    const session = this.currentSession();
    if (session === undefined) {
      return { snapshots: [] };
    }
    const body = await this.get<PolygonLatestSnapshotsResponse>('/v2/snapshot/locale/us/markets/stocks/tickers', { tickers: request.symbols.join(',') });
    return { snapshots: (body.tickers ?? []).filter((ticker) => isSnapshot(ticker)).map((ticker) => normalizeSnapshot(ticker, session.previousSessionStart)) };
  }

  /**
   * Stops at `limit`, at a short page, or at `MAX_PAGES` — and says which by whether the
   * response carries a `resumeFrom`. There are more US tickers than one call can walk, so
   * running out of pages is an ordinary outcome here rather than a failure, and throwing
   * would discard every page already paid for.
   */
  async tickers(request: TickersRequest): Promise<TickersResponse> {
    const results: Ticker[] = [];
    let after: string | undefined = request.startAfter;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const remaining = request.limit === undefined ? REFERENCE_PAGE : request.limit - results.length;
      const limit = Math.min(REFERENCE_PAGE, remaining);
      if (limit <= 0) {
        return { tickers: results, resumeFrom: after };
      }

      // Paged by ticker rather than by cursor, so a caller can resume from a known symbol.
      const query: Query = {
        sort: 'ticker',
        order: 'asc',
        market: 'stocks',
        limit,
        type: request.type,
        active: request.active,
        'ticker.gt': after,
        'ticker.gte': after === undefined ? request.startTicker : undefined,
      };

      const body = await this.get<PolygonTickersResponse>('/v3/reference/tickers', query);
      const page_ = (body.results ?? []).map((ticker) => normalizeTicker(ticker));
      results.push(...page_);
      after = page_.length === 0 ? after : page_[page_.length - 1].ticker;
      if (page_.length < limit) {
        // A short page is the end of the listing, not a place to resume from.
        return { tickers: results };
      }
    }

    return { tickers: results, resumeFrom: after };
  }

  async tickerDetails(request: TickerDetailsRequest): Promise<TickerDetailsResponse> {
    if (request.date !== undefined) {
      requireIsoDate(request.date, 'read the ticker details as of a date');
    }
    const body = await this.get<PolygonTickerDetailsV3Response>(`/v3/reference/tickers/${encodeURIComponent(request.symbol)}`, { date: request.date });
    // Asked for a date before the ticker existed, Polygon omits `results` rather than
    // sending null, so `=== null` would hand the normaliser an undefined to walk.
    return body.results === null || body.results === undefined ? {} : { details: normalizeTickerDetails(body.results) };
  }

  async stockSplits(request: StockSplitsRequest): Promise<StockSplitsResponse> {
    if (request.executionDate !== undefined) {
      requireIsoDate(request.executionDate, 'filter splits to an execution date');
    }
    const query: Query = { ticker: request.symbol, limit: 500, sort: 'execution_date', order: 'asc', execution_date: request.executionDate };
    const raw = await this.pageByCursor<PolygonStockSplitV3Response>('/v3/reference/splits', query);
    return { splits: raw.flatMap((body) => (body.results ?? []).map((split) => normalizeStockSplit(split))) };
  }

  async dividends(request: DividendsRequest): Promise<DividendsResponse> {
    // The reference endpoints consult no market-hours table, so nothing else here would
    // look at these: an impossible date would go to Polygon, come back a 400, and reach
    // the caller as a `DataProviderError` blaming the provider for a typo.
    requireIsoDate(request.fromDate, 'read the start of the dividend range');
    requireIsoDate(request.toDate, 'read the end of the dividend range');
    const query: Query = {
      ticker: request.symbol,
      [`${request.dateType}.gte`]: request.fromDate,
      [`${request.dateType}.lte`]: request.toDate,
      sort: 'pay_date',
      order: 'asc',
      limit: REFERENCE_PAGE,
    };
    const raw = await this.pageByCursor<PolygonDividendResponse>('/v3/reference/dividends', query);
    return { dividends: raw.flatMap((body) => (body.results ?? []).map((dividend) => normalizeDividend(dividend))) };
  }

  async historicalBars(request: HistoricalBarsRequest): Promise<HistoricalBarsResponse> {
    requireMarketHoursCover(request.endDate, 'walk back through trading days');

    // The dates first, then the requests: one day's bars do not depend on another's, and
    // awaiting each in turn made a sixty-day backfill sixty round trips end to end.
    const dates: string[] = [];
    for (let date = request.endDate; dates.length < request.days; date = easternClock.shiftDate(date, -1)) {
      if (date < marketHoursCoverage.from) {
        // The legacy loop had no floor and spun forever once it ran off the table.
        throw new InternalServiceError(
          `Only ${dates.length} of the ${request.days} trading days before ${request.endDate} are in the market-hours table, which starts at ${marketHoursCoverage.from}. Refresh packages/marketdata/src/market-hours-data.json.`,
        );
      }
      if (marketHour(date) !== undefined) {
        dates.push(date);
      }
    }

    const days = new Map<string, ReadonlyArray<Bar>>();
    for (let index = 0; index < dates.length; index += PARALLEL_WINDOWS) {
      const batch = dates.slice(index, index + PARALLEL_WINDOWS);
      const fetched = await Promise.all(
        batch.map(async (date) => await this.minuteBars({ symbol: request.symbol, from: date, to: date, marketHoursOnly: request.marketHoursOnly })),
      );
      batch.forEach((date, offset) => days.set(date, fetched[offset].bars));
    }

    return { days };
  }

  private async intradayBars(symbol: string, path: string, query: Query, from: number, to: number): Promise<Bar[]> {
    const windows: Array<{ from: number; to: number }> = [];
    for (let start = from; start < to; start += INTRADAY_WINDOW_MS) {
      windows.push({ from: start, to: Math.min(start + INTRADAY_WINDOW_MS, to) - 1 });
    }

    const bars: Bar[] = [];
    for (let index = 0; index < windows.length; index += PARALLEL_WINDOWS) {
      const batch = windows.slice(index, index + PARALLEL_WINDOWS);
      const fetched = await Promise.all(batch.map(async (window) => await this.aggregates(symbol, `${path}/${window.from}/${window.to}`, query)));
      for (const window of fetched) {
        bars.push(...window);
      }
    }
    return bars;
  }

  private async aggregates(symbol: string, path: string, query: Query): Promise<Bar[]> {
    const body = await this.get<PolygonAggregateResponse>(path, query);
    const results = body.results ?? [];
    // Aggregates have no cursor, so a page that comes back exactly full is a window
    // Polygon truncated — indistinguishable, in the returned array, from a symbol that
    // stopped trading there.
    if (results.length >= MAX_PAGE) {
      throw new DataProviderError(SOURCE, `returned the maximum ${MAX_PAGE} aggregates for ${path}, so the window is truncated. Ask for a shorter range.`);
    }
    return results.map((bar) => normalizeAggregateBar(symbol, bar));
  }

  /**
   * Resolves a request that is either a whole trading day or a window, and refuses a
   * window spanning two Eastern days: Polygon pages these by timestamp, and the caller
   * would silently get the first page of each day.
   */
  private resolveWindow(request: TradesRequest, what: string): ResolvedWindow | undefined {
    if (request.date !== undefined) {
      // Before reading "no session" as "the market was shut": past the table's end every
      // real trading day looks like a holiday, and a backfill would record nothing and
      // report success.
      requireMarketHoursCover(request.date, `tell whether the market traded, to fetch ${what}`);
      const session = marketHour(request.date);
      if (session === undefined) {
        return undefined;
      }
      return { from: session.preMarketOpenAt, to: session.afterMarketCloseAt, adjustForSplit: request.adjustForSplit, itemsPerRequest: pageSize(request.itemsPerRequest, what) };
    }

    if (request.from === undefined) {
      throw new InvalidRequestError(`A ${what} request needs either a date or a from timestamp.`);
    }
    const to = request.to ?? Date.now();
    if (request.from >= to) {
      throw new InvalidRequestError(`A ${what} request must start before it ends, got ${request.from} to ${to}.`);
    }
    const fromDate = easternClock.date(request.from);
    const toDate = easternClock.date(to);
    if (fromDate !== toDate) {
      throw new InvalidRequestError(`A ${what} request must stay inside one Eastern day, got ${fromDate} to ${toDate}.`);
    }
    requireMarketHoursCover(fromDate, `tell whether the market traded, to fetch ${what}`);
    return { from: request.from, to, adjustForSplit: request.adjustForSplit, itemsPerRequest: pageSize(request.itemsPerRequest, what) };
  }

  /**
   * Pages by advancing past the last timestamp seen rather than by cursor, which is what
   * lets a partial page end the walk.
   */
  private async pageByTimestamp<T extends PagedByTimestamp, R extends { readonly results?: ReadonlyArray<T> | null }>(path: string, window: ResolvedWindow): Promise<T[]> {
    const results: T[] = [];
    // Keys of what we hold at or after `from` — the only entries a page can hand back
    // twice. Bounded by how many trades share the backoff window, not by the session.
    let overlap = new Set<string>();
    let from = BigInt(window.from) * BigInt(1_000_000);
    const to = BigInt(window.to) * BigInt(1_000_000);
    let limit = window.itemsPerRequest;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await this.get<R>(path, {
        limit,
        sort: 'timestamp',
        order: 'asc',
        'timestamp.gte': from.toString(),
        'timestamp.lt': to.toString(),
      });
      const entries = body.results ?? [];
      let added = 0;
      for (const entry of entries) {
        if (!overlap.has(keyOf(entry))) {
          results.push(entry);
          added += 1;
        }
      }

      if (entries.length < limit) {
        return results;
      }

      if (added === 0) {
        // A full page of entries we already hold: the backoff window has at least this
        // many trades in it, so no page this size can reach past them. Asking for a
        // bigger one from the same point is the only move that neither stops early nor
        // steps over trades — `itemsPerRequest: 1` hit this on any ordinary window.
        if (limit >= MAX_PAGE) {
          throw new DataProviderError(
            SOURCE,
            `has more than ${MAX_PAGE} entries for ${path} at ${entries[entries.length - 1].sip_timestamp}, which is more than one page can step over. Ask for a shorter window.`,
          );
        }
        limit = Math.min(limit * 2, MAX_PAGE);
        continue;
      }

      from = nanosecondTimestamp(entries[entries.length - 1].sip_timestamp) - CURSOR_BACKOFF_NS;
      overlap = overlapAt(results, from);
    }

    // Naming the page size because it is usually the cause: a small one asks for a
    // request per handful of trades, and a busy window runs out of pages long before it
    // runs out of trades.
    throw new DataProviderError(SOURCE, `has more than ${MAX_PAGES} pages of ${path} at ${limit} entries a page. Ask for a larger itemsPerRequest, or a shorter window.`);
  }

  /**
   * Follows `next_url` as the absolute URL Polygon documents it to be, carrying only the
   * API key, which it omits.
   *
   * The legacy client split the string on `cursor=` and rebuilt the request from the
   * cursor alone. Extracting the cursor properly would fix the parsing and keep the
   * rebuilding — and the rebuilt request still carries no `ticker`. Polygon's cursor
   * happens to re-encode the filters today, so that works; the day it does not,
   * `dividends({ symbol: 'AAPL' })` returns page two of every issuer's dividends and the
   * job credits an account cash it is not owed, with nothing raised anywhere.
   */
  private async pageByCursor<R extends { readonly next_url?: string | null }>(path: string, query: Query): Promise<R[]> {
    const pages: R[] = [];
    let next: string | undefined = undefined;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body: R = next === undefined ? await this.get<R>(path, query) : await this.getUrl<R>(next);
      pages.push(body);
      // Absent, null and empty all say the same thing: there is no next page. Only
      // `undefined` ended the walk, so a proxy answering `"next_url": null` fell through
      // to `new URL(null)` — a bare TypeError, and a 500 out of the dividend job.
      if (body.next_url === undefined || body.next_url === null || body.next_url.length === 0) {
        return pages;
      }
      next = body.next_url;
    }

    throw new DataProviderError(SOURCE, `refusing to page past ${MAX_PAGES} pages of ${path}.`);
  }

  private async splitRatios(symbol: string): Promise<ReadonlyArray<SplitRatio>> {
    const { splits } = await this.stockSplits({ symbol });
    return splits.map((split) => ({
      // A 1-for-4 split makes a share worth a quarter of what it was, so a price before
      // it is multiplied by from/to to be comparable with prices after.
      ratio: split.splitFrom / split.splitTo,
      before: easternClock.timestamp(split.executionDate, '00:00:00'),
    }));
  }

  private currentSession(): CurrentSession | undefined {
    const now = Date.now();
    const today = easternClock.date(now);
    requireMarketHoursCover(today, 'tell whether the market is open');

    const session = marketHour(now);
    if (session === undefined || now < session.preMarketOpenAt || now > session.afterMarketCloseAt) {
      logger.info(`Polygon serves no snapshot at ${easternClock.datetime(now)}: the market is not open.`);
      return undefined;
    }
    const previous = marketHourByIndex(session.index - 1);
    return { previousSessionStart: previous === undefined ? 0 : easternClock.timestamp(previous.date, '00:00:00') };
  }

  /**
   * The market-hours table is a fixed list ending at its last recorded session. Past that
   * every date reads as closed, so a caller that trusted it would be told the market is
   * shut rather than that we do not know — which is the failure this refuses to make.
   */

  private async get<T>(path: string, query: Query): Promise<T> {
    return this.read<T>(path, await this.http.send({ method: 'GET', url: path, query: { ...query, apiKey: this.apiKey } }));
  }

  /** For a `next_url`, which is absolute and already carries every filter. */
  private async getUrl<T>(url: string): Promise<T> {
    // Parsed before the request, both for the path this logs under and because anything
    // `new URL` cannot read is the provider having sent something broken — a relative
    // path, a truncated string — rather than a network failure or a caller's mistake.
    return this.read<T>(pathOf(url), await this.http.send({ method: 'GET', url, baseUrl: '', query: { apiKey: this.apiKey } }));
  }

  private read<T>(path: string, response: HttpResponse): T {
    if (response.status !== 200) {
      // The key rides in the query string, so neither the URL nor the query reaches a log.
      // `?? ''` because an empty body parses to undefined, and `JSON.stringify(undefined)`
      // is undefined rather than a string — which would throw here, in the error path,
      // replacing the typed failure a caller branches on with a bare TypeError.
      logger.warn(`Polygon returned ${response.status} for ${path}: ${JSON.stringify(response.body ?? '').slice(0, 300)}`);
      throw new DataProviderError(SOURCE, `returned ${response.status} for ${path}.`, response.status);
    }
    if (typeof response.body !== 'object' || response.body === null) {
      throw new DataProviderError(SOURCE, `returned a body for ${path} that is not a JSON object.`);
    }

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the boundary with Polygon's schema; the body is checked to be an object here, and every collection read from it is guarded before it is walked: `results ?? []` in the paging, and `isSnapshot` on the snapshot sections.
    return response.body as T;
  }
}

interface PagedByTimestamp {
  readonly sip_timestamp: number;
  readonly sequence_number: number;
}

interface ResolvedWindow {
  readonly from: number;
  readonly to: number;
  readonly adjustForSplit?: boolean;
  readonly itemsPerRequest: number;
}

interface CurrentSession {
  readonly previousSessionStart: number;
}

interface SplitRatio {
  readonly ratio: number;
  readonly before: number;
}

/** Polygon caps a page at 50,000 whatever is asked for, and a short page ends the walk. */
function pageSize(requested: number | undefined, what: string): number {
  if (requested === undefined) {
    return MAX_PAGE;
  }
  if (!Number.isFinite(requested) || requested < 1) {
    throw new InvalidRequestError(`A ${what} request needs at least one item per request, got ${requested}.`);
  }
  // Not an error to ask for more: asking for 100,000 and believing the 50,000 that came
  // back was the whole day is the failure, and clamping is what makes the page short.
  return Math.min(Math.round(requested), MAX_PAGE);
}

function keyOf(entry: PagedByTimestamp): string {
  return `${entry.sequence_number}/${entry.sip_timestamp}`;
}

/**
 * Walks back from the end rather than filtering the whole array: entries arrive ascending
 * and a page only ever repeats what sits inside the backoff window, so this reads a
 * handful of entries however long the session is.
 */
function overlapAt(results: ReadonlyArray<PagedByTimestamp>, from: bigint): Set<string> {
  const keys = new Set<string>();
  for (let index = results.length - 1; index >= 0; index -= 1) {
    if (nanosecondTimestamp(results[index].sip_timestamp) < from) {
      break;
    }
    keys.add(keyOf(results[index]));
  }
  return keys;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    throw new DataProviderError(SOURCE, `sent a next_url that is not an absolute URL: ${JSON.stringify(url)}.`);
  }
}

function isSnapshot(snapshot: PolygonLatestSnapshot | undefined): snapshot is PolygonLatestSnapshot {
  return (
    snapshot !== undefined &&
    snapshot.lastTrade !== undefined &&
    snapshot.lastQuote !== undefined &&
    snapshot.min !== undefined &&
    snapshot.day !== undefined &&
    snapshot.prevDay !== undefined
  );
}

function adjust(price: number, timestamp: number, ratios: ReadonlyArray<SplitRatio>): number {
  return ratios.reduce((adjusted, split) => (timestamp < split.before ? adjusted * split.ratio : adjusted), price);
}

function defaultEnd(from: DateOrTimestamp): DateOrTimestamp {
  return typeof from === 'number' ? Date.now() : easternClock.date();
}
