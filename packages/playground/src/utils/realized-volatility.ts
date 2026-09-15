import { isTradingDay, marketHour, marketHourByIndex, type Bar, type MarketHour, type StockRestClient } from '@fleece/marketdata';
import { easternClock, LoggerFactory } from '@fleece/utilities';
import { nanoid } from 'nanoid';

import type { TimeSubscriber } from '../backtest/time';

const logger = LoggerFactory.getLogger('HistoricalRealizedVolatilityLoader');

const MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MINUTE;

/** What a variance per session is annualized with. Implied volatility is on a 365-day calendar instead; see `calendarClockVolatility`. */
export const SESSIONS_PER_YEAR = 252;
const DAYS_PER_YEAR = 365;

/** Every interval a session's intraday variance is measured at, so the intervals can be compared. */
export const SAMPLING_MINUTES: ReadonlyArray<number> = [1, 2, 5, 10, 15, 30];

/**
 * How long after its minute ends Alpaca publishes a minute bar, the figure the backtest's market
 * data holds a bar back by. The close is the closing auction, which prints in the minute bar
 * starting at the close, so a session is known a minute and this long after it closes.
 */
const BAR_PUBLISH_DELAY = 4_000;

/** A session's intraday variance at one sampling interval. */
export interface IntradaySample {
  readonly minutes: number;
  /** The sum of the session's squared log returns at this interval. */
  readonly variance: number;
}

/**
 * One session's returns, split where every estimator here splits them: the gap from the previous
 * close to the open, and the path from the open to the close. Prices are the official auction open
 * and close from the daily bar, restated for splits.
 */
export interface SessionReturns {
  readonly date: string;
  /** Calendar days since the previous session: 1 overnight, 3 over a weekend. */
  readonly gapDays: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  /** ln(open / previous close). */
  readonly overnight: number;
  /** ln(close / open). */
  readonly openToClose: number;
  /** ln(close / previous close), which is overnight + openToClose. */
  readonly closeToClose: number;
  /**
   * Rogers-Satchell: u(u − c) + d(d − c), with u = ln(high / open), d = ln(low / open) and c the
   * open-to-close return. The session's intraday variance read from its range, which, unlike
   * Parkinson's, a stock trending through the session does not inflate.
   */
  readonly rogersSatchell: number;
  /** At each of `SAMPLING_MINUTES`. */
  readonly intraday: ReadonlyArray<IntradaySample>;
}

/** Variances per session over a trailing window. Square-root them through `annualizedVolatility` or `calendarClockVolatility`. */
export interface TrailingVariance {
  readonly sessions: number;
  /** Σ r² / n, over close-to-close returns. */
  readonly closeToClose: number;
  /** Σ (o² + intraday) / n, with intraday at the loader's `intradayMinutes`. */
  readonly intradayPlusOvernight: number;
  readonly yangZhang: number;
  /** The overnight gaps' part of `intradayPlusOvernight`, from 0 to 1. */
  readonly overnightShare: number;
}

export interface RealizedVolatilityPoint {
  readonly date: string;
  /** When a strategy could first know it: the closing auction's minute bar, published. */
  readonly publishedAt: number;
  readonly session: SessionReturns;
  /** Over the window of sessions ending with this one, this one included. */
  readonly trailing: TrailingVariance;
}

/** What actually happened over a stretch of calendar days: close-to-close, on implied volatility's clock. */
export interface RealizedWindow {
  readonly sessions: number;
  /** Σ r² over the window's sessions: total variance, not per session. */
  readonly variance: number;
  /** √(variance × 365 / calendar days), which is what an implied volatility over those days is quoted as. */
  readonly volatility: number;
  /** The largest overnight gap in the window, as an absolute log return, which is where an earnings report shows. */
  readonly largestGap: number;
}

// ─── One session ────────────────────────────────────────────────────────────────────────────

/**
 * The session's intraday variance sampled every `minutes`: the price at the end of each bucket is
 * the close of the last minute bar in it, and a bucket nothing traded in holds the price, a return
 * of zero. Summed rather than averaged, because variance adds over time and this is the session's.
 *
 * The path starts at the official open and ends at the official close rather than at the first
 * and last minute bars. The opening auction can print away from the 09:30 bar's first trade, and
 * the closing auction prints in the 16:00 bar that regular hours leave out. Anchored to those,
 * the returns add up to ln(close / open) exactly, so the intraday and overnight pieces meet at the
 * prices Yang-Zhang uses.
 */
export function intradayVariance(bars: ReadonlyArray<Bar>, hour: Pick<MarketHour, 'openAt' | 'closeAt'>, open: number, close: number, minutes: number): number {
  const step = minutes * MINUTE;
  const buckets = Math.ceil((hour.closeAt - hour.openAt) / step);
  const prices: Array<number | undefined> = new Array<number | undefined>(buckets).fill(undefined);
  for (const bar of bars) {
    const bucket = Math.floor((bar.t - hour.openAt) / step);
    if (bucket >= 0 && bucket < buckets) {
      // Bars arrive in time order, so the last one written to a bucket is its latest.
      prices[bucket] = bar.c;
    }
  }
  prices[buckets - 1] = close;

  let previous = open;
  let variance = 0;
  for (const price of prices) {
    if (price === undefined) {
      continue;
    }
    const r = Math.log(price / previous);
    variance += r * r;
    previous = price;
  }
  return variance;
}

/** One session from its daily bar, the daily bar before it, and its regular-hours minute bars. */
export function measureSession(daily: Bar, previous: Bar, hour: MarketHour, previousHour: MarketHour, minuteBars: ReadonlyArray<Bar>): SessionReturns {
  const overnight = Math.log(daily.o / previous.c);
  const openToClose = Math.log(daily.c / daily.o);
  const u = Math.log(daily.h / daily.o);
  const d = Math.log(daily.l / daily.o);
  return {
    date: hour.date,
    // Rounded, since a daylight-saving change makes one of these 23 or 25 hours.
    gapDays: Math.round((easternClock.timestamp(hour.date) - easternClock.timestamp(previousHour.date)) / MS_PER_DAY),
    open: daily.o,
    high: daily.h,
    low: daily.l,
    close: daily.c,
    overnight,
    openToClose,
    closeToClose: overnight + openToClose,
    rogersSatchell: u * (u - openToClose) + d * (d - openToClose),
    intraday: SAMPLING_MINUTES.map((minutes) => ({ minutes, variance: intradayVariance(minuteBars, hour, daily.o, daily.c, minutes) })),
  };
}

/** The session's intraday variance at `minutes`, which must be one of `SAMPLING_MINUTES`. */
export function intradayVarianceAt(session: SessionReturns, minutes: number): number {
  const sample = session.intraday.find((candidate) => candidate.minutes === minutes);
  if (sample === undefined) {
    throw new Error(`${session.date} has no intraday variance at ${minutes} minutes. Sample at one of ${SAMPLING_MINUTES.join(', ')}.`);
  }
  return sample.variance;
}

// ─── A window of sessions: each a variance per session ─────────────────────────────────────

function mean(values: ReadonlyArray<number>): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Σ r² / n. Zero-mean: over a month the average return is noise, and subtracting it reads a stock's slide as calm. */
export function closeToCloseVariance(sessions: ReadonlyArray<SessionReturns>): number {
  return mean(sessions.map((session) => session.closeToClose ** 2));
}

/** Σ (o² + intraday) / n: the one overnight return each session has, plus its path at `minutes`. */
export function intradayPlusOvernightVariance(sessions: ReadonlyArray<SessionReturns>, minutes: number): number {
  return mean(sessions.map((session) => session.overnight ** 2 + intradayVarianceAt(session, minutes)));
}

/**
 * Yang-Zhang, as published:
 *
 *   σ² = σ²_O + k·σ²_C + (1 − k)·σ²_RS,   k = 0.34 / (1.34 + (n + 1) / (n − 1))
 *
 * σ²_O and σ²_C are the sample variances of the overnight and open-to-close returns, and σ²_RS the
 * mean Rogers-Satchell term. Unlike the other two it subtracts the mean, as the paper does, which
 * over a month pulls it low when the stock trends.
 */
export function yangZhangVariance(sessions: ReadonlyArray<SessionReturns>): number {
  const n = sessions.length;
  if (n < 2) {
    throw new Error(`Yang-Zhang needs at least two sessions to take a sample variance over, got ${n}.`);
  }
  const overnightMean = mean(sessions.map((session) => session.overnight));
  const openToCloseMean = mean(sessions.map((session) => session.openToClose));
  const overnight = sessions.reduce((sum, session) => sum + (session.overnight - overnightMean) ** 2, 0) / (n - 1);
  const openToClose = sessions.reduce((sum, session) => sum + (session.openToClose - openToCloseMean) ** 2, 0) / (n - 1);
  const rogersSatchell = mean(sessions.map((session) => session.rogersSatchell));
  const k = 0.34 / (1.34 + (n + 1) / (n - 1));
  return overnight + k * openToClose + (1 - k) * rogersSatchell;
}

export function trailingVariance(sessions: ReadonlyArray<SessionReturns>, intradayMinutes: number): TrailingVariance {
  const intradayPlusOvernight = intradayPlusOvernightVariance(sessions, intradayMinutes);
  return {
    sessions: sessions.length,
    closeToClose: closeToCloseVariance(sessions),
    intradayPlusOvernight,
    yangZhang: yangZhangVariance(sessions),
    overnightShare: mean(sessions.map((session) => session.overnight ** 2)) / intradayPlusOvernight,
  };
}

// ─── Clocks ─────────────────────────────────────────────────────────────────────────────────

/** √(variance per session × 252). */
export function annualizedVolatility(variancePerSession: number): number {
  return Math.sqrt(variancePerSession * SESSIONS_PER_YEAR);
}

/** The sessions dated after `date` and no more than `calendarDays` after it. */
export function sessionsWithin(date: string, calendarDays: number): number {
  let count = 0;
  for (let day = 1; day <= calendarDays; day++) {
    if (isTradingDay(easternClock.shiftDate(date, day))) {
      count += 1;
    }
  }
  return count;
}

/**
 * A variance per session restated on implied volatility's clock: the total variance of the
 * sessions the next `calendarDays` hold, per 365-day year. A weekend adds calendar days but no
 * session, and its gap is already in Monday's overnight return, so it adds no variance of its own.
 */
export function calendarClockVolatility(variancePerSession: number, date: string, calendarDays: number): number {
  return Math.sqrt((variancePerSession * sessionsWithin(date, calendarDays) * DAYS_PER_YEAR) / calendarDays);
}

/**
 * What was realized close to close over the `calendarDays` after `date`: what a seller at that
 * close lived through. Uses the future, so it is for grading a history, never for a strategy.
 *
 * `undefined` unless `sessions` holds every session in the window, which near the end of a
 * history they do not.
 */
export function realizedAfter(sessions: ReadonlyArray<SessionReturns>, date: string, calendarDays: number): RealizedWindow | undefined {
  const end = easternClock.shiftDate(date, calendarDays);
  const window = sessions.filter((session) => session.date > date && session.date <= end);
  const expected = sessionsWithin(date, calendarDays);
  if (expected === 0 || window.length !== expected) {
    return undefined;
  }
  const variance = window.reduce((sum, session) => sum + session.closeToClose ** 2, 0);
  return {
    sessions: window.length,
    variance,
    volatility: Math.sqrt((variance * DAYS_PER_YEAR) / calendarDays),
    largestGap: Math.max(...window.map((session) => Math.abs(session.overnight))),
  };
}

// ─── Loading and reading ────────────────────────────────────────────────────────────────────

function firstSessionOnOrAfter(date: string): MarketHour | undefined {
  for (let day = 0; day < 14; day++) {
    const hour = marketHour(easternClock.shiftDate(date, day));
    if (hour !== undefined) {
      return hour;
    }
  }
  return undefined;
}

function publishedAt(hour: Pick<MarketHour, 'closeAt'>): number {
  return hour.closeAt + MINUTE + BAR_PUBLISH_DELAY;
}

/**
 * The last session on or before `date` whose close was published by `now`. A provider hands back
 * a session still trading as a daily bar like any other, and measured, its latest price would
 * read as the close.
 */
function lastPublishedSessionOnOrBefore(date: string, now: number): MarketHour | undefined {
  let hour: MarketHour | undefined;
  for (let day = 0; day < 14 && hour === undefined; day++) {
    hour = marketHour(easternClock.shiftDate(date, -day));
  }
  while (hour !== undefined && publishedAt(hour) >= now) {
    hour = marketHourByIndex(hour.index - 1);
  }
  return hour;
}

export interface HistoricalRealizedVolatilityLoaderProps {
  readonly symbol: string;
  /**
   * Where the bars come from. A session is split at its daily bar's open and close, which are
   * taken to be the official auction prints, as Alpaca's are; check another provider's before
   * handing it in.
   */
  readonly client: StockRestClient;
  /** The first session a point is taken for, Eastern `YYYY-MM-DD`. The window before it is fetched too. */
  readonly fromDate: string;
  /** The last, through its close. A session not closed by the time of loading is left out. */
  readonly toDate: string;
  /** Sessions in a trailing estimate. 21 is about a month, to sit beside a 30-day implied volatility. */
  readonly window: number;
  /**
   * The interval `intradayPlusOvernight` samples at, one of `SAMPLING_MINUTES`: the finest whose
   * mean variance over a symbol's sessions has not climbed above the coarser intervals', which is
   * the bid-ask bounce showing. 1 for SOFI and AAPL; 5 or 10 for a thinly traded name.
   */
  readonly intradayMinutes: number;
}

interface LoadedHistory {
  readonly points: ReadonlyArray<RealizedVolatilityPoint>;
  readonly sessions: ReadonlyArray<SessionReturns>;
}

/**
 * Measures an underlying's sessions over a date range once, and the trailing realized volatility
 * at each, so any number of backtests can read it through a `HistoricalRealizedVolatility` of
 * their own.
 *
 *     const loader = new HistoricalRealizedVolatilityLoader({ symbol: 'AAPL', client, fromDate, toDate, window: 21, intradayMinutes: 5 });
 *     await loader.load();
 *     time.subscribe(data).subscribe(loader.buildTimeSubscriber());
 */
export class HistoricalRealizedVolatilityLoader {
  readonly symbol: string;
  readonly fromDate: string;
  readonly toDate: string;
  readonly window: number;
  readonly intradayMinutes: number;

  private readonly client: StockRestClient;
  private loaded: LoadedHistory | undefined;

  constructor(props: HistoricalRealizedVolatilityLoaderProps) {
    // Yang-Zhang takes a sample variance, and one session has none.
    if (!Number.isInteger(props.window) || props.window < 2) {
      throw new Error(`The window must be a whole number of sessions, at least 2, got ${props.window}.`);
    }
    if (!SAMPLING_MINUTES.includes(props.intradayMinutes)) {
      throw new Error(`Intraday variance is measured at ${SAMPLING_MINUTES.join(', ')} minutes, not ${props.intradayMinutes}. Pick one of those.`);
    }
    this.symbol = props.symbol.trim().toUpperCase();
    this.fromDate = props.fromDate;
    this.toDate = props.toDate;
    this.window = props.window;
    this.intradayMinutes = props.intradayMinutes;
    this.client = props.client;
    this.loaded = undefined;
  }

  /**
   * Fetches the daily and minute bars from `window + 1` sessions before the range, so its first
   * point has a full window and a previous close, and measures every session.
   *
   * Split-adjusted, so a split in the range restates the prices before it rather than showing as
   * a −50% overnight return.
   *
   * @param now what counts as closed: the range stops at the last session published by then.
   */
  async load(now: number = Date.now()): Promise<void> {
    const first = firstSessionOnOrAfter(this.fromDate);
    const last = lastPublishedSessionOnOrBefore(this.toDate, now);
    if (first === undefined || last === undefined || first.date > last.date) {
      throw new Error(`${this.symbol}: no session from ${this.fromDate} to ${this.toDate} has closed by ${easternClock.datetime(now)}. Check the dates.`);
    }
    const warmUp = marketHourByIndex(first.index - this.window - 1);
    if (warmUp === undefined) {
      throw new Error(`${this.symbol}: the market-hours table has no session ${this.window + 1} before ${first.date} to start the window from. Start the range later.`);
    }

    logger.info(`${this.symbol}: fetching daily and minute bars from ${warmUp.date} to ${last.date}.`);
    const [{ bars: dailyBars }, { bars: minuteBars }] = await Promise.all([
      this.client.dailyBars({ symbol: this.symbol, from: warmUp.date, to: last.date, adjustForSplit: true }),
      this.client.minuteBars({ symbol: this.symbol, from: warmUp.date, to: last.date, adjustForSplit: true }),
    ]);

    const minuteBarsByDate = new Map<string, Bar[]>();
    for (const bar of minuteBars) {
      const date = easternClock.date(bar.t);
      const bars = minuteBarsByDate.get(date) ?? [];
      bars.push(bar);
      minuteBarsByDate.set(date, bars);
    }

    const sessions: SessionReturns[] = [];
    const hours: MarketHour[] = [];
    for (let i = 1; i < dailyBars.length; i++) {
      const hour = marketHour(easternClock.date(dailyBars[i].t));
      const previousHour = marketHour(easternClock.date(dailyBars[i - 1].t));
      const bars = hour === undefined ? undefined : minuteBarsByDate.get(hour.date);
      if (hour === undefined || previousHour === undefined || bars === undefined) {
        logger.warn(`${this.symbol}: the daily bar at ${easternClock.datetime(dailyBars[i].t)} has no session or no minute bars. Leaving it out.`);
        continue;
      }
      // A missing session would put two days of moves into one overnight return.
      if (previousHour.index !== hour.index - 1) {
        logger.warn(`${this.symbol}: no bar for the session before ${hour.date}, so its overnight return would span more than one gap. Leaving it out.`);
        continue;
      }
      sessions.push(measureSession(dailyBars[i], dailyBars[i - 1], hour, previousHour, bars));
      hours.push(hour);
    }

    const points: RealizedVolatilityPoint[] = [];
    let short = 0;
    for (let i = 0; i < sessions.length; i++) {
      const hour = hours[i];
      if (hour.date < first.date || hour.date > last.date) {
        continue;
      }
      // By the table rather than by count: a window reaching back past a session left out
      // would stretch over more time than it says.
      const start = i - this.window + 1;
      if (start < 0 || hours[start].index !== hour.index - this.window + 1) {
        short += 1;
        continue;
      }
      points.push({
        date: hour.date,
        publishedAt: publishedAt(hour),
        session: sessions[i],
        trailing: trailingVariance(sessions.slice(start, i + 1), this.intradayMinutes),
      });
    }
    if (short > 0) {
      logger.warn(`${this.symbol}: ${short} sessions from ${first.date} to ${last.date} have fewer than ${this.window} consecutive sessions behind them, and have no point.`);
    }
    logger.info(`${this.symbol}: ${points.length} points from ${first.date} to ${last.date}, over ${sessions.length} sessions measured.`);

    this.loaded = { points: Object.freeze(points), sessions: Object.freeze(sessions) };
  }

  /**
   * Every point, future ones included, in time order. For studying the history, not for a
   * strategy: a strategy reads it through `buildTimeSubscriber`, which shows only what its clock
   * could have known.
   */
  getPoints(): ReadonlyArray<RealizedVolatilityPoint> {
    return this.requireLoaded().points;
  }

  /** Every session measured, the window before the range included, in time order. What `realizedAfter` reads. */
  getSessions(): ReadonlyArray<SessionReturns> {
    return this.requireLoaded().sessions;
  }

  /** A reader for one backtest, with its own clock over the points this loaded. */
  buildTimeSubscriber(): HistoricalRealizedVolatility {
    return new HistoricalRealizedVolatility({ symbol: this.symbol, fromDate: this.fromDate, toDate: this.toDate, points: this.requireLoaded().points });
  }

  private requireLoaded(): LoadedHistory {
    if (this.loaded === undefined) {
      throw new Error(`${this.symbol}'s realized volatility from ${this.fromDate} to ${this.toDate} is not loaded yet. Call load() first.`);
    }
    return this.loaded;
  }
}

export interface HistoricalRealizedVolatilityProps {
  readonly symbol: string;
  /** The first date measured, Eastern `YYYY-MM-DD`. A backtest reading the history must start on or after it. */
  readonly fromDate: string;
  /** The last date measured, through its close. A backtest reading the history must end by it. */
  readonly toDate: string;
  /** In time order, as a loader takes them. */
  readonly points: ReadonlyArray<RealizedVolatilityPoint>;
}

/** A precomputed realized volatility history for a backtest to read as its clock passes: a session's point once its close is published. */
export class HistoricalRealizedVolatility implements TimeSubscriber {
  readonly timeSubscriberId: string;
  readonly symbol: string;
  readonly fromDate: string;
  readonly toDate: string;
  private readonly points: ReadonlyArray<RealizedVolatilityPoint>;
  private readonly start: number;
  private readonly end: number;

  private currentTimestamp: number | undefined;
  /** How many points could be known at the current instant: a prefix, which only ever grows. */
  private visibleCount: number;

  constructor(props: HistoricalRealizedVolatilityProps) {
    this.timeSubscriberId = 'historical-realized-volatility' + nanoid();
    this.symbol = props.symbol;
    this.fromDate = props.fromDate;
    this.toDate = props.toDate;
    this.points = Object.freeze(Array.from(props.points));
    this.start = easternClock.timestamp(props.fromDate);
    this.end = easternClock.timestamp(props.toDate, '23:59:59');
    this.currentTimestamp = undefined;
    this.visibleCount = 0;
  }

  /** Refuses a backtest starting outside the measured range, which would otherwise read as no volatility. */
  async init(timestamp: number): Promise<void> {
    if (timestamp < this.start || timestamp >= this.end) {
      throw new Error(
        `The backtest starts at ${easternClock.datetime(timestamp)}, outside the ${this.fromDate} to ${this.toDate} ${this.symbol}'s realized volatility is measured over, so it would have no points to read. Set fromDate and toDate to cover the whole run.`,
      );
    }
    this.currentTimestamp = timestamp;
    this.visibleCount = 0;
    this.reveal(timestamp);
  }

  /** Refuses an instant not past the one it is on, and one past the measured range, where no new point would ever appear. */
  async forward(timestamp: number): Promise<void> {
    if (this.currentTimestamp === undefined) {
      throw new Error(
        `${this.symbol}'s realized volatility was stepped to ${easternClock.datetime(timestamp)} before it was initialised. Subscribe it to the backtest's clock before calling init().`,
      );
    }
    if (timestamp <= this.currentTimestamp) {
      throw new Error(
        `The clock moved to ${timestamp}, which is not past the ${this.currentTimestamp} ${this.symbol}'s realized volatility is already on. A subscriber is only ever stepped forward.`,
      );
    }
    if (timestamp > this.end) {
      throw new Error(
        `The backtest reached ${easternClock.datetime(timestamp)}, past the ${this.fromDate} to ${this.toDate} ${this.symbol}'s realized volatility is measured over, so no new point would appear. Set toDate to cover the whole run.`,
      );
    }
    this.currentTimestamp = timestamp;
    this.reveal(timestamp);
  }

  /** The points whose session's close was published by the clock. A copy each call. */
  getPoints(): ReadonlyArray<RealizedVolatilityPoint> {
    if (this.currentTimestamp === undefined) {
      throw new Error(`${this.symbol}'s realized volatility was read before it was initialised. Subscribe it to the backtest's clock before calling init().`);
    }
    return this.points.slice(0, this.visibleCount);
  }

  private reveal(timestamp: number): void {
    while (this.visibleCount < this.points.length && this.points[this.visibleCount].publishedAt < timestamp) {
      this.visibleCount += 1;
    }
  }
}
