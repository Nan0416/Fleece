import { appendFileSync, closeSync, createReadStream, fstatSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { marketHour, marketState, parseOccSymbol, type AlpacaMarketDataClient, type Bar, type OccSymbol, type OptionSnapshot } from '@fleece/marketdata';
import { assertArray, assertNonEmptyString, assertNumber, assertOptionalRecord, assertRecord, easternClock, LoggerFactory } from '@fleece/utilities';

const logger = LoggerFactory.getLogger('OptionsQuoteSpread');

const CACHE_FOLDER = 'options-quote-spread';

/** Alpaca's page maximum for a chain. */
const CHAIN_PAGE_SIZE = 1_000;

/** How old the underlying's latest minute bar may be before it is no spot to measure moneyness from. */
const MAX_SPOT_AGE = 10 * 60_000;

const MS_PER_DAY = 86_400_000;

/** Upper bounds of each days-to-expiry group, inclusive. */
const DAYS_TO_EXPIRY_BOUNDS: ReadonlyArray<number> = [7, 30, 60, 180];

/** Upper bounds of each out-of-the-money group, inclusive, as a fraction of spot. Negative is in the money. */
const OUT_OF_THE_MONEY_BOUNDS: ReadonlyArray<number> = [-0.1, -0.025, 0.025, 0.1, 0.2];

/** A group with fewer quotes than this answers from a wider one. */
const MIN_SAMPLES = 20;

const ALL = 'all';

/** One `save`, stored as one line of the underlying's file. */
export interface ChainCapture {
  readonly underlying: string;
  readonly capturedAt: number;
  /** The underlying's latest minute bar when the chain was fetched; its close is the spot. */
  readonly underlyingBar: Bar;
  readonly contracts: ReadonlyArray<OptionSnapshot>;
}

export interface EstimateQuoteRequest {
  readonly contract: OccSymbol;
  readonly underlyingPrice: number;
  /** Per share, taken as the middle of the quote — e.g. the last option minute bar's close. */
  readonly referencePrice: number;
  /** The backtest instant, which days to expiry are counted from. */
  readonly timestamp: number;
}

export interface EstimatedQuote {
  readonly bid: number;
  readonly ask: number;
  readonly spread: number;
}

export interface OptionsQuoteSpreadHelper {
  readonly cachePath: string;
  save(underlying: string): Promise<void>;
  estimateQuote(request: EstimateQuoteRequest): Promise<EstimatedQuote>;
}

interface SpreadSample {
  readonly daysToExpiry: number;
  readonly outOfTheMoney: number;
  /** `(ask - bid) / mid`. */
  readonly relativeSpread: number;
}

interface GroupSpread {
  readonly relativeSpread: number;
  readonly samples: number;
}

interface SpreadTable {
  readonly groups: ReadonlyMap<string, GroupSpread>;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** ISO dates parse as UTC midnight, so the difference is a whole number of days. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / MS_PER_DAY);
}

function outOfTheMoney(contract: OccSymbol, spot: number): number {
  const distance = (contract.strike - spot) / spot;
  return contract.type === 'call' ? distance : -distance;
}

function bucket(value: number, bounds: ReadonlyArray<number>): number {
  const index = bounds.findIndex((bound) => value <= bound);
  return index === -1 ? bounds.length : index;
}

function rangeLabel(index: number, bounds: ReadonlyArray<number>, format: (bound: number) => string): string {
  if (index === 0) {
    return `up to ${format(bounds[0])}`;
  }
  if (index === bounds.length) {
    return `over ${format(bounds[bounds.length - 1])}`;
  }
  return `${format(bounds[index - 1])} to ${format(bounds[index])}`;
}

function daysKey(days: number): string {
  return `${rangeLabel(days, DAYS_TO_EXPIRY_BOUNDS, (bound) => `${bound}`)} days`;
}

function groupKey(days: number, outOfTheMoney: number): string {
  return `${daysKey(days)}, ${rangeLabel(outOfTheMoney, OUT_OF_THE_MONEY_BOUNDS, (bound) => `${bound * 100}%`)} out of the money`;
}

/** The minimum increment of a penny-program class. SPY, QQQ and IWM quote in pennies at any price, so above $3 this overstates their floor. */
function tick(price: number): number {
  return price < 3 ? 0.01 : 0.05;
}

function median(values: ReadonlyArray<number>): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/** True for a file that is missing or empty, which an append cannot corrupt either. */
function endsWithNewline(file: string): boolean {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch (error: unknown) {
    if (isMissingFile(error)) {
      return true;
    }
    throw error;
  }
  try {
    const { size } = fstatSync(fd);
    if (size === 0) {
      return true;
    }
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

function samplesOf(value: unknown, ticker: string): ReadonlyArray<SpreadSample> {
  const record = assertRecord(value, 'capture');
  const capturedAt = assertNumber(record.capturedAt, 'capturedAt');
  const spot = assertNumber(assertRecord(record.underlyingBar, 'underlyingBar').c, 'underlyingBar.c');
  const session = marketHour(capturedAt);
  if (session === undefined) {
    throw new Error(`captured at ${easternClock.datetime(capturedAt)}, a date with no market session`);
  }
  const captureDate = easternClock.date(capturedAt);

  const samples: SpreadSample[] = [];
  assertArray(record.contracts, 'contracts').forEach((entry, index) => {
    const snapshot = assertRecord(entry, `contracts[${index}]`);
    const contract = parseOccSymbol(assertNonEmptyString(snapshot.S, `contracts[${index}].S`));
    // Adjusted roots do not deliver 100 shares, so their premiums are not comparable.
    if (contract === undefined || contract.underlying !== ticker || contract.root !== contract.underlying) {
      return;
    }
    const quote = assertOptionalRecord(snapshot.lq, `contracts[${index}].lq`);
    if (quote === undefined) {
      return;
    }
    const bid = assertNumber(quote.bp, `contracts[${index}].lq.bp`);
    const ask = assertNumber(quote.ap, `contracts[${index}].lq.ap`);
    const quotedAt = assertNumber(quote.t, `contracts[${index}].lq.t`);
    // A zero bid is a contract nobody would buy back, which is not one a backtest that saw it print trades.
    // A quote from before the open is left over from an earlier session.
    if (bid <= 0 || ask <= bid || quotedAt < session.openAt) {
      return;
    }
    const daysToExpiry = daysBetween(captureDate, contract.expiration);
    if (daysToExpiry < 0) {
      return;
    }
    samples.push({ daysToExpiry, outOfTheMoney: outOfTheMoney(contract, spot), relativeSpread: (ask - bid) / ((ask + bid) / 2) });
  });
  return samples;
}

/**
 * Estimates an option's bid and ask at a backtest instant from spreads captured off Alpaca's
 * live chain, since Alpaca serves no historical option quotes.
 *
 *     const helper = new OptionsQuoteSpreadHelperImpl(cachePath, marketDataClient());
 *     await helper.save('AMZN');   // during regular hours, as often as wanted
 *     await helper.estimateQuote({ contract, underlyingPrice: 181.2, referencePrice: 12.3, timestamp });
 *
 * `save` appends the raw chain to `options-quote-spread/<TICKER>.jsonl`, one capture per line.
 * `estimateQuote` groups every captured quote by days to expiry and distance from the money,
 * takes each group's median `spread / mid`, and lays half that spread either side of the
 * reference price.
 */
export class OptionsQuoteSpreadHelperImpl implements OptionsQuoteSpreadHelper {
  /** Built from the file once per underlying; a minute-fidelity run asks thousands of times. */
  private readonly tables = new Map<string, Promise<SpreadTable>>();
  private readonly warned = new Set<string>();

  constructor(
    /** The cache root. The files go in its `options-quote-spread` folder. */
    readonly cachePath: string,
    private readonly client: AlpacaMarketDataClient,
    private readonly now: () => number = Date.now,
  ) {}

  async save(underlying: string): Promise<void> {
    const ticker = underlying.trim().toUpperCase();
    const capturedAt = this.now();
    // After the close OPRA stops quoting, so the chain's quotes would be hours stale.
    if (marketState(capturedAt) !== 'open') {
      throw new Error(`It is ${easternClock.datetime(capturedAt)}, outside regular hours, when option quotes are stale. Capture ${ticker} while the market is open.`);
    }

    const underlyingBar = await this.latestBar(ticker, capturedAt);
    const contracts = await this.wholeChain(ticker);
    if (contracts.length === 0) {
      throw new Error(`Alpaca returned an empty chain for ${ticker}. Nothing was written; check the ticker has listed options.`);
    }

    this.append({ underlying: ticker, capturedAt, underlyingBar, contracts });
    this.tables.delete(ticker);
    logger.info(`${ticker}: captured ${contracts.length} contracts against spot ${underlyingBar.c} to ${this.file(ticker)}.`);
  }

  async estimateQuote(request: EstimateQuoteRequest): Promise<EstimatedQuote> {
    const { contract, underlyingPrice, referencePrice, timestamp } = request;
    if (!(referencePrice > 0) || !(underlyingPrice > 0)) {
      throw new Error(`${contract.symbol} needs a positive reference price and underlying price to estimate a quote, and was given ${referencePrice} and ${underlyingPrice}.`);
    }

    const { groups } = await this.table(contract.underlying);
    const days = bucket(daysBetween(easternClock.date(timestamp), contract.expiration), DAYS_TO_EXPIRY_BOUNDS);
    const moneyness = bucket(outOfTheMoney(contract, underlyingPrice), OUT_OF_THE_MONEY_BOUNDS);

    const candidates = [groupKey(days, moneyness), daysKey(days), ALL];
    const key = candidates.find((candidate) => (groups.get(candidate)?.samples ?? 0) >= MIN_SAMPLES) ?? ALL;
    const group = groups.get(key);
    if (group === undefined) {
      throw new Error(`${contract.underlying} has no usable captured quotes. Run save('${contract.underlying}') during regular hours.`);
    }
    if (key !== candidates[0]) {
      this.warnOnce(`${contract.underlying}: ${candidates[0]} has ${groups.get(candidates[0])?.samples ?? 0} captured quotes, fewer than ${MIN_SAMPLES}. Using ${key} instead.`);
    }

    const spread = Math.max(tick(referencePrice), group.relativeSpread * referencePrice);
    const bid = Math.max(0, referencePrice - spread / 2);
    const ask = referencePrice + spread / 2;
    return { bid, ask, spread: ask - bid };
  }

  private async latestBar(ticker: string, capturedAt: number): Promise<Bar> {
    const { bars } = await this.client.minuteBars({ symbol: ticker, from: capturedAt - MAX_SPOT_AGE, to: capturedAt });
    const latest = bars.at(-1);
    if (latest === undefined) {
      throw new Error(
        `Alpaca has no ${ticker} minute bar in the ${MAX_SPOT_AGE / 60_000} minutes before ${easternClock.datetime(capturedAt)}, so there is no spot to measure moneyness from. Nothing was written.`,
      );
    }
    return latest;
  }

  private async wholeChain(ticker: string): Promise<ReadonlyArray<OptionSnapshot>> {
    const snapshots: OptionSnapshot[] = [];
    let startAfter: string | undefined = undefined;
    do {
      const page = await this.client.optionChain({ underlying: ticker, limit: CHAIN_PAGE_SIZE, startAfter });
      snapshots.push(...page.contracts);
      startAfter = page.resumeFrom;
    } while (startAfter !== undefined);
    return snapshots;
  }

  private table(ticker: string): Promise<SpreadTable> {
    const already = this.tables.get(ticker);
    if (already !== undefined) {
      return already;
    }
    const loading = this.load(ticker).catch((error: unknown) => {
      this.tables.delete(ticker);
      throw error;
    });
    this.tables.set(ticker, loading);
    return loading;
  }

  private async load(ticker: string): Promise<SpreadTable> {
    const file = this.file(ticker);
    try {
      statSync(file);
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        throw new Error(`No quote captures for ${ticker} at ${file}. Run save('${ticker}') during regular hours first.`);
      }
      throw error;
    }

    const spreads = new Map<string, number[]>();
    const add = (key: string, relativeSpread: number): void => {
      const values = spreads.get(key) ?? [];
      values.push(relativeSpread);
      spreads.set(key, values);
    };

    let captures = 0;
    let lineNumber = 0;
    // Line by line: many captures of a large chain are more than one string can hold.
    const input = createReadStream(file, 'utf8');
    try {
      for await (const line of createInterface({ input, crlfDelay: Infinity })) {
        lineNumber += 1;
        if (line.trim().length === 0) {
          continue;
        }
        let samples: ReadonlyArray<SpreadSample>;
        try {
          samples = samplesOf(JSON.parse(line), ticker);
        } catch (error: unknown) {
          throw new Error(`Line ${lineNumber} of ${file} is not a readable capture: ${String(error)}. Delete that line to keep the others.`);
        }
        captures += 1;
        for (const sample of samples) {
          const days = bucket(sample.daysToExpiry, DAYS_TO_EXPIRY_BOUNDS);
          add(groupKey(days, bucket(sample.outOfTheMoney, OUT_OF_THE_MONEY_BOUNDS)), sample.relativeSpread);
          add(daysKey(days), sample.relativeSpread);
          add(ALL, sample.relativeSpread);
        }
      }
    } finally {
      input.destroy();
    }

    const groups = new Map<string, GroupSpread>();
    for (const [key, values] of spreads) {
      groups.set(key, { relativeSpread: median(values), samples: values.length });
    }
    logger.info(`${ticker}: ${groups.get(ALL)?.samples ?? 0} usable quotes from ${captures} captures in ${file}.`);
    return { groups };
  }

  private warnOnce(message: string): void {
    if (!this.warned.has(message)) {
      this.warned.add(message);
      logger.warn(message);
    }
  }

  private append(capture: ChainCapture): void {
    mkdirSync(this.folder(), { recursive: true });
    const file = this.file(capture.underlying);
    // Appending after a cut-off line would glue this capture onto it and lose both.
    if (!endsWithNewline(file)) {
      throw new Error(`${file} does not end with a newline, so its last capture was cut off mid-write. Delete that last line, then save again.`);
    }
    appendFileSync(file, `${JSON.stringify(capture)}\n`);
  }

  private folder(): string {
    return resolve(this.cachePath, CACHE_FOLDER);
  }

  private file(ticker: string): string {
    return resolve(this.folder(), `${ticker}.jsonl`);
  }
}
