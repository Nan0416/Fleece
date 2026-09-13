import {
  adjustPrice,
  endOfDay,
  marketHour,
  splitRatios,
  startOfDay,
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

/** The two shapes a backtest reads. Both have an end this can date, which is why. */
type BarSpan = 'minute' | 'day';

interface TimeWindow {
  readonly startTimestamp: number;
  readonly endTimestamp: number;
}

interface BarSegment {
  readonly timeWindow: TimeWindow;
  barsPromise?: Promise<ReadonlyArray<Bar>>;
}

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

/**
 * Always regular hours, which is the client's default for minute bars. The flag is left off
 * rather than passed through because segments are cached by symbol alone: whichever request
 * came first would decide which hours every later one got back.
 */
export type BacktestMinuteBarsRequest = Omit<MinuteBarsRequest, 'marketHoursOnly'>;

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

export interface MarketData {
  minuteBars(request: BacktestMinuteBarsRequest): Promise<BarsResponse>;
  dailyBars(request: DailyBarsRequest): Promise<BarsResponse>;
  stockSplits(request: StockSplitsRequest): Promise<StockSplitsResponse>;
  optionMinuteBars(request: OptionMinuteBarsRequest): Promise<OptionBarsResponse>;
  optionDailyBars(request: OptionDailyBarsRequest): Promise<OptionBarsResponse>;
  listActiveOptionContracts(request: ListActiveOptionContractsRequest): Promise<ListActiveOptionContractsResponse>;
}

export type BacktestMarketData = MarketData & TimeSubscriber;

function endOfBar(bar: Bar, span: BarSpan): number {
  if (span === 'minute') {
    return bar.t + MS_PER_MINUTE;
  } else {
    const marketClosedAt = marketHour(bar.t)?.closeAt;
    if (typeof marketClosedAt !== 'number') {
      throw new Error(`${easternClock.datetime(bar.t)} doesn't have market hour data.`);
    }
    return marketClosedAt;
  }
}

/**
 * The inputs whose window shares some stretch of time with `timeWindow`, both ends exclusive,
 * so two windows that only touch at an end do not overlap.
 *
 * The same objects come back, not copies, so a caller writing to one writes to the cache.
 *
 * @param inputs sorted by start time and not overlapping each other, so their ends are sorted too.
 * @param timeWindow exclusive at both ends. One that does not end after it starts overlaps nothing.
 */
export function findOverlaps<T extends { readonly timeWindow: TimeWindow }>(inputs: T[], timeWindow: TimeWindow): T[] {
  if (timeWindow.endTimestamp <= timeWindow.startTimestamp) {
    return [];
  }

  // The first input that ends after the window starts.
  let low = 0;
  let high = inputs.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (inputs[mid].timeWindow.endTimestamp <= timeWindow.startTimestamp) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  const overlaps: T[] = [];
  for (let i = low; i < inputs.length && inputs[i].timeWindow.startTimestamp < timeWindow.endTimestamp; i++) {
    overlaps.push(inputs[i]);
  }
  return overlaps;
}

/**
 * Back-to-back segments from 2010-01-01 to 2027-01-01, each a calendar month or year, none
 * of them fetched yet.
 *
 * Every boundary is midnight in New York rather than UTC, so no trading day is split
 * between two segments. Each segment ends at the instant the next one starts, which
 * `findOverlaps` reads as no overlap because both ends are exclusive.
 *
 * New objects on every call: `minuteBars` writes each segment's `barsPromise`, so two
 * symbols sharing one list would serve each other's bars.
 */
export function generatePlaceholderBarSegments(windowSize: '1Year' | '1Month'): BarSegment[] {
  const from = '2010-01-01';
  const to = '2027-01-01';

  const segments: BarSegment[] = [];
  let start = from;
  while (start < to) {
    const end = windowSize === '1Year' ? easternClock.shiftYears(start, 1) : easternClock.shiftMonths(start, 1);
    segments.push({
      timeWindow: {
        startTimestamp: easternClock.timestamp(start, '00:00:00'),
        endTimestamp: easternClock.timestamp(end, '00:00:00'),
      },
      barsPromise: undefined,
    });
    start = end;
  }
  return segments;
}

export class BacktestMarketDataImpl implements BacktestMarketData {
  readonly timeSubscriberId: string;

  private currentTimestamp: number;
  private readonly barsByKey = new Map<string, BarSegment[]>();
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
  }

  async forward(timestamp: number): Promise<void> {
    if (this.currentTimestamp >= timestamp) {
      throw new Error(`The clock moved to ${timestamp}, which is not past the ${this.currentTimestamp} the marketdata is already on. A subscriber is only ever stepped forward.`);
    }
    this.currentTimestamp = timestamp;
  }

  async minuteBars(request: BacktestMinuteBarsRequest): Promise<BarsResponse> {
    const bars = await this.segmentedBars(`stock-minute|${request.symbol}`, '1Month', 'minute', request, (segment) =>
      this.client.minuteBars({ symbol: request.symbol, from: segment.startTimestamp, to: segment.endTimestamp - 1, adjustForSplit: false }),
    );
    return { bars: request.adjustForSplit === true ? await this.adjusted(request.symbol, bars) : bars };
  }

  /** A year a segment: a year of daily bars is about 252 of them, which is one request. */
  async dailyBars(request: DailyBarsRequest): Promise<BarsResponse> {
    const bars = await this.segmentedBars(`stock-day|${request.symbol}`, '1Year', 'day', request, (segment) =>
      this.client.dailyBars({ symbol: request.symbol, from: segment.startTimestamp, to: segment.endTimestamp - 1, adjustForSplit: false }),
    );
    return { bars: request.adjustForSplit === true ? await this.adjusted(request.symbol, bars) : bars };
  }

  /** Only the splits that have already executed. One still ahead has not moved a price yet. */
  async stockSplits(request: StockSplitsRequest): Promise<StockSplitsResponse> {
    // Before the clock starts nothing has executed, so this would answer "never split" —
    // and a caller that believes it prices an unadjusted series as though it were adjusted.
    // The guard runs before the fetch, so asking too early costs no round trip either.
    this.requireStarted();
    const executed = (await this.splits(request.symbol)).filter((split) => this.hasExecuted(split));
    return { splits: request.executionDate === undefined ? executed : executed.filter((split) => split.executionDate === request.executionDate) };
  }

  /**
   * Neither of these adjusts for a split, and not by omission: a split re-issues an option
   * under a new symbol with a new strike and multiplier rather than restating its history,
   * so the prints under the old symbol stand as they printed.
   */
  async optionMinuteBars(request: OptionMinuteBarsRequest): Promise<OptionBarsResponse> {
    const bars = await this.segmentedBars(`option-minute|${request.symbol}`, '1Month', 'minute', request, (segment) =>
      this.client.optionBars({ symbol: request.symbol, from: segment.startTimestamp, to: segment.endTimestamp - 1, multiplier: 1, timespan: 'minute' }),
    );
    return { bars };
  }

  async optionDailyBars(request: OptionDailyBarsRequest): Promise<OptionBarsResponse> {
    const bars = await this.segmentedBars(`option-day|${request.symbol}`, '1Year', 'day', request, (segment) =>
      this.client.optionBars({ symbol: request.symbol, from: segment.startTimestamp, to: segment.endTimestamp - 1, multiplier: 1, timespan: 'day' }),
    );
    return { bars };
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
   * The bars of one series inside the requested window that have finished by the clock,
   * fetched a segment at a time, each segment once.
   *
   * `fetch` is handed the segment and asks for one millisecond short of its end. The client
   * treats `to` as inclusive, and a daily bar is stamped at midnight in New York, which is
   * exactly where one segment ends and the next starts: asking for the whole segment would
   * return that day's bar from both.
   */
  private async segmentedBars(
    key: string,
    windowSize: '1Year' | '1Month',
    span: BarSpan,
    request: { readonly from: DateOrTimestamp; readonly to?: DateOrTimestamp },
    fetch: (segment: TimeWindow) => Promise<{ readonly bars: ReadonlyArray<Bar> }>,
  ): Promise<Bar[]> {
    // Before the clock starts every bar is filtered out, which reads as a symbol with no data.
    const now = this.requireStarted();

    const barSegments = this.barsByKey.get(key) ?? generatePlaceholderBarSegments(windowSize);
    this.barsByKey.set(key, barSegments);

    const requestedTimeWindow: TimeWindow = {
      startTimestamp: startOfDay(request.from),
      endTimestamp: endOfDay(request.to ?? now),
    };

    // Past the segments `findOverlaps` returns only the part they cover: a short series, and
    // nothing to say so. Checked against the clock rather than `to`, since a `to` still ahead
    // of it asks for nothing more than the clock allows.
    const loadedFrom = barSegments[0].timeWindow.startTimestamp;
    const loadedTo = barSegments[barSegments.length - 1].timeWindow.endTimestamp;
    if (requestedTimeWindow.startTimestamp < loadedFrom || Math.min(requestedTimeWindow.endTimestamp, now) > loadedTo) {
      throw new Error(
        `${key} bars were asked for from ${easternClock.datetime(requestedTimeWindow.startTimestamp)} to ${easternClock.datetime(Math.min(requestedTimeWindow.endTimestamp, now))}, outside the ${easternClock.datetime(loadedFrom)} to ${easternClock.datetime(loadedTo)} a backtest loads. Widen the range in generatePlaceholderBarSegments.`,
      );
    }

    const loading = findOverlaps(barSegments, requestedTimeWindow).map(
      (segment) =>
        (segment.barsPromise ??= fetch(segment.timeWindow)
          .then((response) => response.bars)
          .catch((error: unknown) => {
            // Left in place, the rejection would answer every later request for this segment
            // without asking again, for the rest of the run.
            segment.barsPromise = undefined;
            throw error;
          })),
    );

    let visibleBars: Bar[] = [];
    for (const bars of loading) {
      visibleBars = visibleBars.concat((await bars).filter((bar) => this.filterBar(bar, span, requestedTimeWindow)));
    }
    return visibleBars;
  }

  private filterBar(bar: Bar, span: BarSpan, requestedTimeWindow: TimeWindow): boolean {
    return bar.t >= requestedTimeWindow.startTimestamp && endOfBar(bar, span) < Math.min(requestedTimeWindow.endTimestamp, this.currentTimestamp);
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
