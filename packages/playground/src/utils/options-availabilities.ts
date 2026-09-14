import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { marketHour, parseOccSymbol, type AlpacaMarketDataClient, type Bar, type OccSymbol, type OptionContractStatus } from '@fleece/marketdata';
import { assertArray, assertNonEmptyString, assertNumber, assertOptionalInteger, assertRecord, easternClock, LoggerFactory, mapWithConcurrency } from '@fleece/utilities';

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
 * client nor the HTTP seam retries one, so raising this trades wall-clock for a 429,
 * which fails the whole `save`.
 */
const SWEEP_CONCURRENCY = 10;

/** The folder under the cache root these files live in, so other caches can share the root. */
const CACHE_FOLDER = 'options-availabilities';

/** What an equity option stops trading at, on every day the market-hours table does not name. */
const REGULAR_CLOSE = '16:00:00';

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
 *     await helper.save('AMZN');                       // sweeps the chain, writes options-availabilities/AMZN.json
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
    /** The cache root. The files go in its `options-availabilities` folder. */
    readonly cachePath: string,
    private readonly client: AlpacaMarketDataClient,
    /** Injectable so "has this expired" is a fixed question in a test rather than today's. */
    private readonly now: () => number = Date.now,
    private readonly concurrency: number = SWEEP_CONCURRENCY,
  ) {}

  /**
   * Any request that fails fails the whole sweep, and nothing is written: the previous file
   * stays as it was, and a rerun asks again. So every entry in a file is an answer a sweep
   * actually got, which is what lets the next run trust a missing first print.
   */
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

    // An empty listing is not an empty chain: Alpaca serving an empty page, or an upstream
    // fault normalised into one, would otherwise write a file with nothing in it over a
    // sweep that cost hundreds of requests, and every option strategy would then silently
    // trade nothing.
    if (listed.length === 0 && previous !== undefined && previous.availabilities.length > 0) {
      throw new Error(
        `${ticker} listed no contracts, but ${this.file(ticker)} holds ${previous.availabilities.length}. Refusing to overwrite a swept chain with an empty one. Delete the file if ${ticker} really has no options.`,
      );
    }

    const cached = new Map((previous?.availabilities ?? []).map((entry) => [entry.symbol, entry]));
    const settled: OptionContractAvailability[] = [];
    const pending: OccSymbol[] = [];
    for (const contract of listed) {
      const known = cached.get(contract.symbol);
      // A first print cannot change, so it settles on its own. No print is final only if the
      // contract had already expired when the previous file was written: an entry in it is
      // either an answer that sweep got or one kept because it was already final, so an
      // unprinted contract that expired after that sweep may have printed since.
      const settledByPrint = known?.firstTradingMinuteTimestamp !== undefined;
      const settledByExpiry = known !== undefined && previous !== undefined && known.expirationTimestamp < previous.refreshedAt;
      if (known !== undefined && (settledByPrint || settledByExpiry)) {
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
      // Outside the market-hours table there is no session to read a close from. That is a
      // LEAP expiring past the table's last year, or an expiry on a day the market closed
      // after the contract was listed: 2025-01-09 was declared a national day of mourning
      // for President Carter, so contracts expiring that day last traded on 2025-01-08, and
      // that day's close set their final value.
      //
      // Dropping the contract left nothing recorded, so every later run swept it again and
      // dropped it again. The regular close on the expiration date stands in instead. On a
      // half day that is three hours generous, and for a closure like 2025-01-09 it is a day
      // late with no session in between; either beats never settling at all.
      const session = marketHour(contract.expiration);
      const expirationTimestamp = session?.closeAt ?? easternClock.timestamp(contract.expiration, REGULAR_CLOSE);
      if (session === undefined) {
        logger.warn(`${contract.symbol} expires ${contract.expiration}, a date with no session in the market-hours table. Taking the regular ${REGULAR_CLOSE} close on that date.`);
      }
      availabilities.push({ symbol: contract.symbol, firstTradingMinuteTimestamp: firstMinutes.get(contract.symbol), expirationTimestamp });
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

  /**
   * The day each contract first printed on, from one daily sweep of the whole chain. A
   * contract missing from the map was asked about and never traded on any day.
   */
  private async sweepFirstTradingDates(contracts: ReadonlyArray<OccSymbol>): Promise<ReadonlyMap<string, string>> {
    const today = easternClock.date(this.now());
    const firstDates = new Map<string, string>();

    const batches: Array<ReadonlyArray<OccSymbol>> = [];
    for (let first = 0; first < contracts.length; first += SWEEP_BATCH) {
      batches.push(contracts.slice(first, first + SWEEP_BATCH));
    }

    let swept = 0;
    await mapWithConcurrency(batches, this.concurrency, async (batch) => {
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
      swept += 1;
      logger.info(`Swept ${swept} of ${batches.length} batches for a first trading day.`);
    });

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

    let swept = 0;
    await mapWithConcurrency(dates, this.concurrency, async (date) => {
      const symbols = byDate.get(date) ?? [];
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
        if (session === undefined) {
          // No session to take a close from: a daily bar on a day the market was shut,
          // which Alpaca has served (AMZN250620P00150000 on Saturday 2024-06-01).
          const message = `${symbol} printed on ${date}, which has no market session and no minute bars, so there is no minute to date its first print from.`;
          logger.error(message);
          throw new Error(message);
        }
        logger.warn(`${symbol} printed on ${date} with no minute bars. Dated from that session's close.`);
        firstMinutes.set(symbol, session.closeAt);
      }
      swept += 1;
      logger.info(`Swept ${swept} of ${dates.length} days for a first trading minute.`);
    });

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

  private folder(): string {
    return resolve(this.cachePath, CACHE_FOLDER);
  }

  private file(ticker: string): string {
    return resolve(this.folder(), `${ticker}.json`);
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
    mkdirSync(this.folder(), { recursive: true });
    const target = this.file(availabilities.underlying);
    const pending = `${target}.pending`;
    writeFileSync(pending, JSON.stringify(availabilities));
    renameSync(pending, target);
  }
}
