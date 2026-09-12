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
  type OptionBarsResponse,
  type OptionType,
  type SplitRatio,
  type StockSplit,
  type StockSplitsRequest,
  type StockSplitsResponse,
} from '@fleece/marketdata';
import { easternClock } from '@fleece/utilities';
import { nanoid } from 'nanoid';

import type { OptionsAvailabilitiesHelper } from '../utils/options-availabilities';
import type { TimeSubscriber } from './time';

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

/** The two shapes a backtest reads. Both have an end this can date, which is why. */
type BarSpan = 'minute' | 'day';

/**
 * How far before the backtest's first instant to load, so an indicator has something to
 * warm up on. Thirty days covers a 20-day moving average on daily bars; a 200-day one
 * wants nearer a year, and says so by throwing rather than by averaging what it found.
 */
const DEFAULT_HISTORY_BUFFER_MS = 30 * MS_PER_DAY;

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

export interface OptionMinuteBarsRequest {
  /** The OCC contract symbol. */
  readonly symbol: string;
  readonly from: DateOrTimestamp;
  /** Defaults to the clock. */
  readonly to?: DateOrTimestamp;
}

export interface OptionDailyBarsRequest {
  /** The OCC contract symbol. */
  readonly symbol: string;
  readonly from: DateOrTimestamp;
  /** Defaults to the clock. */
  readonly to?: DateOrTimestamp;
}

export interface BacktestMarketData extends TimeSubscriber {
  minuteBars(request: MinuteBarsRequest): Promise<BarsResponse>;
  dailyBars(request: DailyBarsRequest): Promise<BarsResponse>;
  stockSplits(request: StockSplitsRequest): Promise<StockSplitsResponse>;
  optionMinuteBars(request: OptionMinuteBarsRequest): Promise<OptionBarsResponse>;
  optionDailyBars(request: OptionDailyBarsRequest): Promise<OptionBarsResponse>;
  listActiveOptionContracts(request: ListActiveOptionContractsRequest): Promise<ListActiveOptionContractsResponse>;
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
function endOfBar(bar: Bar, span: BarSpan): number | undefined {
  return span === 'minute' ? bar.t + MS_PER_MINUTE : marketHour(bar.t)?.closeAt;
}

/** A date names its whole Eastern day; a timestamp is the instant itself. */
function windowStart(value: DateOrTimestamp): number {
  return typeof value === 'number' ? value : easternClock.timestamp(value, '00:00:00');
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
  private readonly barsByKey = new Map<string, Promise<ReadonlyArray<Bar>>>();
  private readonly splitsBySymbol = new Map<string, Promise<ReadonlyArray<StockSplit>>>();

  /** The one window every bars request is served from, fixed for the life of the run. */
  private readonly loadFromDate: string;
  private readonly loadToDate: string;
  private readonly loadFrom: number;

  constructor(
    private readonly client: AlpacaMarketDataClient,
    beginningTimestamp: number,
    endingTimestamp: number,
    private readonly optionsHelper: OptionsAvailabilitiesHelper,
    historyBufferMs: number = DEFAULT_HISTORY_BUFFER_MS,
  ) {
    if (endingTimestamp <= beginningTimestamp) {
      throw new Error(`endingTimestamp ${endingTimestamp} is not after beginningTimestamp ${beginningTimestamp}, so there is no window to load.`);
    }
    if (historyBufferMs < 0) {
      throw new Error(`historyBufferMs must not be negative, got ${historyBufferMs}. It is how far before the run to load, so an indicator has something to warm up on.`);
    }
    this.timeSubscriberId = 'marketdata' + nanoid();
    this.currentTimestamp = 0;
    this.loadFromDate = easternClock.date(beginningTimestamp - historyBufferMs);
    this.loadToDate = easternClock.date(endingTimestamp);
    // A date widens to its whole Eastern day, so this is what the loaded window really opens at.
    this.loadFrom = easternClock.timestamp(this.loadFromDate, '00:00:00');
  }

  async init(timestamp: number): Promise<void> {
    this.currentTimestamp = timestamp;
  }

  async forward(timestamp: number): Promise<void> {
    if (this.currentTimestamp >= timestamp) {
      throw new Error(`The clock moved to ${timestamp}, which is not past the ${this.currentTimestamp} the marketdata is already on. A subscriber is only ever stepped forward.`);
    }
    this.currentTimestamp = timestamp;
  }

  async minuteBars(request: MinuteBarsRequest): Promise<BarsResponse> {
    const key = `minute|${request.symbol}|${request.marketHoursOnly ?? 'default'}`;
    const bars = await this.loadedBars(key, request.from, async (from, to) => await this.client.minuteBars({ ...request, from, to, adjustForSplit: false }));
    return { bars: await this.asOfNow(request.symbol, bars, 'minute', request.from, request.to, request.adjustForSplit) };
  }

  async dailyBars(request: DailyBarsRequest): Promise<BarsResponse> {
    const key = `day|${request.symbol}`;
    const bars = await this.loadedBars(key, request.from, async (from, to) => await this.client.dailyBars({ ...request, from, to, adjustForSplit: false }));
    return { bars: await this.asOfNow(request.symbol, bars, 'day', request.from, request.to, request.adjustForSplit) };
  }

  /** Only the splits that have already executed. One still ahead has not moved a price yet. */
  async stockSplits(request: StockSplitsRequest): Promise<StockSplitsResponse> {
    const executed = (await this.splits(request.symbol)).filter((split) => this.hasExecuted(split));
    return { splits: request.executionDate === undefined ? executed : executed.filter((split) => split.executionDate === request.executionDate) };
  }

  /**
   * Neither of these adjusts for a split, and not by omission: a split re-issues an option
   * under a new symbol with a new strike and multiplier rather than restating its history,
   * so the prints under the old symbol stand as they printed.
   */
  async optionMinuteBars(request: OptionMinuteBarsRequest): Promise<OptionBarsResponse> {
    return { bars: await this.optionBars(request, 'minute') };
  }

  async optionDailyBars(request: OptionDailyBarsRequest): Promise<OptionBarsResponse> {
    return { bars: await this.optionBars(request, 'day') };
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
   * The whole backtest window, buffer included, fetched once per symbol and shape.
   *
   * The window does not move, so the key does not carry one and a request's own `from` and
   * `to` only narrow what has already been loaded. Fetching what the caller asked for
   * instead would re-ask on every step, because a rolling window's end moves with the
   * clock — and what comes back beyond the clock is not visible anyway: `asOfNow` decides
   * that, not the request.
   */
  private loadedBars(key: string, from: DateOrTimestamp, fetch: (from: string, to: string) => Promise<BarsResponse>): Promise<ReadonlyArray<Bar>> {
    if (windowStart(from) < this.loadFrom) {
      throw new Error(
        `Bars were asked for from ${easternClock.datetime(windowStart(from))}, before the ${this.loadFromDate} this run loaded from. Widen historyBufferMs: answering from what happens to be loaded is a short series, not a short answer.`,
      );
    }

    const already = this.barsByKey.get(key);
    if (already !== undefined) {
      return already;
    }
    const loading = fetch(this.loadFromDate, this.loadToDate)
      .then((response) => response.bars)
      .catch((error: unknown) => {
        this.barsByKey.delete(key);
        throw error;
      });
    this.barsByKey.set(key, loading);
    return loading;
  }

  private async optionBars(request: OptionMinuteBarsRequest, span: BarSpan): Promise<ReadonlyArray<Bar>> {
    const key = `option|${span}|${request.symbol}`;
    const bars = await this.loadedBars(key, request.from, async (from, to) => await this.client.optionBars({ symbol: request.symbol, from, to, multiplier: 1, timespan: span }));
    return await this.asOfNow(request.symbol, bars, span, request.from, request.to, false);
  }

  private async asOfNow(
    symbol: string,
    bars: ReadonlyArray<Bar>,
    span: BarSpan,
    from: DateOrTimestamp,
    to: DateOrTimestamp | undefined,
    adjustForSplit: boolean | undefined,
  ): Promise<ReadonlyArray<Bar>> {
    this.requireStarted();
    const start = windowStart(from);
    const end = windowEnd(to);
    const visible = bars.filter((bar) => {
      const finished = endOfBar(bar, span);
      return finished !== undefined && finished <= this.currentTimestamp && bar.t >= start && (end === undefined || bar.t <= end);
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
