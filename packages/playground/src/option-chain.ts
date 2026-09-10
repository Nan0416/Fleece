/**
 * Writes AAPL's near-dated chain — one record per contract, both types, carrying the
 * greeks, the implied volatility and the quote — to `viz/data/option-chain.json`, which
 * `viz/option_chain.py` draws as eight contour panels.
 *
 *   npm run option-chain -w @fleece/playground
 *   uv run --project viz viz/option_chain.py
 *
 * Nothing is filtered: every contract Alpaca could say anything about is written, both
 * sides of spot, with each measure null where it is missing rather than absent or zeroed —
 * a zero delta is a real value a far out-of-the-money call has. One record per contract
 * rather than a grid, because expirations do not share a strike set; the renderer
 * triangulates the scattered points.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { AlpacaMarketDataClient, type OptionChainRequest, type OptionSnapshot, type OptionType } from '@fleece/marketdata';
import { LoggerFactory, easternClock } from '@fleece/utilities';

import { marketDataKeys } from './credentials';

const logger = LoggerFactory.getLogger('OptionChain');

const UNDERLYING = 'AMZN';

/** Past a few months the term structure flattens and delta is a wall of near-1. */
const EXPIRATION_WINDOW_DAYS = 50;

/**
 * Strikes within this fraction of spot. Widen it for more of the skew, which is only
 * visible in the wings; past about a third out the bid is a penny on a contract nobody has
 * traded, and the volatility solved from it says more about the tick size than the market.
 */
const STRIKE_BAND = 0.15;

/**
 * How far apart the two sides of a strike may sit before the chart says so, as a fraction —
 * `0.01` is one volatility point.
 *
 * Put-call parity says a call and a put on one strike share an implied volatility, so two
 * different numbers mean the greeks and the quotes are marked against different underlying
 * prices. That is the ordinary state after hours, when OPRA has stopped quoting and the
 * stock trades on. Past this line the chain is still written, and the figure is stamped.
 */
const SEAM_TOLERANCE = 0.01;

/**
 * The smallest bid a seam reading will be taken from, in dollars. Only the seam — Alpaca
 * solves a volatility even for a 0.00 x 0.05 quote, and parity checked against tick noise
 * reports a rounding as a disagreement.
 */
const SEAM_MINIMUM_BID = 0.05;

/** Alpaca's page maximum for a chain. */
const PAGE_SIZE = 1_000;

/** `dist/` at runtime, so three levels up is the repo root. */
const ROOT = resolve(__dirname, '../../..');
const OUTPUT = resolve(ROOT, 'viz/data/option-chain.json');

/**
 * One contract, flat. Every measure is nullable and every key always present, so a missing
 * field never has to be told apart from a zero — Alpaca omits the greeks and the
 * volatility for roughly four contracts in ten of a large chain.
 */
interface ContractRecord {
  readonly symbol: string;
  readonly expiration: string;
  readonly strike: number;
  readonly type: OptionType;
  readonly delta: number | null;
  readonly gamma: number | null;
  readonly theta: number | null;
  readonly vega: number | null;
  readonly rho: number | null;
  /** As a fraction: `0.31` is 31%. */
  readonly iv: number | null;
  readonly bid: number | null;
  readonly ask: number | null;
  /** The middle of the quote, in dollars per share. */
  readonly mid: number | null;
}

/** One expiration's disagreement between its two sides, at the strike nearest spot. */
interface SeamReading {
  readonly expiration: string;
  /** `|call iv - put iv|`, as a fraction. */
  readonly disagreement: number;
  /** How far the underlying behind the greeks sits above the one behind the quotes, in dollars. */
  readonly greeksAhead: number;
}

interface Seam {
  /** How many expirations carried a strike quoted on both sides. */
  readonly expirations: number;
  /** Median across them, as a fraction. */
  readonly disagreement: number;
  /** Median price error behind it, in dollars. Positive means the greeks lead. */
  readonly greeksAhead: number;
  readonly tolerance: number;
  readonly stale: boolean;
}

/**
 * The last close, as the centre of the strike band. A week back rather than today, because
 * `dailyBars` answers about sessions and a one-day window is empty before the open.
 */
async function lastClose(client: AlpacaMarketDataClient, today: string): Promise<number> {
  const { bars } = await client.dailyBars({ symbol: UNDERLYING, from: easternClock.shiftDate(today, -7), to: today });
  const latest = bars.at(-1);
  if (latest === undefined) {
    throw new Error(`Alpaca has no daily bar for ${UNDERLYING} in the last week, so there is no spot price to centre the strikes on.`);
  }
  return latest.c;
}

/** Every page of the chain. The client hands back one page and a cursor; walking it is the caller's job. */
async function wholeChain(client: AlpacaMarketDataClient, request: OptionChainRequest): Promise<ReadonlyArray<OptionSnapshot>> {
  const snapshots: OptionSnapshot[] = [];
  let startAfter: string | undefined = undefined;

  do {
    const page = await client.optionChain({ ...request, limit: PAGE_SIZE, startAfter });
    snapshots.push(...page.contracts);
    startAfter = page.resumeFrom;
  } while (startAfter !== undefined);

  return snapshots;
}

/** The middle of the quote. An ask of zero means no quote at all, not a free option. */
function midOf(snapshot: OptionSnapshot): number | null {
  const { lq } = snapshot;
  if (lq === undefined || lq.ap <= 0) {
    return null;
  }
  return (lq.bp + lq.ap) / 2;
}

/**
 * The seam, one reading per expiration, at the strike nearest spot — where vega is largest
 * and so least disturbed by a penny of rounding in either quote.
 */
function readSeams(snapshots: ReadonlyArray<OptionSnapshot>, spot: number): ReadonlyArray<SeamReading> {
  const sides = new Map<string, { call?: OptionSnapshot; put?: OptionSnapshot }>();

  for (const snapshot of snapshots) {
    const { iv, greeks, lq, contract } = snapshot;
    if (typeof iv !== 'number' || greeks === undefined || lq === undefined || lq.bp < SEAM_MINIMUM_BID) {
      continue;
    }
    const key = `${contract.expiration}:${contract.strike}`;
    const pair = sides.get(key) ?? {};
    sides.set(key, contract.type === 'call' ? { ...pair, call: snapshot } : { ...pair, put: snapshot });
  }

  const nearest = new Map<string, SeamReading & { distance: number }>();
  for (const { call, put } of sides.values()) {
    if (call?.iv === undefined || put?.iv === undefined || call.greeks === undefined) {
      continue;
    }
    const { expiration, strike } = call.contract;
    const distance = Math.abs(strike - spot);
    const previous = nearest.get(expiration);
    if (previous !== undefined && previous.distance <= distance) {
      continue;
    }
    nearest.set(expiration, {
      expiration,
      distance,
      disagreement: Math.abs(call.iv - put.iv),
      greeksAhead: (put.iv - call.iv) * 100 * call.greeks.vega,
    });
  }

  return [...nearest.values()].map(({ expiration, disagreement, greeksAhead }) => ({ expiration, disagreement, greeksAhead }));
}

/** The middle reading, so one ragged expiration cannot set the stamp. */
function median(values: ReadonlyArray<number>): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/** Null when no strike is quoted on both sides. */
function measureSeam(snapshots: ReadonlyArray<OptionSnapshot>, spot: number): Seam | null {
  const seams = readSeams(snapshots, spot);
  if (seams.length === 0) {
    return null;
  }

  const disagreement = median(seams.map((seam) => seam.disagreement));
  return {
    expirations: seams.length,
    disagreement,
    greeksAhead: median(seams.map((seam) => seam.greeksAhead)),
    tolerance: SEAM_TOLERANCE,
    stale: disagreement > SEAM_TOLERANCE,
  };
}

/**
 * Every contract Alpaca said something about, oldest expiration first. Only one carrying
 * neither greeks nor a quote is dropped, since no panel could draw it.
 */
function flatten(snapshots: ReadonlyArray<OptionSnapshot>): { contracts: ReadonlyArray<ContractRecord>; empty: number } {
  const contracts: ContractRecord[] = [];
  let empty = 0;

  for (const snapshot of snapshots) {
    const { greeks, contract, lq } = snapshot;
    const mid = midOf(snapshot);

    if (greeks === undefined && mid === null) {
      empty += 1;
      continue;
    }

    contracts.push({
      symbol: snapshot.S,
      expiration: contract.expiration,
      strike: contract.strike,
      type: contract.type,
      delta: greeks?.delta ?? null,
      gamma: greeks?.gamma ?? null,
      theta: greeks?.theta ?? null,
      vega: greeks?.vega ?? null,
      rho: greeks?.rho ?? null,
      iv: snapshot.iv ?? null,
      bid: lq?.bp ?? null,
      ask: lq?.ap ?? null,
      mid,
    });
  }

  contracts.sort((a, b) => {
    if (a.expiration !== b.expiration) {
      return a.expiration.localeCompare(b.expiration);
    }
    return a.strike === b.strike ? a.type.localeCompare(b.type) : a.strike - b.strike;
  });

  return { contracts, empty };
}

/** The seam in a sentence, for the log. */
function describeSeam(seam: Seam | null, spot: number): string {
  if (seam === null) {
    return `No strike is quoted on both sides, so put-call parity could not be checked against ${UNDERLYING}'s quotes.`;
  }
  if (!seam.stale) {
    return `Puts and calls agree to ${(seam.disagreement * 100).toFixed(2)} volatility points at the money across ${seam.expirations} expirations.`;
  }
  return [
    `Puts and calls disagree by ${(seam.disagreement * 100).toFixed(1)} volatility points at the money, against a tolerance of ${(seam.tolerance * 100).toFixed(1)}.`,
    `Parity says a strike has one volatility, so this is not skew — it is the greeks being marked against an underlying about ${Math.abs(seam.greeksAhead).toFixed(2)} dollars`,
    `${seam.greeksAhead >= 0 ? 'above' : 'below'} the ${spot.toFixed(2)} the quotes were struck at.`,
    'That is what the evening looks like: OPRA stops quoting at the option close and the stock trades on without it.',
    'The call and put rows will sit at different levels; run this during the option session and they come back into step.',
  ].join(' ');
}

async function main(): Promise<void> {
  const client = new AlpacaMarketDataClient(marketDataKeys());
  const today = easternClock.date();
  const spot = await lastClose(client, today);
  const expirationTo = easternClock.shiftDate(today, EXPIRATION_WINDOW_DAYS);

  logger.info(`${UNDERLYING} last closed at ${spot.toFixed(2)}. Fetching calls and puts expiring ${today} to ${expirationTo}, within ${STRIKE_BAND * 100}% of that.`);

  const snapshots = await wholeChain(client, {
    underlying: UNDERLYING,
    expirationFrom: today,
    expirationTo,
    strikeFrom: Math.round(spot * (1 - STRIKE_BAND)),
    strikeTo: Math.round(spot * (1 + STRIKE_BAND)),
  });

  const seam = measureSeam(snapshots, spot);
  const note = describeSeam(seam, spot);
  if (seam?.stale ?? true) {
    logger.warn(note);
  } else {
    logger.info(note);
  }

  const { contracts, empty } = flatten(snapshots);
  if (contracts.length === 0) {
    throw new Error(`Alpaca priced none of the ${snapshots.length} contracts in the band. There is nothing to plot.`);
  }

  const expirations = new Set(contracts.map((contract) => contract.expiration));
  const calls = contracts.filter((contract) => contract.type === 'call').length;

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify({ underlying: UNDERLYING, generatedAt: new Date().toISOString(), spot, seam, seamNote: note, contracts }, null, 2)}\n`);

  logger.info(`Wrote ${contracts.length} contracts — ${calls} calls, ${contracts.length - calls} puts — across ${expirations.size} expirations to ${OUTPUT}.`);
  if (empty > 0) {
    logger.info(`Left out ${empty} that came back with neither greeks nor a quote, which no panel could draw.`);
  }
}

main().catch((err: unknown) => {
  logger.error('Could not write the option chain.', err);
  process.exitCode = 1;
});
