import { impliedVolatility, marketHour, type Bar, type OccSymbol } from '@fleece/marketdata';
import { easternClock, LoggerFactory, mapWithConcurrency } from '@fleece/utilities';
import { nanoid } from 'nanoid';

import type { BacktestMarketData } from '../backtest/marketdata';
import { BacktestTime, type TimeSubscriber } from '../backtest/time';
import { latestCompletedSession, refreshStaleAvailabilities } from './implied-volatility-history';
import { daysToExpiration, type DaysToExpirationWindow } from './option-selection';
import type { OptionsAvailabilitiesHelper } from './options-availabilities';

const logger = LoggerFactory.getLogger('ConstantMaturityVolatilitySampler');

const EXPIRY_TIME = '16:00:00';
const RISK_FREE_RATE = 0.043;
const MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MINUTE;
const MS_PER_YEAR = 365 * MS_PER_DAY;

/** Alpaca's rate limit is what the other sweeps stay under at 10, and the client does not retry a 429. */
const FETCH_CONCURRENCY = 10;

const GRID_TIME = /^\d{2}:(00|30):00$/;

/** The length of a chunk, which is also how often one is taken. */
const CHUNK_LENGTH = 30 * MINUTE;

/**
 * How long after its minute ends Alpaca publishes a minute bar, the same figure the backtest's
 * market data holds a bar back by. A chunk is no more visible than its last bar.
 */
const BAR_PUBLISH_DELAY = 4_000;

/** How often the precomputing clock steps, which is what lets it land 90 seconds after each chunk ends. */
const PRECOMPUTE_STEP = 30_000;

/** Within 10% of the stock on the far side of the money: above it for a call, below it for a put. */
function outOfTheMoney(occSymbol: OccSymbol, spotPrice: number): boolean {
  return occSymbol.type === 'call' ? occSymbol.strike > spotPrice && occSymbol.strike < spotPrice * 1.1 : occSymbol.strike < spotPrice && occSymbol.strike > spotPrice * 0.9;
}

/**
 * When a contract stops trading: its expiration date's close, which is 13:00 on a half day,
 * and 16:00 for a date outside the market-hours table.
 */
function expirationClose(expiration: string): number {
  return marketHour(expiration)?.closeAt ?? easternClock.timestamp(expiration, EXPIRY_TIME);
}

/** One contract's earliest out-of-the-money trade in a chunk, against the stock's bar at the same minute. */
export interface OptionTradeVolatility {
  readonly time: number;
  readonly spotPrice: number;
  readonly optionPrice: number;
  readonly iv: number;
  readonly occSymbol: OccSymbol;
}

/** One expiration's volatility at the money, from the out-of-the-money put and call nearest it. */
export interface ExpirationVolatility {
  readonly expiration: string;
  /** Years from the end of the chunk to the expiration's close. */
  readonly tYears: number;
  readonly iv: number;
  readonly put: OptionTradeVolatility;
  readonly call: OptionTradeVolatility;
}

/** The volatility at the target maturity, and the expirations it was read from. */
export interface ConstantMaturityVolatility {
  readonly iv: number;
  /** The expiration nearest the target at or before it, absent when none had a put and a call. */
  readonly near?: ExpirationVolatility;
  /** The expiration nearest the target at or after it, absent when none had a put and a call. */
  readonly next?: ExpirationVolatility;
}

export interface ConstantMaturityVolatilitySamplerProps {
  readonly symbol: string;
  readonly dividendYield: number;
  readonly data: BacktestMarketData;
  readonly availabilities: OptionsAvailabilitiesHelper;
  /**
   * Which expirations are measured, in calendar days, and the maturity the volatility is
   * interpolated to. `{ target: 30, min: 23, max: 37 }` is close to VIX's.
   */
  readonly daysToExpiration: DaysToExpirationWindow;
}

export interface ConstantMaturityVolatilityPoint {
  readonly date: string;
  readonly time: string;
  readonly timestamp: number;
  /** At the target maturity. Absent when no expiration in the window had both a put and a call that traded. */
  readonly iv?: number;
  readonly near?: ExpirationVolatility;
  readonly next?: ExpirationVolatility;
}
/**
 * The volatility at the money for one expiration's trades: interpolated in log-moneyness
 * between the out-of-the-money put and call nearest the stock, each against the stock at the
 * minute it traded. Taking the nearest of each side rather than averaging every strike is what
 * keeps skew and which strikes happened to trade out of the figure.
 *
 * `undefined` without at least one put and one call.
 */
export function atTheMoneyVolatility(trades: ReadonlyArray<OptionTradeVolatility>): Pick<ExpirationVolatility, 'iv' | 'put' | 'call'> | undefined {
  let put: { readonly trade: OptionTradeVolatility; readonly moneyness: number } | undefined;
  let call: { readonly trade: OptionTradeVolatility; readonly moneyness: number } | undefined;
  for (const trade of trades) {
    const moneyness = Math.log(trade.occSymbol.strike / trade.spotPrice);
    if (trade.occSymbol.type === 'put' && moneyness < 0 && (put === undefined || moneyness > put.moneyness)) {
      put = { trade, moneyness };
    } else if (trade.occSymbol.type === 'call' && moneyness > 0 && (call === undefined || moneyness < call.moneyness)) {
      call = { trade, moneyness };
    }
  }
  if (put === undefined || call === undefined) {
    return undefined;
  }
  const iv = put.trade.iv + ((call.trade.iv - put.trade.iv) * -put.moneyness) / (call.moneyness - put.moneyness);
  return { iv, put: put.trade, call: call.trade };
}

/**
 * The volatility at `targetYears`, as VIX reads its 30 days: the total variance σ²T of the
 * expiration nearest the target at or before it and of the one nearest at or after it,
 * interpolated linearly in time. With only one side, that expiration's volatility stands on
 * its own rather than being extrapolated.
 *
 * `undefined` for no expirations.
 */
export function constantMaturityVolatility(expirations: ReadonlyArray<ExpirationVolatility>, targetYears: number): ConstantMaturityVolatility | undefined {
  let near: ExpirationVolatility | undefined;
  let next: ExpirationVolatility | undefined;
  for (const expiration of expirations) {
    if (expiration.tYears <= targetYears && (near === undefined || expiration.tYears > near.tYears)) {
      near = expiration;
    }
    if (expiration.tYears >= targetYears && (next === undefined || expiration.tYears < next.tYears)) {
      next = expiration;
    }
  }

  if (near === undefined || next === undefined || near.tYears === next.tYears) {
    const only = near ?? next;
    return only === undefined ? undefined : { iv: only.iv, near, next };
  }
  const nearWeight = (next.tYears - targetYears) / (next.tYears - near.tYears);
  const variance = (nearWeight * near.iv ** 2 * near.tYears + (1 - nearWeight) * next.iv ** 2 * next.tYears) / targetYears;
  return { iv: Math.sqrt(variance), near, next };
}

/**
 * Every half hour of a session, the stock's implied volatility at a constant maturity, from
 * each contract's earliest out-of-the-money trade in the chunk: at the money per expiration
 * from the nearest put and call, then interpolated to the target maturity across expirations.
 */
export class ConstantMaturityVolatilitySampler implements TimeSubscriber {
  private readonly symbol: string;
  private readonly dividendYield: number;
  private readonly availabilities: OptionsAvailabilitiesHelper;
  private readonly window: DaysToExpirationWindow;
  private readonly data: BacktestMarketData;
  private readonly points: ConstantMaturityVolatilityPoint[];

  readonly timeSubscriberId: string;

  constructor(props: ConstantMaturityVolatilitySamplerProps) {
    const symbol = props.symbol.trim().toUpperCase();
    const { min, target, max } = props.daysToExpiration;
    // Out of order, the target falls outside what is measured and every chunk reads from one
    // side only, which looks like a measurement rather than a mistake.
    if (!(min >= 0 && min <= target && target <= max)) {
      throw new Error(`Days to expiration must run 0 ≤ min ≤ target ≤ max, got min ${min}, target ${target}, max ${max}.`);
    }
    this.symbol = symbol;
    this.dividendYield = props.dividendYield;
    this.availabilities = props.availabilities;
    this.window = props.daysToExpiration;
    this.data = props.data;
    this.points = [];
    this.timeSubscriberId = 'volatility-sampler' + nanoid();
  }

  /**
   * Refreshes the option availability when it was not refreshed after the latest completed
   * trading day, since that is where the contracts come from. Otherwise it is left alone, rather
   * than costing a full listing every run.
   */
  async init(): Promise<void> {
    const today = easternClock.date(Date.now());
    const through = latestCompletedSession(today);
    if (through === undefined) {
      throw new Error(`The market-hours table has no session in the fortnight before ${today}. Refresh the table before sampling.`);
    }
    await refreshStaleAvailabilities(this.availabilities, this.symbol, through.date);
  }

  async forward(timestamp: number): Promise<void> {
    // The end of the chunk. The clock steps every 30 s, so the chunk ending 10:00 is taken at
    // 10:01:30, once its 09:59 bar has been published.
    const referenceTime = timestamp - 90_000; // 90 seconds
    const time = easternClock.time(referenceTime);
    if (!GRID_TIME.test(time)) {
      return undefined;
    }

    // By the session's hours rather than the market state at the chunk's end, which reads the
    // close itself as closed and so skipped the last half hour of every session.
    const segmentStartTime = referenceTime - CHUNK_LENGTH;
    const session = marketHour(segmentStartTime);
    if (session === undefined || segmentStartTime < session.openAt || referenceTime > session.closeAt) {
      return undefined;
    }

    const date = easternClock.date(referenceTime);
    // Fetched without `to`, which is compared with a bar's end plus its publishing delay and so
    // dropped the chunk's last minute. The clock already holds back what is not published yet,
    // and the chunk is its bars from its start up to, not including, its end.
    const { bars: sessionBars } = await this.data.minuteBars({ symbol: this.symbol, from: segmentStartTime });
    const minuteBars = sessionBars.filter((bar) => bar.t >= segmentStartTime && bar.t < referenceTime);
    if (minuteBars.length === 0) {
      return undefined;
    }

    const timestampToStockBar: Map<number, Bar> = new Map();
    minuteBars.forEach((bar) => timestampToStockBar.set(bar.t, bar));

    // Wide enough for the stock's price at every minute of the chunk: whether a contract is out
    // of the money is decided against the minute it traded, not the chunk's first.
    const lowestSpotPrice = Math.min(...minuteBars.map((bar) => bar.c));
    const highestSpotPrice = Math.max(...minuteBars.map((bar) => bar.c));
    // Listed as of the chunk's last minute, so a contract that first trades part way through is in.
    const occSymbols = await this.availabilities.availableOptions(this.symbol, referenceTime - MINUTE);
    const optionOccSymbols = occSymbols.filter((symbol) => {
      const days = daysToExpiration(date, symbol.expiration);
      return (
        days >= this.window.min && days <= this.window.max && symbol.root === symbol.underlying && symbol.strike > lowestSpotPrice * 0.9 && symbol.strike < highestSpotPrice * 1.1
      );
    });

    const referenceOptions: OptionTradeVolatility[] = [];
    await mapWithConcurrency(optionOccSymbols, FETCH_CONCURRENCY, async (occSymbol) => {
      const { bars } = await this.data.optionMinuteBars({ symbol: occSymbol.symbol, from: segmentStartTime });
      // The earliest trade in the chunk that has a stock bar at its minute and is out of the
      // money against it. One that cannot be priced is passed over for the next rather than
      // stopping the run.
      for (const optionBar of bars) {
        const stockBar = timestampToStockBar.get(optionBar.t);
        if (stockBar === undefined || !outOfTheMoney(occSymbol, stockBar.c)) {
          continue;
        }
        const tYears = (expirationClose(occSymbol.expiration) - (optionBar.t + MINUTE)) / MS_PER_YEAR;
        if (tYears <= 0 || stockBar.c <= 0 || optionBar.c <= 0) {
          continue;
        }
        const iv = impliedVolatility(optionBar.c, {
          spot: stockBar.c,
          strike: occSymbol.strike,
          tYears,
          type: occSymbol.type,
          rate: RISK_FREE_RATE,
          dividendYield: this.dividendYield,
        });
        if (iv === undefined) {
          logger.warn(
            `${occSymbol.symbol} closed at ${optionBar.c} in the ${easternClock.date(optionBar.t)} ${easternClock.time(optionBar.t)} bar, which has no implied volatility against ${this.symbol} at ${stockBar.c} with ${(tYears * 365).toFixed(2)} days left: outside the no-arbitrage band, as a leg of a multi-leg trade often is. Trying its next trade in the chunk.`,
          );
          continue;
        }
        referenceOptions.push({ time: stockBar.t, spotPrice: stockBar.c, optionPrice: optionBar.c, occSymbol: occSymbol, iv: iv });
        return;
      }
    });

    const byExpiration = new Map<string, OptionTradeVolatility[]>();
    for (const reference of referenceOptions) {
      const trades = byExpiration.get(reference.occSymbol.expiration) ?? [];
      trades.push(reference);
      byExpiration.set(reference.occSymbol.expiration, trades);
    }
    // Maturities measured from the chunk's end, the instant the point stands for.
    const expirations = [...byExpiration].flatMap(([expiration, trades]): ExpirationVolatility[] => {
      const atTheMoney = atTheMoneyVolatility(trades);
      return atTheMoney === undefined ? [] : [{ expiration, tYears: (expirationClose(expiration) - referenceTime) / MS_PER_YEAR, ...atTheMoney }];
    });
    const measured = constantMaturityVolatility(expirations, (this.window.target * MS_PER_DAY) / MS_PER_YEAR);
    this.points.push({ timestamp: segmentStartTime, date, time: easternClock.time(segmentStartTime), iv: measured?.iv, near: measured?.near, next: measured?.next });

    return undefined;
  }

  /** Every point taken so far, in the order taken. A copy, so a caller cannot edit what was measured. */
  getIvs(): ReadonlyArray<ConstantMaturityVolatilityPoint> {
    return [...this.points];
  }
}

export interface HistoricalConstantMaturityVolatilityProps extends ConstantMaturityVolatilitySamplerProps {
  /** The first date sampled, Eastern `YYYY-MM-DD`. A backtest reading the history must start on or after it. */
  readonly fromDate: string;
  /** The last date sampled, Eastern `YYYY-MM-DD`, through its close. */
  readonly toDate: string;
}

/**
 * A constant-maturity volatility history for a backtest to read as its clock passes: sampled
 * over the whole range when the backtest initialises, then handed out only as far as each
 * chunk could have been known at the backtest's instant.
 */
export class HistoricalConstantMaturityVolatility implements TimeSubscriber {
  readonly timeSubscriberId: string;
  readonly symbol: string;
  readonly dividendYield: number;
  private readonly fromDate: string;
  private readonly toDate: string;
  private readonly data: BacktestMarketData;
  private readonly availabilities: OptionsAvailabilitiesHelper;
  private readonly daysToExpiration: DaysToExpirationWindow;

  private currentTimestamp: number | undefined;
  private precomputedIvs: ReadonlyArray<ConstantMaturityVolatilityPoint> | undefined;

  constructor(props: HistoricalConstantMaturityVolatilityProps) {
    this.timeSubscriberId = 'historical-volatility' + nanoid();
    this.fromDate = props.fromDate;
    this.toDate = props.toDate;
    this.symbol = props.symbol;
    this.dividendYield = props.dividendYield;
    this.data = props.data;
    this.availabilities = props.availabilities;
    this.daysToExpiration = props.daysToExpiration;
    this.precomputedIvs = undefined;
    this.currentTimestamp = undefined;
  }

  /**
   * Samples the whole range on a clock of its own. The market data may be the backtest's, so it
   * is reset afterwards and put back on the instant the backtest is initialising: left on the
   * range's last instant, the backtest's first step would be refused as a step backwards.
   */
  async init(timestamp: number): Promise<void> {
    const start = easternClock.timestamp(this.fromDate);
    const end = easternClock.timestamp(this.toDate, '23:59:59');
    if (timestamp < start || timestamp >= end) {
      throw new Error(
        `The backtest starts at ${easternClock.datetime(timestamp)}, outside the ${this.fromDate} to ${this.toDate} ${this.symbol}'s volatility history is sampled over, so it would have no points to read. Set fromDate and toDate to cover the whole run.`,
      );
    }

    const time = new BacktestTime(start, end, PRECOMPUTE_STEP);
    const sampler = new ConstantMaturityVolatilitySampler({
      symbol: this.symbol,
      dividendYield: this.dividendYield,
      data: this.data,
      availabilities: this.availabilities,
      daysToExpiration: this.daysToExpiration,
    });
    time.subscribe(this.data).subscribe(sampler);

    try {
      await time.init();
      while (await time.forward()) {
        // Each step is the sampler measuring; its points are read once the range is done.
      }
    } finally {
      this.data.resetTimestamp();
      await this.data.init(timestamp);
    }

    this.precomputedIvs = sampler.getIvs();
    this.currentTimestamp = undefined;
  }

  async forward(timestamp: number): Promise<void> {
    this.currentTimestamp = timestamp;
  }

  /**
   * The points whose chunk had ended, and its last bar been published, by the clock: the chunk
   * starting 09:30 from 10:00:04 on. Nothing before the clock's first step.
   */
  getIvs(): ReadonlyArray<ConstantMaturityVolatilityPoint> {
    const current = this.currentTimestamp;
    const points = this.precomputedIvs ?? [];
    if (current === undefined) {
      return [];
    }
    // Points are in the order sampled, so the visible ones are a prefix, found by bisection
    // rather than a scan since a strategy may ask on every step.
    let low = 0;
    let high = points.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (points[mid].timestamp + CHUNK_LENGTH + BAR_PUBLISH_DELAY < current) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return points.slice(0, low);
  }
}
