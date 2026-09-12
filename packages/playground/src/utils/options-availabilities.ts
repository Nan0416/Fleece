import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { marketHour, parseOccSymbol, type AlpacaMarketDataClient, type Bar, type OccSymbol, type OptionContractStatus } from '@fleece/marketdata';
import { assertArray, assertNonEmptyString, assertNumber, assertOptionalInteger, assertRecord, easternClock, LoggerFactory } from '@fleece/utilities';

const logger = LoggerFactory.getLogger('OptionsAvailabilities');

/**
 * Deliberately earlier than any option history rather than pinned to where it currently
 * begins — Alpaca's starts in February 2024, and a range reaching further back returns the
 * same bars at the same cost, since a window with no data pages no emptier than one page.
 * Pinning it would mean editing this the day the history is extended, and the symptom
 * would be a sweep that quietly dates every older contract from the pin.
 * https://docs.alpaca.markets/us/docs/historical-option-data
 */
const BEFORE_ANY_OPTION_HISTORY = '1990-01-01';

/**
 * Contracts per batched request. `optionBarsBySymbol` already chunks at 100 internally;
 * this outer batch exists to bound *memory* — an underlying's whole daily history in one
 * response is millions of bars, and every one but the first of each is discarded.
 */
const SWEEP_BATCH = 200;

/**
 * Sweep requests in flight at once. Alpaca answers 429 over its cap and neither this
 * client nor the HTTP seam retries one, so raising this trades wall-clock for batches
 * that come back empty-handed and have to be asked again next run.
 */
const SWEEP_CONCURRENCY = 10;

export interface OptionContractAvailability {
  readonly symbol: string;
  /**
   * The minute the contract first printed in, and absent when it never printed at all.
   *
   * **Not an issuance date.** Exchanges add strikes to a live expiration as the underlying
   * moves and nobody publishes when, so the first print is the earliest moment a contract
   * is *known* to have existed. It is also the only moment that matters here: a contract
   * with no print has no price, and no price is nothing a backtest can trade at.
   */
  readonly firstTradingMinuteTimestamp?: number;
  /** The regular close on expiration day, which is when the contract stops trading. */
  readonly expirationTimestamp: number;
}

export interface OptionContractAvailabilities {
  readonly underlying: string;
  readonly availabilities: ReadonlyArray<OptionContractAvailability>;
  readonly refreshedAt: number;
}

export interface OptionsAvailabilitiesHelper {
  readonly cachePath: string;
  save(underlying: string): Promise<void>;
  availableOptions(underlying: string, timestamp: number): Promise<ReadonlyArray<OccSymbol>>;
}

/** One contract that has a price, pre-parsed so a per-minute lookup does no work twice. */
interface TradableContract {
  readonly occSymbol: OccSymbol;
  readonly firstTradingMinuteTimestamp: number;
  readonly expirationTimestamp: number;
}

/**
 * Runs `work` over `items`, at most `concurrency` at a time.
 *
 * A pool rather than `Promise.all` over fixed groups: a chain sweep's requests differ by
 * an order of magnitude in size, so a group spends most of its time waiting on its
 * slowest member while the other nine slots sit idle.
 */
async function mapWithConcurrency<T>(items: ReadonlyArray<T>, concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await work(item);
    }
  });
  await Promise.all(workers);
}

/**
 * A sweep tolerates a request that fails, because an unresolved contract is simply asked
 * about again next run. Every request failing is a different thing — bad credentials, or
 * a rate limit that never let up — and writing a cache from it would record an underlying
 * whose contracts all look as though they never traded.
 */
function requireSomethingSucceeded(failed: number, total: number, pass: string): void {
  if (total > 0 && failed === total) {
    throw new Error(`All ${total} ${pass} sweep requests failed, so nothing was learned. Check the credentials and whether the rate limit was hit, then rerun.`);
  }
}

/** A cache that has never been written, as opposed to one that cannot be read. */
function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** Alpaca returns bars ascending, but the whole file rests on this one value. */
function earliest(bars: ReadonlyArray<Bar>): number | undefined {
  return bars.reduce<number | undefined>((first, bar) => (first === undefined || bar.t < first ? bar.t : first), undefined);
}

function toAvailability(value: unknown, field: string): OptionContractAvailability {
  const record = assertRecord(value, field);
  return {
    symbol: assertNonEmptyString(record.symbol, `${field}.symbol`),
    firstTradingMinuteTimestamp: assertOptionalInteger(record.firstTradingMinuteTimestamp, `${field}.firstTradingMinuteTimestamp`),
    expirationTimestamp: assertNumber(record.expirationTimestamp, `${field}.expirationTimestamp`),
  };
}

/**
 * Which option contracts of an underlying could actually have been traded at a given
 * instant, answered from a file swept once per underlying.
 *
 *     const helper = new OptionsAvailabilitiesHelperImpl(cachePath, marketDataClient());
 *     await helper.save('AMZN');                       // sweeps the chain, writes AMZN.json
 *     await helper.availableOptions('AMZN', atNoon);   // the contracts live at that minute
 *
 * `save` is the slow half and is meant to be run ahead of a backtest, not during one.
 * `availableOptions` reads the file once per underlying and then answers from memory.
 */
export class OptionsAvailabilitiesHelperImpl implements OptionsAvailabilitiesHelper {
  /**
   * Parsed once per underlying: a minute-fidelity run asks this thousands of times. The
   * promise rather than its value is kept, so callers that arrive while a first sweep is
   * still running join it instead of starting a second one.
   */
  private readonly loaded = new Map<string, Promise<ReadonlyArray<TradableContract>>>();

  constructor(
    readonly cachePath: string,
    private readonly client: AlpacaMarketDataClient,
    /** Injectable so "has this expired" is a fixed question in a test rather than today's. */
    private readonly now: () => number = Date.now,
    private readonly concurrency: number = SWEEP_CONCURRENCY,
  ) {}

  async save(underlying: string): Promise<void> {
    const ticker = underlying.trim().toUpperCase();
    const refreshedAt = this.now();

    const listed = await this.listContracts(ticker);
    logger.info(`${ticker}: ${listed.length} contracts listed, adjusted roots excluded.`);

    // An answer that can no longer change is kept rather than swept again: a contract that
    // has printed has its first print for good, and one that expired without printing
    // never will. A rerun then costs a listing rather than the whole chain.
    // Reading to decide what to skip, not to answer with, so an unreadable cache costs a
    // full sweep rather than the run — `save` is about to replace the file regardless.
    let previous: OptionContractAvailabilities | undefined;
    try {
      previous = this.readCache(ticker);
    } catch (error: unknown) {
      logger.warn(`Sweeping ${ticker} from scratch: ${String(error)}`);
    }
    const cached = new Map((previous?.availabilities ?? []).map((entry) => [entry.symbol, entry]));
    const settled: OptionContractAvailability[] = [];
    const pending: OccSymbol[] = [];
    for (const contract of listed) {
      const known = cached.get(contract.symbol);
      if (known !== undefined && (known.firstTradingMinuteTimestamp !== undefined || known.expirationTimestamp < refreshedAt)) {
        settled.push(known);
      } else {
        pending.push(contract);
      }
    }
    logger.info(`${ticker}: ${settled.length} already settled, ${pending.length} to sweep.`);

    const firstDates = await this.sweepFirstTradingDates(pending);
    const firstMinutes = await this.sweepFirstTradingMinutes(firstDates);

    const availabilities = [...settled];
    for (const contract of pending) {
      const session = marketHour(contract.expiration);
      if (session === undefined) {
        // Outside the market-hours table, so there is no close to expire at. One contract
        // must not abandon the rest of a sweep that cost hundreds of requests.
        logger.warn(`${contract.symbol} expires ${contract.expiration}, which the market-hours table does not cover. Left out.`);
        continue;
      }
      availabilities.push({
        symbol: contract.symbol,
        firstTradingMinuteTimestamp: firstMinutes.get(contract.symbol),
        expirationTimestamp: session.closeAt,
      });
    }

    availabilities.sort((first, second) => first.symbol.localeCompare(second.symbol));
    this.writeCache({ underlying: ticker, availabilities, refreshedAt });
    this.loaded.delete(ticker);

    const priced = availabilities.filter((entry) => entry.firstTradingMinuteTimestamp !== undefined).length;
    logger.info(`${ticker}: wrote ${availabilities.length} contracts, ${priced} of which ever printed, to ${this.file(ticker)}.`);
  }

  async availableOptions(underlying: string, timestamp: number): Promise<ReadonlyArray<OccSymbol>> {
    const tradable = await this.tradable(underlying.trim().toUpperCase());
    return tradable.filter((entry) => entry.firstTradingMinuteTimestamp <= timestamp && timestamp <= entry.expirationTimestamp).map((entry) => entry.occSymbol);
  }

  /**
   * Both statuses, because `status` is as of now rather than as of the backtest: every
   * contract that expired inside the window is `inactive` today, and Alpaca defaults to
   * `active`, so asking once returns an empty historical chain.
   *
   * Adjusted roots — `1AMZN...` — are left out. They do not deliver 100 shares, Alpaca's
   * bars endpoint does not serve them, and the account prices every OCC symbol at 100.
   */
  private async listContracts(ticker: string): Promise<ReadonlyArray<OccSymbol>> {
    const bySymbol = new Map<string, OccSymbol>();
    let adjusted = 0;

    for (const status of ['active', 'inactive'] satisfies ReadonlyArray<OptionContractStatus>) {
      let startAfter: string | undefined = undefined;
      do {
        const response = await this.client.listOptionContracts({ underlying: ticker, status, startAfter });
        for (const contract of response.contracts) {
          const occSymbol = parseOccSymbol(contract.S);
          if (occSymbol === undefined) {
            logger.warn(`${contract.S} is not an OCC contract symbol. Left out.`);
          } else if (occSymbol.root !== occSymbol.underlying) {
            adjusted += 1;
          } else {
            bySymbol.set(occSymbol.symbol, occSymbol);
          }
        }
        startAfter = response.resumeFrom;
      } while (startAfter !== undefined);
    }

    if (adjusted > 0) {
      logger.info(`Left out ${adjusted} adjusted contracts, which do not deliver 100 shares.`);
    }
    return [...bySymbol.values()];
  }

  /** The day each contract first printed on, from one daily sweep of the whole chain. */
  private async sweepFirstTradingDates(contracts: ReadonlyArray<OccSymbol>): Promise<ReadonlyMap<string, string>> {
    const today = easternClock.date(this.now());
    const firstDates = new Map<string, string>();

    const batches: Array<ReadonlyArray<OccSymbol>> = [];
    for (let first = 0; first < contracts.length; first += SWEEP_BATCH) {
      batches.push(contracts.slice(first, first + SWEEP_BATCH));
    }

    let failed = 0;
    let swept = 0;
    await mapWithConcurrency(batches, this.concurrency, async (batch) => {
      try {
        const { bars } = await this.client.optionBarsBySymbol({
          symbols: batch.map((contract) => contract.symbol),
          from: BEFORE_ANY_OPTION_HISTORY,
          to: today,
          multiplier: 1,
          timespan: 'day',
        });
        // Collapsed to a date here, so the bars go out of scope with the batch.
        for (const [symbol, entries] of bars) {
          const at = earliest(entries);
          if (at !== undefined) {
            firstDates.set(symbol, easternClock.date(at));
          }
        }
      } catch (error: unknown) {
        // Left unresolved rather than fatal. An unresolved contract is never settled, so
        // the next run asks about it again — where losing the whole sweep to one bad
        // batch throws away every other batch that did succeed.
        failed += 1;
        logger.warn(`A batch of ${batch.length} contracts failed its daily sweep and will be asked again next run: ${String(error)}`);
      }
      swept += 1;
      logger.info(`Swept ${swept} of ${batches.length} batches for a first trading day.`);
    });

    requireSomethingSucceeded(failed, batches.length, 'daily');
    return firstDates;
  }

  /**
   * The minute within that day, one request per distinct day rather than per contract —
   * every contract that first printed on the same session is one call.
   */
  private async sweepFirstTradingMinutes(firstDates: ReadonlyMap<string, string>): Promise<ReadonlyMap<string, number>> {
    const byDate = new Map<string, string[]>();
    for (const [symbol, date] of firstDates) {
      const sameDay = byDate.get(date) ?? [];
      sameDay.push(symbol);
      byDate.set(date, sameDay);
    }

    const firstMinutes = new Map<string, number>();
    const dates = [...byDate.keys()].sort();

    let failed = 0;
    let swept = 0;
    await mapWithConcurrency(dates, this.concurrency, async (date) => {
      const symbols = byDate.get(date) ?? [];
      try {
        // A date string widens to the whole Eastern day, so this is that session's minutes.
        const { bars } = await this.client.optionBarsBySymbol({ symbols, from: date, to: date, multiplier: 1, timespan: 'minute' });

        for (const symbol of symbols) {
          const at = earliest(bars.get(symbol) ?? []);
          if (at !== undefined) {
            firstMinutes.set(symbol, at);
            continue;
          }
          // A daily bar with no minute bars behind it — AMZN240119C00081000 is one. The
          // day is evidence it traded, so the session close is used rather than dropping
          // the contract: late is conservative, where early invents a tradable minute.
          const session = marketHour(date);
          if (session !== undefined) {
            logger.warn(`${symbol} printed on ${date} with no minute bars. Dated from that session's close.`);
            firstMinutes.set(symbol, session.closeAt);
          }
        }
      } catch (error: unknown) {
        failed += 1;
        logger.warn(`${date} failed its minute sweep, leaving ${symbols.length} contracts to be asked again next run: ${String(error)}`);
      }
      swept += 1;
      logger.info(`Swept ${swept} of ${dates.length} days for a first trading minute.`);
    });

    requireSomethingSucceeded(failed, dates.length, 'minute');
    return firstMinutes;
  }

  private tradable(ticker: string): Promise<ReadonlyArray<TradableContract>> {
    const already = this.loaded.get(ticker);
    if (already !== undefined) {
      return already;
    }
    // Evicted if it fails, so one bad sweep does not answer every later minute of the run.
    const loading = this.load(ticker).catch((error: unknown) => {
      this.loaded.delete(ticker);
      throw error;
    });
    this.loaded.set(ticker, loading);
    return loading;
  }

  private async load(ticker: string): Promise<ReadonlyArray<TradableContract>> {
    let cached = this.readCache(ticker);
    if (cached === undefined) {
      logger.info(`No availability cache for ${ticker} yet. Sweeping it now, which is slow and happens once.`);
      await this.save(ticker);
      cached = this.readCache(ticker);
    }
    if (cached === undefined) {
      throw new Error(`Swept ${ticker} but ${this.file(ticker)} is still not there.`);
    }

    // A contract that never printed is dropped here rather than filtered on every lookup:
    // it has no price, so no instant makes it tradable.
    const tradable = cached.availabilities.flatMap((entry) => {
      const occSymbol = parseOccSymbol(entry.symbol);
      if (occSymbol === undefined || entry.firstTradingMinuteTimestamp === undefined) {
        return [];
      }
      return [{ occSymbol, firstTradingMinuteTimestamp: entry.firstTradingMinuteTimestamp, expirationTimestamp: entry.expirationTimestamp }];
    });

    logger.info(`${ticker}: ${tradable.length} of ${cached.availabilities.length} contracts ever printed, read from ${this.file(ticker)}.`);
    return tradable;
  }

  private file(ticker: string): string {
    return resolve(this.cachePath, `${ticker}.json`);
  }

  /**
   * `undefined` only for a sweep that has not happened yet. A file that exists and cannot
   * be trusted throws instead — it is the one case where carrying on means either
   * answering from a chain that is missing contracts, or silently re-spending a sweep.
   */
  private readCache(ticker: string): OptionContractAvailabilities | undefined {
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
      const record = assertRecord(JSON.parse(text), `${ticker} availability cache`);
      return {
        underlying: assertNonEmptyString(record.underlying, 'underlying'),
        refreshedAt: assertNumber(record.refreshedAt, 'refreshedAt'),
        availabilities: assertArray(record.availabilities, 'availabilities').map((entry, index) => toAvailability(entry, `availabilities[${index}]`)),
      };
    } catch (error: unknown) {
      throw new Error(`${file} is not a readable availability cache: ${String(error)}. Delete it to sweep ${ticker} again from scratch.`);
    }
  }

  /**
   * Written beside the target and renamed over it, because a rebuild costs hundreds of
   * requests and a half-written file parses as a valid, shorter chain rather than failing.
   */
  private writeCache(availabilities: OptionContractAvailabilities): void {
    mkdirSync(this.cachePath, { recursive: true });
    const target = this.file(availabilities.underlying);
    const pending = `${target}.pending`;
    writeFileSync(pending, JSON.stringify(availabilities));
    renameSync(pending, target);
  }
}
