import { FetchHttpClient, InvalidRequestError, LoggerFactory, easternClock, type HttpClient, type HttpHeaders, type Query } from '@fleece/utilities';

import {
  DataProviderError,
  type Bar,
  type BarsRequest,
  type BarsResponse,
  type DailyBarsRequest,
  type MarketHoursRequest,
  type MarketHoursResponse,
  type MinuteBarsRequest,
  type QuotesRequest,
  type QuotesResponse,
  type AlpacaMarketDataRestClient,
  type ConditionsRequest,
  type ConditionsResponse,
  type ExchangesRequest,
  type ExchangesResponse,
  type OptionBarsBySymbolRequest,
  type OptionBarsBySymbolResponse,
  type OptionBarsRequest,
  type OptionBarsResponse,
  type OptionChainRequest,
  type OptionListingRequest,
  type OptionChainResponse,
  type OptionContractsRequest,
  type OptionContractsResponse,
  type OptionSnapshot,
  type OptionTradesRequest,
  type OptionTradesResponse,
  type StockSplitsRequest,
  type StockSplitsResponse,
  type Timespan,
  type TradesRequest,
  type TradesResponse,
} from '../data-models';
import { adjustPrice, splitRatios, type SplitRatio } from '../split-adjustment';
import { endOfDay, regularHoursOnly, requireCoveredRange, requireForwardRange, requireIsoDate, requireMarketHoursCover, spansWholeSessions, startOfDay } from '../request-window';
import { marketHour } from '../market-hours';
import { parseOccSymbol, requireOccSymbol } from '../occ-symbol';

import type {
  AlpacaBar,
  AlpacaBarsResponse,
  AlpacaCalendarDay,
  AlpacaCorporateActions,
  AlpacaCorporateActionsResponse,
  AlpacaOptionBarsResponse,
  AlpacaOptionContractsResponse,
  AlpacaOptionSnapshotsResponse,
  AlpacaOptionTrade,
  AlpacaOptionTradesResponse,
  AlpacaQuote,
  AlpacaQuotesResponse,
  AlpacaTrade,
  AlpacaTradesResponse,
} from './alpaca-rest-models';
import {
  normalizeBar,
  normalizeOptionContract,
  normalizeOptionSnapshot,
  normalizeOptionTrade,
  normalizeQuote,
  normalizeSession,
  normalizeSplit,
  normalizeTrade,
} from './normalizers';

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
 * Spelled out here rather than imported from `@fleece/broker`: that package is the trading
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

/** A chain page is capped lower than a bar or trade page. */
const MAX_CHAIN_PAGE = 1_000;

/**
 * Contracts per bars request. Alpaca serves a whole SPY expiry — 291 symbols in a 6.2 kB
 * URL — without complaint; this leaves room under that rather than finding the ceiling.
 */
const MAX_BAR_SYMBOLS = 200;

/** Alpaca's corporate-action history does not reach further back than this. */
const EARLIEST_CORPORATE_ACTION = '2000-01-01';

/**
 * Which multipliers Alpaca aggregates, per unit, for stocks and options alike. Checked
 * here rather than left to a 400, because "invalid query parameter" does not say that
 * `2Day` is the problem.
 *
 * Monthly takes 1, 2, 3, 6 and 12. The documentation lists 4 as well and the API rejects
 * it — `the following monthly aggregates are supported: 1, 2, 3, 6, 12` — on both the
 * stock and the option endpoint.
 */
const TIMEFRAMES: Partial<Record<Timespan, { readonly unit: string; readonly allows: (multiplier: number) => boolean; readonly limit: string }>> = {
  minute: { unit: 'Min', allows: (multiplier) => multiplier >= 1 && multiplier <= 59, limit: '1 to 59' },
  hour: { unit: 'Hour', allows: (multiplier) => multiplier >= 1 && multiplier <= 23, limit: '1 to 23' },
  day: { unit: 'Day', allows: (multiplier) => multiplier === 1, limit: 'only 1' },
  week: { unit: 'Week', allows: (multiplier) => multiplier === 1, limit: 'only 1' },
  month: { unit: 'Month', allows: (multiplier) => [1, 2, 3, 6, 12].includes(multiplier), limit: '1, 2, 3, 6 or 12' },
};

export type AlpacaFeed = 'sip' | 'iex' | 'otc';

export type AlpacaOptionFeed = 'opra' | 'indicative';

export interface AlpacaMarketDataClientProps {
  readonly apiKey: string;
  readonly secretKey: string;
  /**
   * `sip` is the consolidated tape and needs a paid subscription; `iex` is one exchange,
   * free, and reports a fraction of the volume. Defaulting to `sip` so a missing
   * subscription fails loudly rather than silently returning a tenth of the market.
   */
  readonly feed?: AlpacaFeed;
  /**
   * `opra` is the consolidated options tape and needs a subscription; `indicative` is
   * Alpaca's own synthetic quote, and it is not the same number — one contract quoted
   * 113.95/116.85 on opra and 112.66/118.93 on indicative at the same instant. Defaults
   * to `opra` for the reason `sip` is the stock default. Snapshots only: the historical
   * option endpoints reject a feed.
   */
  readonly optionFeed?: AlpacaOptionFeed;
  readonly dataBaseUrl?: string;
  /** Where the calendar is read from. Defaults to paper; a live key needs the live host. */
  readonly tradingBaseUrl?: string;
  readonly timeoutMs?: number;
  readonly httpClient?: HttpClient;
}

export class AlpacaMarketDataClient implements AlpacaMarketDataRestClient {
  private readonly headers: HttpHeaders;
  private readonly feed: AlpacaFeed;
  private readonly optionFeed: AlpacaOptionFeed;
  private readonly tradingBaseUrl: string;
  private readonly http: HttpClient;

  constructor(props: AlpacaMarketDataClientProps) {
    this.headers = { 'APCA-API-KEY-ID': props.apiKey, 'APCA-API-SECRET-KEY': props.secretKey };
    this.feed = props.feed ?? 'sip';
    this.optionFeed = props.optionFeed ?? 'opra';
    this.tradingBaseUrl = props.tradingBaseUrl ?? ALPACA_TRADING_PAPER_URL;
    this.http = props.httpClient ?? new FetchHttpClient({ baseUrl: props.dataBaseUrl ?? ALPACA_DATA_URL, timeoutMs: props.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  }

  async minuteBars(request: MinuteBarsRequest): Promise<BarsResponse> {
    return await this.bars({ ...request, to: request.to ?? Date.now(), multiplier: 1, timespan: 'minute' });
  }

  async dailyBars(request: DailyBarsRequest): Promise<BarsResponse> {
    return await this.bars({ ...request, to: request.to ?? Date.now(), multiplier: 1, timespan: 'day' });
  }

  async bars(request: BarsRequest): Promise<BarsResponse> {
    const timeframe = resolveTimeframe(request.timespan, request.multiplier);

    const from = startOfDay(request.from);
    const to = endOfDay(request.to);
    requireForwardRange(from, to, 'bars');
    const filterToRegularHours = request.marketHoursOnly !== false && !spansWholeSessions(request.timespan);
    if (filterToRegularHours) {
      requireCoveredRange(from, to, 'filter bars to market hours');
    }

    const raw = await this.page<AlpacaBar, AlpacaBarsResponse>('/v2/stocks/bars', request.symbol, (body) => body.bars, {
      feed: this.feed,
      timeframe,
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
    // Started together: the split table depends on the symbol, not on the trades.
    const [raw, ratios] = await Promise.all([
      this.page<AlpacaTrade, AlpacaTradesResponse>('/v2/stocks/trades', request.symbol, (body) => body.trades, { ...window, feed: this.feed }),
      this.ratiosFor(request.symbol, request.adjustForSplit),
    ]);
    const trades = raw.map((trade) => normalizeTrade(request.symbol, trade));
    return { trades: ratios.length === 0 ? trades : trades.map((trade) => ({ ...trade, p: adjustPrice(trade.p, trade.t, ratios) })) };
  }

  async quotes(request: QuotesRequest): Promise<QuotesResponse> {
    const window = this.resolveWindow(request, 'quotes');
    if (window === undefined) {
      return { quotes: [] };
    }
    const [raw, ratios] = await Promise.all([
      this.page<AlpacaQuote, AlpacaQuotesResponse>('/v2/stocks/quotes', request.symbol, (body) => body.quotes, { ...window, feed: this.feed }),
      this.ratiosFor(request.symbol, request.adjustForSplit),
    ]);
    const quotes = raw.map((quote) => normalizeQuote(request.symbol, quote));
    return { quotes: ratios.length === 0 ? quotes : quotes.map((quote) => ({ ...quote, ap: adjustPrice(quote.ap, quote.t, ratios), bp: adjustPrice(quote.bp, quote.t, ratios) })) };
  }

  /**
   * Alpaca's trade and quote endpoints refuse an `adjustment` parameter — they serve the
   * prints as they happened — so an adjusted price is arithmetic done here, from the
   * splits the same client can fetch.
   *
   * Which inherits that history's depth: those corporate actions begin around 2016, so a
   * print from before an earlier split is restated by the splits Alpaca knows and no
   * others. Polygon holds the longer record and is the one to ask for a long history.
   */
  private async ratiosFor(symbol: string, adjustForSplit: boolean | undefined): Promise<ReadonlyArray<SplitRatio>> {
    if (adjustForSplit !== true) {
      return [];
    }
    return splitRatios((await this.stockSplits({ symbol })).splits);
  }

  /**
   * Forward and reverse splits together, oldest first, as one list — the endpoint returns
   * them under separate keys and the difference is only which way the rates run.
   *
   * The window matters here in a way it does not for Polygon. Alpaca answers with today
   * alone when given no range, so this asks for everything it holds; and what it holds
   * begins around 2016, where Polygon has AAPL's 1987 split. A caller reconstructing a
   * long price history wants Polygon.
   */
  async stockSplits(request: StockSplitsRequest): Promise<StockSplitsResponse> {
    const range = this.corporateActionRange(request.executionDate);
    const actions = await this.corporateActions(request.symbol, 'forward_split,reverse_split', range);
    const splits = actions.flatMap((page) => [...(page.forward_splits ?? []), ...(page.reverse_splits ?? [])]).map((split) => normalizeSplit(split));
    return { splits: splits.sort((left, right) => left.executionDate.localeCompare(right.executionDate)) };
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
   * One page of the contracts written on an underlying, expired ones reachable.
   *
   * `status` picks which side of expiry, and defaults to `active` as Alpaca's own filter
   * does — a listing of what has already expired has to ask for `inactive`.
   */
  async listOptionContracts(request: OptionContractsRequest): Promise<OptionContractsResponse> {
    const underlying = request.underlying.trim().toUpperCase();
    if (underlying.length === 0) {
      throw new InvalidRequestError('A contract listing needs an underlying ticker to list the contracts of, and this request has none.');
    }

    const body = await this.get<AlpacaOptionContractsResponse>(
      '/v2/options/contracts',
      {
        underlying_symbols: underlying,
        status: request.status ?? 'active',
        root_symbol: request.root,
        type: request.type,
        style: request.style,
        show_deliverables: request.withDeliverables === true ? 'true' : undefined,
        limit: pageSize(request.limit, 'contract listing'),
        page_token: request.startAfter,
        ...expirationRange(request),
        ...strikeRange(request, 'contract listing'),
      },
      this.tradingBaseUrl,
    );

    const listed = body.option_contracts;
    if (listed !== undefined && listed !== null && !Array.isArray(listed)) {
      throw new DataProviderError(SOURCE, `returned ${underlying}'s contracts as something other than a list.`);
    }
    return {
      contracts: (listed ?? []).map((contract) => normalizeOptionContract(contract)),
      resumeFrom: cursor(body),
    };
  }

  /**
   * One page of an underlying's chain, and a cursor when there is more.
   *
   * Not walked to the end on the caller's behalf: a full AAPL chain is around 3,100
   * contracts and SPY's around 12,000, so which slice is wanted is a question only the
   * caller can answer. The filters are how they answer it.
   */
  async optionChain(request: OptionChainRequest): Promise<OptionChainResponse> {
    // An empty one would address the multi-symbol snapshots route instead, which answers
    // about a `symbols` parameter this call never sends.
    if (request.underlying.trim().length === 0) {
      throw new InvalidRequestError('An option chain needs an underlying ticker to be a chain of, and this request has none.');
    }

    const body = await this.get<AlpacaOptionSnapshotsResponse>(`/v1beta1/options/snapshots/${encodeURIComponent(request.underlying)}`, {
      feed: this.optionFeed,
      type: request.type,
      limit: pageSize(request.limit, 'chain', MAX_CHAIN_PAGE),
      page_token: request.startAfter,
      ...expirationRange(request),
      ...strikeRange(request, 'chain'),
    });

    const contracts: OptionSnapshot[] = [];
    // Insertion order, which is the order the chain pages in — an OCC symbol starts with
    // a letter, so none of these keys is the integer-like kind that would be reordered.
    for (const [symbol, snapshot] of Object.entries(body.snapshots ?? {})) {
      if (snapshot === null) {
        continue;
      }
      const contract = parseOccSymbol(symbol);
      if (contract === undefined) {
        throw new DataProviderError(SOURCE, `returned ${JSON.stringify(symbol)} in ${request.underlying}'s chain, which is not an OCC contract symbol.`);
      }
      contracts.push(normalizeOptionSnapshot(contract, snapshot));
    }

    return { contracts, resumeFrom: cursor(body) };
  }

  /**
   * No `adjustment` and no `feed`: the option endpoints reject both. A split re-issues an
   * option rather than restating it, and the historical option data has one tape.
   *
   * And no filtering to the session table, which `bars` does for an intraday timespan.
   * That table is the equity calendar, options have no pre- or post-market session to
   * strip, and consulting it would refuse a contract expiring past where it stops for a
   * filter that would remove nothing. The same window therefore returns a different bar
   * count here than from `bars`, deliberately.
   */
  async optionBars(request: OptionBarsRequest): Promise<OptionBarsResponse> {
    const { bars } = await this.optionBarsBySymbol({ ...request, symbols: [request.symbol] });
    return { bars: bars.get(request.symbol) ?? [] };
  }

  /**
   * The same window for many contracts, chunked and paged into one map.
   *
   * Absent rather than empty for a contract that did not trade: an option chain is mostly
   * silent minute to minute — a SPY expiry 40 days out had prints in 83 of its 291 calls
   * over a whole session — and a caller that cannot tell "no trade" from "no such
   * contract" will read a gap as a price.
   */
  async optionBarsBySymbol(request: OptionBarsBySymbolRequest): Promise<OptionBarsBySymbolResponse> {
    const symbols = [...new Set(request.symbols)];
    for (const symbol of symbols) {
      requireOccSymbol(symbol, 'fetch bars');
    }
    const timeframe = resolveTimeframe(request.timespan, request.multiplier);
    const from = startOfDay(request.from);
    const to = endOfDay(request.to);
    requireForwardRange(from, to, 'option bars');

    const bars = new Map<string, ReadonlyArray<Bar>>();
    for (let first = 0; first < symbols.length; first += MAX_BAR_SYMBOLS) {
      const chunk = symbols.slice(first, first + MAX_BAR_SYMBOLS);
      const raw = await this.pageBySymbol<AlpacaBar, AlpacaOptionBarsResponse>('/v1beta1/options/bars', chunk, (body) => body.bars, {
        timeframe,
        start: new Date(from).toISOString(),
        end: new Date(to).toISOString(),
      });
      for (const [symbol, entries] of raw) {
        bars.set(
          symbol,
          entries.map((bar) => normalizeBar(symbol, bar)),
        );
      }
    }
    return { bars };
  }

  async optionTrades(request: OptionTradesRequest): Promise<OptionTradesResponse> {
    requireOccSymbol(request.symbol, 'fetch trades');
    const window = this.resolveWindow(request, 'option trades');
    if (window === undefined) {
      return { trades: [] };
    }

    const raw = await this.page<AlpacaOptionTrade, AlpacaOptionTradesResponse>('/v1beta1/options/trades', request.symbol, (body) => body.trades, window);
    return { trades: raw.map((trade) => normalizeOptionTrade(request.symbol, trade)) };
  }

  /**
   * What a condition character on a trade or a quote means, as the provider states it.
   *
   * The descriptions are the record, not the rule: nothing in "MLET - Multi Leg
   * autoelectronic trade" tells code that such a print is one leg's share of a spread
   * rather than a price for the contract. Deciding that is a caller's job, and this is
   * what it decides against.
   */
  async conditions(request: ConditionsRequest): Promise<ConditionsResponse> {
    if (request.market === 'stocks' && request.tape === undefined) {
      throw new InvalidRequestError('Stock condition codes differ by tape, so this request needs one: A for NYSE-listed, B for the regional exchanges, C for Nasdaq.');
    }
    if (request.market === 'options' && request.tape !== undefined) {
      throw new InvalidRequestError('Option condition codes are the same across exchanges, so an options request does not take a tape.');
    }

    const path = request.market === 'stocks' ? `/v2/stocks/meta/conditions/${request.tickType}` : `/v1beta1/options/meta/conditions/${request.tickType}`;
    const body = await this.get<Record<string, unknown>>(path, { tape: request.tape });
    return { conditions: dictionary(body, `${request.market} ${request.tickType} conditions`) };
  }

  /** What an exchange code on a trade or a quote means. */
  async exchanges(request: ExchangesRequest): Promise<ExchangesResponse> {
    const path = request.market === 'stocks' ? '/v2/stocks/meta/exchanges' : '/v1beta1/options/meta/exchanges';
    const body = await this.get<Record<string, unknown>>(path, {});
    return { exchanges: dictionary(body, `${request.market} exchanges`) };
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

  private corporateActionRange(executionDate: string | undefined): { readonly start: string; readonly end: string } {
    if (executionDate !== undefined) {
      requireIsoDate(executionDate, 'filter corporate actions to an execution date');
      return { start: executionDate, end: executionDate };
    }
    // Given no range Alpaca answers for today only, so "everything" has to be asked for.
    // The far end runs ahead because a split is announced before it happens.
    return { start: EARLIEST_CORPORATE_ACTION, end: easternClock.nextDate(easternClock.date(), 366) };
  }

  private async corporateActions(symbol: string, types: string, range: { readonly start: string; readonly end: string }): Promise<AlpacaCorporateActions[]> {
    const pages: AlpacaCorporateActions[] = [];
    let pageToken: string | undefined = undefined;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await this.get<AlpacaCorporateActionsResponse>('/v1/corporate-actions', {
        symbols: symbol,
        types,
        start: range.start,
        end: range.end,
        limit: 1000,
        page_token: pageToken,
      });
      pages.push(body.corporate_actions ?? {});

      const next = cursor(body);
      if (next === undefined) {
        return pages;
      }
      pageToken = next;
    }

    throw new DataProviderError(SOURCE, `has more than ${MAX_PAGES} pages of corporate actions for ${symbol}. Ask for a shorter range.`);
  }

  /** As `page`, but accumulating every symbol the answer is keyed by rather than one. */
  private async pageBySymbol<T, R>(
    path: string,
    symbols: ReadonlyArray<string>,
    read: (body: R) => Record<string, ReadonlyArray<T> | null> | null | undefined,
    query: Query,
  ): Promise<Map<string, T[]>> {
    const results = new Map<string, T[]>();
    let pageToken: string | undefined = undefined;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body: R = await this.get<R>(path, { ...query, symbols: symbols.join(','), page_token: pageToken });
      for (const [symbol, entries] of Object.entries(read(body) ?? {})) {
        if (entries === null || entries === undefined) {
          continue;
        }
        const seen = results.get(symbol);
        if (seen === undefined) {
          results.set(symbol, [...entries]);
        } else {
          seen.push(...entries);
        }
      }

      const next = cursor(body);
      if (next === undefined) {
        return results;
      }
      pageToken = next;
    }

    throw new DataProviderError(SOURCE, `has more than ${MAX_PAGES} pages of ${path}. Ask for a shorter window.`);
  }

  private async page<T, R>(path: string, symbol: string, read: (body: R) => Record<string, ReadonlyArray<T> | null> | null | undefined, query: Query): Promise<T[]> {
    const results: T[] = [];
    let pageToken: string | undefined = undefined;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body: R = await this.get<R>(path, { ...query, symbols: symbol, page_token: pageToken });
      const bySymbol = read(body) ?? {};
      results.push(...(bySymbol[symbol] ?? []));

      const next = cursor(body);
      if (next === undefined) {
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

/** Absent, null and empty all mean the same thing: that page was the last one. */
function cursor(body: unknown): string | undefined {
  const token = readPageToken(body);
  return token === undefined || token.length === 0 ? undefined : token;
}

function readPageToken(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('next_page_token' in body)) {
    return undefined;
  }
  const token = Reflect.get(body, 'next_page_token');
  return typeof token === 'string' ? token : undefined;
}

/**
 * Alpaca caps a page whatever is asked for — at 10,000 for bars, trades and quotes, and
 * at 1,000 for a chain. One rule rather than one per cap: an unclamped page size once
 * truncated a session silently, and that is not a bug worth finding twice.
 */
function pageSize(requested: number | undefined, what: string, max: number = MAX_PAGE): number {
  if (requested === undefined) {
    return max;
  }
  if (!Number.isFinite(requested) || requested < 1) {
    throw new InvalidRequestError(`A ${what} request needs at least one item per request, got ${requested}.`);
  }
  return Math.min(Math.round(requested), max);
}

function resolveTimeframe(timespan: Timespan, multiplier: number): string {
  const timeframe = TIMEFRAMES[timespan];
  if (timeframe === undefined) {
    throw new InvalidRequestError(`Alpaca does not aggregate by ${timespan}. Use one of [${Object.keys(TIMEFRAMES).join(', ')}].`);
  }
  if (!timeframe.allows(multiplier)) {
    throw new InvalidRequestError(`Alpaca takes ${timeframe.limit} for a ${timespan} timeframe, not ${multiplier}.`);
  }
  return `${multiplier}${timeframe.unit}`;
}

function expirationRange(request: OptionListingRequest): Query {
  const { expirationFrom, expirationTo } = request;
  if (expirationFrom !== undefined) {
    requireIsoDate(expirationFrom, 'read the start of the expiration range');
  }
  if (expirationTo !== undefined) {
    requireIsoDate(expirationTo, 'read the end of the expiration range');
  }
  if (expirationFrom !== undefined && expirationTo !== undefined && expirationFrom > expirationTo) {
    throw new InvalidRequestError(`An expiration range must start before it ends, got ${expirationFrom} to ${expirationTo}.`);
  }
  return { expiration_date_gte: expirationFrom, expiration_date_lte: expirationTo };
}

function strikeRange(request: OptionListingRequest, what: string): Query {
  const { strikeFrom, strikeTo } = request;
  requireStrike(strikeFrom, 'strikeFrom', what);
  requireStrike(strikeTo, 'strikeTo', what);
  if (strikeFrom !== undefined && strikeTo !== undefined && strikeFrom > strikeTo) {
    throw new InvalidRequestError(`A strike range must start below where it ends, got ${strikeFrom} to ${strikeTo}.`);
  }
  return { strike_price_gte: strikeFrom, strike_price_lte: strikeTo };
}

function requireStrike(strike: number | undefined, field: string, what: string): void {
  if (strike !== undefined && (!Number.isFinite(strike) || strike <= 0)) {
    throw new InvalidRequestError(`A ${what}'s ${field} must be a strike in dollars above zero, got ${strike}.`);
  }
}

/**
 * The metadata endpoints answer with a flat code-to-description object rather than the
 * keyed collections everything else uses, so it is read as one rather than paged.
 */
function dictionary(body: Record<string, unknown>, what: string): ReadonlyMap<string, string> {
  // `get` proves this is an object, and an array is one — which would key the codes by
  // position and hand back a dictionary in which every real code is missing.
  if (Array.isArray(body)) {
    throw new DataProviderError(SOURCE, `returned ${what} as a list rather than as codes and their descriptions.`);
  }

  const entries = new Map<string, string>();
  for (const [code, description] of Object.entries(body)) {
    if (typeof description !== 'string') {
      throw new DataProviderError(SOURCE, `returned ${what} in which ${JSON.stringify(code)} maps to something that is not a description.`);
    }
    entries.set(code, description);
  }
  return entries;
}
