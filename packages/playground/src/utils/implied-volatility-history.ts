import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { impliedVolatility, marketHour, marketHourByIndex, requireOccSymbol, type AlpacaMarketDataClient, type Bar, type MarketHour, type OccSymbol } from '@fleece/marketdata';
import { easternClock, LoggerFactory, mapWithConcurrency } from '@fleece/utilities';
import { z } from 'zod';

import { expirationsByPreference, type DaysToExpirationWindow } from './option-selection';
import type { OptionsAvailabilitiesHelper } from './options-availabilities';

const logger = LoggerFactory.getLogger('ImpliedVolatilityHistory');

const CACHE_FOLDER = 'implied-volatility';

/** Where a first sweep starts: Alpaca's option history begins in February 2024. */
const HISTORY_FROM = '2024-02-01';

const MINUTE = 60_000;
const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

/** One sample every half hour, on the bars that start at :00 and :30. */
const SAMPLE_INTERVAL = 30 * MINUTE;

/** The volatility measured is a month's: the at-the-money pair at the expiration nearest 30 days out. */
const SAMPLE_DAYS_TO_EXPIRATION: DaysToExpirationWindow = { target: 30, min: 20, max: 40 };

/** Strikes considered either side of the spot, as a fraction of it. */
const STRIKE_WINDOW = 0.1;

/** Pairs tried per expiration, nearest the spot first, before moving to the next expiration. */
const STRIKES_TRIED = 3;

/**
 * How long before a sample's bar a price may have printed. A volatility is solved from the
 * option's last trade against the stock's, so a leg that last traded twenty minutes before
 * is priced against a spot it never saw.
 */
const MAX_PRINT_AGE = 15 * MINUTE;

/** Equity options stop trading at the close on their expiration date. */
const EXPIRY_TIME = '16:00:00';

/** Written after every this many sessions, so a sweep that fails part way keeps what it measured. */
const SESSIONS_PER_WRITE = 50;

/** Same as the availability sweep, which is the figure known to stay under Alpaca's rate limit. */
const SWEEP_CONCURRENCY = 10;

const GRID_TIME = /^\d{2}:(00|30)$/;

/** `<cache>/implied-volatility/<TICKER>.json` */
export interface ImpliedVolatilityHistory {
  readonly underlying: string;
  /** When the last `save` started. */
  readonly refreshedAt: number;
  /** Ascending by date, each a session that had closed when it was swept. */
  readonly sessions: ReadonlyArray<SessionSamples>;
}

export interface SessionSamples {
  /** Eastern `YYYY-MM-DD`. */
  readonly date: string;
  /** Ascending by `time`: 09:30 to 15:30 on a full day, 09:30 to 12:30 on a 13:00 close. */
  readonly samples: ReadonlyArray<VolatilitySample>;
}

export type VolatilitySample = MeasuredSample | UnmeasuredSample;

/**
 * The at-the-money pair: the first put and call at one strike that both have a price, taken
 * expiration nearest 30 days first, then strike nearest the spot. Strike and expiration come
 * from the symbols. Each `...At` is the start of the minute bar whose close is the price.
 */
export interface MeasuredSample {
  readonly status: 'measured';
  /** Eastern `HH:mm` of the grid bar. The sample uses bars up to and including it. */
  readonly time: string;
  readonly spot: number;
  readonly spotAt: number;
  readonly putSymbol: string;
  readonly putPrice: number;
  readonly putAt: number;
  readonly callSymbol: string;
  readonly callPrice: number;
  readonly callAt: number;
}

/** Kept rather than dropped, so a rerun does not retry a settled session and a gap says why it is one. */
export interface UnmeasuredSample {
  readonly status: 'unmeasured';
  readonly time: string;
  readonly reason: UnmeasuredReason;
}

export type UnmeasuredReason =
  /** The stock had no price within the age limit. */
  | 'no-spot'
  /** Nothing listed and printed yet in the expiration and strike window. */
  | 'no-contracts'
  /** Pairs were listed, but none had both legs priced within the age limit. */
  | 'no-priced-pair';

/** What a strategy reads: a measured sample with its volatilities solved. Never written to the file. */
export interface ImpliedVolatilityPoint {
  readonly date: string;
  readonly spotAt: number;
  readonly spot: number;
  readonly putIv: number;
  readonly putSymbol: string;
  readonly callIv: number;
  readonly callSymbol: string;
}

/** A minute bar's close, and the start of that minute. */
export interface Print {
  readonly price: number;
  readonly at: number;
}

export interface StraddlePair {
  readonly put: OccSymbol;
  readonly call: OccSymbol;
}

export interface SampleInput {
  readonly date: string;
  readonly time: string;
  /** The session's open: an option print before it is a stray, not a price. */
  readonly openAt: number;
  readonly spot?: Print;
  /** In the order they are tried. */
  readonly pairs: ReadonlyArray<StraddlePair>;
  /** Keyed by contract symbol; a contract that did not print is absent. */
  readonly optionBars: ReadonlyMap<string, ReadonlyArray<Bar>>;
}

export interface ImpliedVolatilityHistoryHelper {
  readonly cachePath: string;
  save(underlying: string): Promise<void>;
  /** Every session swept, sweeping first if nothing has been. */
  sessions(underlying: string): Promise<ReadonlyArray<SessionSamples>>;
}

/** Typed against the interface, so the two cannot drift apart. */
const HISTORY_SCHEMA: z.ZodType<ImpliedVolatilityHistory> = z.object({
  underlying: z.string().min(1),
  refreshedAt: z.number(),
  sessions: z.array(
    z.object({
      date: z.string(),
      samples: z.array(
        z.discriminatedUnion('status', [
          z.object({
            status: z.literal('measured'),
            time: z.string().regex(GRID_TIME),
            spot: z.number(),
            spotAt: z.number(),
            putSymbol: z.string().min(1),
            putPrice: z.number(),
            putAt: z.number(),
            callSymbol: z.string().min(1),
            callPrice: z.number(),
            callAt: z.number(),
          }),
          z.object({
            status: z.literal('unmeasured'),
            time: z.string().regex(GRID_TIME),
            reason: z.enum(['no-spot', 'no-contracts', 'no-priced-pair']),
          }),
        ]),
      ),
    }),
  ),
});

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** Whether `time` is an `HH:mm` on the half-hour grid samples are taken on. */
export function isSampleTime(time: string): boolean {
  return GRID_TIME.test(time);
}

/** The start of the grid bar `time` names on `date`. */
export function sampleMinute(date: string, time: string): number {
  return easternClock.timestamp(date, `${time}:00`);
}

/** The grid bars of a session: every half hour from the open, while a bar that starts then still ends by the close. */
export function sampleTimes(session: Pick<MarketHour, 'openAt' | 'closeAt'>): ReadonlyArray<string> {
  const times: string[] = [];
  for (let minute = session.openAt; minute + MINUTE <= session.closeAt; minute += SAMPLE_INTERVAL) {
    times.push(easternClock.time(minute).slice(0, 5));
  }
  return times;
}

/**
 * The latest bar that starts no later than `minute`, no earlier than `openAt`, and no more
 * than the age limit before `minute`.
 */
export function lastPrint(bars: ReadonlyArray<Bar>, minute: number, openAt: number): Print | undefined {
  let latest: Bar | undefined;
  for (const bar of bars) {
    if (bar.t <= minute && bar.t >= openAt && (latest === undefined || bar.t > latest.t)) {
      latest = bar;
    }
  }
  return latest === undefined || minute - latest.t > MAX_PRINT_AGE ? undefined : { price: latest.c, at: latest.t };
}

/**
 * The pairs to try, in order: expirations nearest 30 days first, and within each the strikes
 * nearest the spot that have both a put and a call, at most three of them. Of two strikes
 * equally near, the lower comes first, so the order does not depend on the listing's.
 */
export function straddlePairs(contracts: ReadonlyArray<OccSymbol>, date: string, spot: number): ReadonlyArray<StraddlePair> {
  const inWindow = contracts.filter((contract) => Math.abs(contract.strike - spot) <= spot * STRIKE_WINDOW);
  const pairs: StraddlePair[] = [];
  for (const expiration of expirationsByPreference(
    inWindow.map((contract) => contract.expiration),
    date,
    SAMPLE_DAYS_TO_EXPIRATION,
  )) {
    const byStrike = new Map<number, { put?: OccSymbol; call?: OccSymbol }>();
    for (const contract of inWindow) {
      if (contract.expiration === expiration) {
        const sides = byStrike.get(contract.strikeMils) ?? {};
        byStrike.set(contract.strikeMils, contract.type === 'put' ? { ...sides, put: contract } : { ...sides, call: contract });
      }
    }
    const nearest = [...byStrike.values()]
      .flatMap(({ put, call }) => (put === undefined || call === undefined ? [] : [{ put, call }]))
      .sort((left, right) => Math.abs(left.put.strike - spot) - Math.abs(right.put.strike - spot) || left.put.strikeMils - right.put.strikeMils);
    pairs.push(...nearest.slice(0, STRIKES_TRIED));
  }
  return pairs;
}

/** The sample at one grid bar: the first pair whose legs both have a price, or why there is none. */
export function measureSample(input: SampleInput): VolatilitySample {
  const { date, time, openAt, spot, pairs, optionBars } = input;
  if (spot === undefined) {
    return { status: 'unmeasured', time, reason: 'no-spot' };
  }
  if (pairs.length === 0) {
    return { status: 'unmeasured', time, reason: 'no-contracts' };
  }

  const minute = sampleMinute(date, time);
  for (const { put, call } of pairs) {
    const putPrint = lastPrint(optionBars.get(put.symbol) ?? [], minute, openAt);
    const callPrint = lastPrint(optionBars.get(call.symbol) ?? [], minute, openAt);
    if (putPrint !== undefined && callPrint !== undefined) {
      return {
        status: 'measured',
        time,
        spot: spot.price,
        spotAt: spot.at,
        putSymbol: put.symbol,
        putPrice: putPrint.price,
        putAt: putPrint.at,
        callSymbol: call.symbol,
        callPrice: callPrint.price,
        callAt: callPrint.at,
      };
    }
  }
  return { status: 'unmeasured', time, reason: 'no-priced-pair' };
}

/**
 * Both legs' volatilities, solved as of the end of the sample's bar, when its close printed.
 * `undefined` when either has none — a price outside the no-arbitrage band — rather than a
 * point carrying one side only.
 */
export function solvePoint(date: string, sample: MeasuredSample, riskFreeRate: number, dividendYield: number): ImpliedVolatilityPoint | undefined {
  const put = requireOccSymbol(sample.putSymbol, 'read a cached volatility sample');
  const call = requireOccSymbol(sample.callSymbol, 'read a cached volatility sample');
  const tYears = (easternClock.timestamp(put.expiration, EXPIRY_TIME) - (sampleMinute(date, sample.time) + MINUTE)) / MS_PER_YEAR;
  if (tYears <= 0 || sample.spot <= 0 || sample.putPrice <= 0 || sample.callPrice <= 0) {
    return undefined;
  }

  const input = { spot: sample.spot, strike: put.strike, tYears, rate: riskFreeRate, dividendYield };
  const putIv = impliedVolatility(sample.putPrice, { ...input, type: 'put' });
  const callIv = impliedVolatility(sample.callPrice, { ...input, strike: call.strike, type: 'call' });
  if (putIv === undefined || callIv === undefined) {
    return undefined;
  }
  return { date, spotAt: sample.spotAt, spot: sample.spot, putIv, putSymbol: sample.putSymbol, callIv, callSymbol: sample.callSymbol };
}

/**
 * An underlying's at-the-money option prices every half hour of every session, swept once
 * and kept, so a backtest can rank today's volatility without measuring a year of it first.
 *
 *     const helper = new ImpliedVolatilityHistoryHelperImpl(cachePath, marketDataClient(), availabilities);
 *     await helper.save('AAPL');     // sweeps what is new since the last save, writes implied-volatility/AAPL.json
 *     await helper.sessions('AAPL'); // every session swept
 *
 * Prices are stored rather than volatilities, so the rate and dividend yield are the reader's
 * to choose. What a backtest may see of it at an instant is the reader's to decide too.
 */
export class ImpliedVolatilityHistoryHelperImpl implements ImpliedVolatilityHistoryHelper {
  /** The promise rather than its value, so callers arriving during a first sweep join it. */
  private readonly loaded = new Map<string, Promise<ReadonlyArray<SessionSamples>>>();

  constructor(
    /** The cache root. The files go in its `implied-volatility` folder. */
    readonly cachePath: string,
    private readonly client: AlpacaMarketDataClient,
    private readonly availabilities: OptionsAvailabilitiesHelper,
    /** Injectable so which sessions have closed is a fixed question in a test rather than today's. */
    private readonly now: () => number = Date.now,
    private readonly concurrency: number = SWEEP_CONCURRENCY,
  ) {}

  /**
   * Sweeps the sessions after the last one in the file, never one already there.
   *
   * Only sessions that closed before the availability cache was last refreshed: that cache is
   * where the contracts come from, and a session swept against a listing older than it would
   * be missing the strikes added since — and stay that way, since a swept session is never
   * swept again. Run the availability sweep first to reach further.
   *
   * Written every 50 sessions, so a failure loses at most the sessions since the last write,
   * and the next `save` carries on from there.
   */
  async save(underlying: string): Promise<void> {
    const ticker = underlying.trim().toUpperCase();
    const refreshedAt = this.now();
    const sessions = [...(this.readCache(ticker)?.sessions ?? [])];

    let listedAt = await this.availabilities.refreshedAt(ticker);
    if (listedAt === undefined) {
      await this.availabilities.save(ticker);
      listedAt = await this.availabilities.refreshedAt(ticker);
    }
    if (listedAt === undefined) {
      throw new Error(`Swept ${ticker}'s option availability but it still reads as never swept, so there are no contracts to measure against.`);
    }

    const pending = sessionsAfter(sessions[sessions.length - 1]?.date, Math.min(refreshedAt, listedAt));
    if (pending.length === 0) {
      logger.info(
        `${ticker}: nothing to sweep. The last session held is ${sessions[sessions.length - 1]?.date ?? 'none'}, and the availability cache was refreshed ${easternClock.datetime(listedAt)}.`,
      );
      return;
    }
    const lastPending = pending[pending.length - 1];
    const next = marketHourByIndex(lastPending.index + 1);
    if (next !== undefined && next.closeAt <= refreshedAt && next.closeAt > listedAt) {
      logger.warn(
        `${ticker}: stopping at ${lastPending.date}, the last session to close before the availability cache was refreshed at ${easternClock.datetime(listedAt)}. Refresh it to sweep further.`,
      );
    }
    logger.info(`${ticker}: sweeping ${pending.length} sessions, ${pending[0].date} to ${lastPending.date}.`);

    try {
      for (let first = 0; first < pending.length; first += SESSIONS_PER_WRITE) {
        const chunk = pending.slice(first, first + SESSIONS_PER_WRITE);
        const swept: SessionSamples[] = new Array<SessionSamples>(chunk.length);
        await mapWithConcurrency(
          chunk.map((session, index) => ({ session, index })),
          this.concurrency,
          async ({ session, index }) => {
            swept[index] = await this.sweepSession(ticker, session);
          },
        );
        sessions.push(...swept);
        this.writeCache({ underlying: ticker, refreshedAt, sessions });
        logger.info(`${ticker}: swept through ${chunk[chunk.length - 1].date}, ${first + chunk.length} of ${pending.length} sessions.`);
      }
    } finally {
      this.loaded.delete(ticker);
    }
  }

  sessions(underlying: string): Promise<ReadonlyArray<SessionSamples>> {
    const ticker = underlying.trim().toUpperCase();
    const already = this.loaded.get(ticker);
    if (already !== undefined) {
      return already;
    }
    // Evicted if it fails, so one bad sweep does not answer every later read.
    const loading = this.load(ticker).catch((error: unknown) => {
      this.loaded.delete(ticker);
      throw error;
    });
    this.loaded.set(ticker, loading);
    return loading;
  }

  private async load(ticker: string): Promise<ReadonlyArray<SessionSamples>> {
    let cached = this.readCache(ticker);
    if (cached === undefined) {
      logger.info(`No implied volatility history for ${ticker} yet. Sweeping it now, which is slow and happens once.`);
      await this.save(ticker);
      cached = this.readCache(ticker);
    }
    if (cached === undefined) {
      throw new Error(
        `Swept ${ticker}'s implied volatility but ${this.file(ticker)} is still not there. Check that its option availability covers a session since ${HISTORY_FROM}.`,
      );
    }
    return cached.sessions;
  }

  /**
   * One session: the stock's bars, then the pairs each grid bar would try, then every one of
   * those contracts' bars in a single request. Two requests a session, whatever the grid.
   */
  private async sweepSession(ticker: string, session: MarketHour): Promise<SessionSamples> {
    const { bars: stockBars } = await this.client.minuteBars({ symbol: ticker, from: session.date, to: session.date, adjustForSplit: false });

    const planned: Array<Omit<SampleInput, 'optionBars'>> = [];
    for (const time of sampleTimes(session)) {
      const minute = sampleMinute(session.date, time);
      const spot = lastPrint(stockBars, minute, session.openAt);
      const pairs = spot === undefined ? [] : straddlePairs(await this.availabilities.availableOptions(ticker, minute), session.date, spot.price);
      planned.push({ date: session.date, time, openAt: session.openAt, spot, pairs });
    }

    const symbols = [...new Set(planned.flatMap(({ pairs }) => pairs.flatMap(({ put, call }) => [put.symbol, call.symbol])))];
    const optionBars =
      symbols.length === 0
        ? new Map<string, ReadonlyArray<Bar>>()
        : (await this.client.optionBarsBySymbol({ symbols, from: session.date, to: session.date, multiplier: 1, timespan: 'minute' })).bars;

    return { date: session.date, samples: planned.map((input) => measureSample({ ...input, optionBars })) };
  }

  private folder(): string {
    return resolve(this.cachePath, CACHE_FOLDER);
  }

  private file(ticker: string): string {
    return resolve(this.folder(), `${ticker}.json`);
  }

  /** `undefined` only for a sweep that has not happened yet. A file that exists and cannot be trusted throws. */
  private readCache(ticker: string): ImpliedVolatilityHistory | undefined {
    const file = this.file(ticker);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        return undefined;
      }
      throw new Error(`Could not read ${file}: ${String(error)}`);
    }

    try {
      return HISTORY_SCHEMA.parse(JSON.parse(text));
    } catch (error: unknown) {
      throw new Error(`${file} is not a readable implied volatility history: ${String(error)}. Delete it to sweep ${ticker} again from scratch.`);
    }
  }

  /** Written beside the target and renamed over it, because a half-written file parses as a valid, shorter history. */
  private writeCache(history: ImpliedVolatilityHistory): void {
    mkdirSync(this.folder(), { recursive: true });
    const target = this.file(history.underlying);
    const pending = `${target}.pending`;
    writeFileSync(pending, JSON.stringify(history));
    renameSync(pending, target);
  }
}

/**
 * The sessions after `lastDate`, or from the start of the history when there is none, that
 * closed by `closedBy`. Ends at the market-hours table's last session if that comes first.
 */
function sessionsAfter(lastDate: string | undefined, closedBy: number): ReadonlyArray<MarketHour> {
  let session = lastDate === undefined ? firstSessionFrom(HISTORY_FROM) : nextSession(lastDate);
  const sessions: MarketHour[] = [];
  while (session !== undefined && session.closeAt <= closedBy) {
    sessions.push(session);
    session = marketHourByIndex(session.index + 1);
  }
  return sessions;
}

function nextSession(date: string): MarketHour | undefined {
  const session = marketHour(date);
  if (session === undefined) {
    throw new Error(`The implied volatility history ends on ${date}, which is not a session in the market-hours table. Delete the file to sweep again from scratch.`);
  }
  return marketHourByIndex(session.index + 1);
}

/** The first session on or after `date`, looking a fortnight ahead at most. */
function firstSessionFrom(date: string): MarketHour | undefined {
  for (let offset = 0; offset < 14; offset += 1) {
    const session = marketHour(easternClock.shiftDate(date, offset));
    if (session !== undefined) {
      return session;
    }
  }
  return undefined;
}
