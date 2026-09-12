import {
  adjustPrice,
  marketHour,
  splitRatios,
  type AlpacaMarketDataClient,
  type Bar,
  type BarsResponse,
  type DailyBarsRequest,
  type DateOrTimestamp,
  type MinuteBarsRequest,
  type OccSymbol,
  type OptionBarsRequest,
  type OptionBarsResponse,
  type OptionType,
  type SplitRatio,
  type StockSplit,
  type StockSplitsRequest,
  type StockSplitsResponse,
  type Timespan,
} from '@fleece/marketdata';
import { easternClock } from '@fleece/utilities';
import { nanoid } from 'nanoid';

import type { OptionsAvailabilitiesHelper } from '../utils/options-availabilities';
import type { TimeSubscriber } from './time';

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

export interface ListActiveOptionContractsRequest {
  /** The underlying ticker, not a contract symbol. */
  readonly underlying: string;
  readonly type?: OptionType;
  /** Inclusive, ISO `YYYY-MM-DD`. Set both to the same date for one expiry. */
  readonly expirationFrom?: string;
  readonly expirationTo?: string;
  /** Inclusive, in dollars. */
  readonly strikeFrom?: number;
  readonly strikeTo?: number;
}

export interface ListActiveOptionContractsResponse {
  readonly contracts: ReadonlyArray<OccSymbol>;
}

export interface BacktestMarketData extends TimeSubscriber {
  minuteBars(request: MinuteBarsRequest): Promise<BarsResponse>;
  dailyBars(request: DailyBarsRequest): Promise<BarsResponse>;
  stockSplits(request: StockSplitsRequest): Promise<StockSplitsResponse>;
  optionBars(request: OptionBarsRequest): Promise<OptionBarsResponse>;
  listActiveOptionContracts(request: ListActiveOptionContractsRequest): Promise<ListActiveOptionContractsResponse>;
}

/** One symbol's bars for a window, kept until the day they were fetched through is over. */
interface CachedBars {
  readonly throughDate: string;
  readonly bars: ReadonlyArray<Bar>;
}

/**
 * The instant a bar is finished, and so the earliest a strategy may have seen its close.
 *
 * A bar is an interval, not an instant: the minute bar stamped 10:00 covers 10:00 to
 * 10:01 and its close is not known until 10:01. Admitting it at 10:00 hands every
 * strategy a minute of the future on every bar, which is enough to make almost anything
 * look profitable. A daily bar ends at its own session close — 16:00, or 13:00 on a half
 * day, which no rule derives and the market-hours table has.
 */
function endOfBar(bar: Bar, timespan: Timespan, multiplier: number): number | undefined {
  switch (timespan) {
    case 'minute':
      return bar.t + multiplier * MS_PER_MINUTE;
    case 'hour':
      return bar.t + multiplier * MS_PER_HOUR;
    case 'day':
      return marketHour(bar.t)?.closeAt;
    default:
      return undefined;
  }
}

function requireDatableTimespan(timespan: Timespan, what: string): void {
  if (timespan !== 'minute' && timespan !== 'hour' && timespan !== 'day') {
    throw new Error(
      `A backtest cannot serve ${timespan} ${what}: there is no saying when such a bar finished, and a bar admitted early is a strategy reading the future. Ask for minute, hour or day.`,
    );
  }
}

function easternDate(value: DateOrTimestamp): string {
  return typeof value === 'string' ? value : easternClock.date(value);
}

/** A date names its whole Eastern day; a timestamp is the instant itself. */
function windowEnd(value: DateOrTimestamp | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === 'number' ? value : easternClock.timestamp(value, '23:59:59');
}

/**
 * Market data as of one instant, over `AlpacaMarketDataClient`.
 *
 * Everything here exists to answer with what was knowable then rather than what is known
 * now. Bars are filtered to those that had finished, splits to those that had executed,
 * and an adjustment applies only the splits already behind the clock — asking Alpaca for
 * adjusted bars would hand back a series restated for a split months in the future, and
 * nothing about the numbers would look wrong.
 *
 *     const data = new BacktestMarketDataImpl(client, availabilities);
 *     clock.subscribe(data);
 *     await data.dailyBars({ symbol: 'AMZN', from: '2024-03-01' }); // nothing after the clock
 */
export class BacktestMarketDataImpl implements BacktestMarketData {
  readonly timeSubscriberId: string;

  private currentTimestamp: number;
  private readonly barsByKey = new Map<string, CachedBars>();
  private readonly splitsBySymbol = new Map<string, Promise<ReadonlyArray<StockSplit>>>();

  constructor(
    private readonly client: AlpacaMarketDataClient,
    private readonly optionsHelper: OptionsAvailabilitiesHelper,
  ) {
    this.timeSubscriberId = 'marketdata' + nanoid();
    this.currentTimestamp = 0;
  }

  async init(timestamp: number): Promise<void> {
    this.currentTimestamp = timestamp;
    // todo: preload data?
  }

  async forward(timestamp: number): Promise<void> {
    if (this.currentTimestamp >= timestamp) {
      throw new Error(`The clock moved to ${timestamp}, which is not past the ${this.currentTimestamp} the marketdata is already on. A subscriber is only ever stepped forward.`);
    }
    this.currentTimestamp = timestamp;
  }

  async minuteBars(request: MinuteBarsRequest): Promise<BarsResponse> {
    const key = `minute|${request.symbol}|${request.marketHoursOnly ?? 'default'}`;
    const bars = await this.stockBars(
      key,
      request.symbol,
      request.from,
      'minute',
      async (from, to) => await this.client.minuteBars({ ...request, from, to, adjustForSplit: false }),
    );
    return { bars: await this.asOfNow(request.symbol, bars, 'minute', 1, request.to, request.adjustForSplit) };
  }

  async dailyBars(request: DailyBarsRequest): Promise<BarsResponse> {
    const key = `day|${request.symbol}`;
    const bars = await this.stockBars(key, request.symbol, request.from, 'day', async (from, to) => await this.client.dailyBars({ ...request, from, to, adjustForSplit: false }));
    return { bars: await this.asOfNow(request.symbol, bars, 'day', 1, request.to, request.adjustForSplit) };
  }

  /** Only the splits that have already executed. One still ahead has not moved a price yet. */
  async stockSplits(request: StockSplitsRequest): Promise<StockSplitsResponse> {
    const executed = (await this.splits(request.symbol)).filter((split) => this.hasExecuted(split));
    return { splits: request.executionDate === undefined ? executed : executed.filter((split) => split.executionDate === request.executionDate) };
  }

  /**
   * No split adjustment, and not by omission: a split re-issues an option under a new
   * symbol with a new strike and multiplier rather than restating its history, which is
   * why `OptionBarsRequest` carries no `adjustForSplit` to honour.
   */
  async optionBars(request: OptionBarsRequest): Promise<OptionBarsResponse> {
    requireDatableTimespan(request.timespan, 'option bars');
    const key = `option|${request.symbol}|${request.timespan}|${request.multiplier}`;
    const bars = await this.stockBars(key, request.symbol, request.from, request.timespan, async (from, to) => await this.client.optionBars({ ...request, from, to }));
    return { bars: await this.asOfNow(request.symbol, bars, request.timespan, request.multiplier, request.to, false) };
  }

  async listActiveOptionContracts(request: ListActiveOptionContractsRequest): Promise<ListActiveOptionContractsResponse> {
    const symbols = await this.optionsHelper.availableOptions(request.underlying, this.requireStarted());
    const contracts = symbols
      .filter((symbol) => request.type === undefined || request.type === symbol.type)
      .filter((symbol) => request.expirationFrom === undefined || request.expirationFrom <= symbol.expiration)
      .filter((symbol) => request.expirationTo === undefined || request.expirationTo >= symbol.expiration)
      .filter((symbol) => request.strikeFrom === undefined || request.strikeFrom <= symbol.strike)
      .filter((symbol) => request.strikeTo === undefined || request.strikeTo >= symbol.strike);
    return { contracts };
  }

  /**
   * Fetched through the current day rather than the requested `to`, so one call serves
   * every minute of a session: the whole day comes back and the clock decides which of it
   * is visible. Keying the fetch on the caller's own `to` would re-ask on every step,
   * since a rolling window's end moves with the clock.
   */
  private async stockBars(
    key: string,
    symbol: string,
    from: DateOrTimestamp,
    timespan: Timespan,
    fetch: (from: string, to: string) => Promise<BarsResponse>,
  ): Promise<ReadonlyArray<Bar>> {
    requireDatableTimespan(timespan, 'bars');
    const through = easternClock.date(this.requireStarted());
    const fromDate = easternDate(from);
    if (fromDate > through) {
      // A window that has not started yet. Asking the client would be a backwards range.
      return [];
    }

    const cacheKey = `${key}|${fromDate}`;
    const cached = this.barsByKey.get(cacheKey);
    if (cached !== undefined && cached.throughDate === through) {
      return cached.bars;
    }
    const { bars } = await fetch(fromDate, through);
    this.barsByKey.set(cacheKey, { throughDate: through, bars });
    return bars;
  }

  private async asOfNow(
    symbol: string,
    bars: ReadonlyArray<Bar>,
    timespan: Timespan,
    multiplier: number,
    to: DateOrTimestamp | undefined,
    adjustForSplit: boolean | undefined,
  ): Promise<ReadonlyArray<Bar>> {
    const end = windowEnd(to);
    const visible = bars.filter((bar) => {
      const finished = endOfBar(bar, timespan, multiplier);
      return finished !== undefined && finished <= this.currentTimestamp && (end === undefined || bar.t <= end);
    });
    return adjustForSplit === true ? await this.adjusted(symbol, visible) : visible;
  }

  /**
   * Restated in the shares outstanding **now**, where now is the clock rather than today.
   * A split still ahead of the clock has not happened, so restating for it would price a
   * position in shares nobody holds yet.
   */
  private async adjusted(symbol: string, bars: ReadonlyArray<Bar>): Promise<ReadonlyArray<Bar>> {
    const ratios = (await this.ratios(symbol)).filter((ratio) => ratio.before <= this.currentTimestamp);
    if (ratios.length === 0 || bars.length === 0) {
      return bars;
    }
    return bars.map((bar) => {
      // `adjustPrice` against 1 is the compound ratio of every split after this bar, which
      // is the same figure each price needs and the reciprocal of what the volume needs:
      // a one-for-four split quarters the price and quadruples the shares.
      const factor = adjustPrice(1, bar.t, ratios);
      return {
        ...bar,
        o: bar.o * factor,
        h: bar.h * factor,
        l: bar.l * factor,
        c: bar.c * factor,
        v: factor > 0 ? Math.round(bar.v / factor) : bar.v,
      };
    });
  }

  private async ratios(symbol: string): Promise<ReadonlyArray<SplitRatio>> {
    return splitRatios([...(await this.splits(symbol))]);
  }

  /** Every split the provider knows of, fetched once: which of them count is a read-time question. */
  private splits(symbol: string): Promise<ReadonlyArray<StockSplit>> {
    const already = this.splitsBySymbol.get(symbol);
    if (already !== undefined) {
      return already;
    }
    const loading = this.client
      .stockSplits({ symbol })
      .then((response) => response.splits)
      .catch((error: unknown) => {
        this.splitsBySymbol.delete(symbol);
        throw error;
      });
    this.splitsBySymbol.set(symbol, loading);
    return loading;
  }

  private hasExecuted(split: StockSplit): boolean {
    return easternClock.timestamp(split.executionDate, '00:00:00') <= this.currentTimestamp;
  }

  /**
   * Before the clock starts every window is empty, which reads as a symbol that never
   * traded rather than as a question asked too early.
   */
  private requireStarted(): number {
    if (this.currentTimestamp === 0) {
      throw new Error('The backtest clock has not started, so there is no instant to read market data as of. Subscribe this to a Time and call init() before asking.');
    }
    return this.currentTimestamp;
  }
}
