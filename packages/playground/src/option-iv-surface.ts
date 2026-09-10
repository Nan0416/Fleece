/**
 * Writes AAPL's near-dated out-of-the-money chain — one record per contract, carrying the
 * strike, the expiration and the implied volatility — to
 * `viz/data/option-iv-surface.json`, which `viz/option_iv_surface.py` plots as a 3D
 * volatility surface.
 *
 *   npm run option-iv-surface -w @fleece/playground
 *   uv run --project viz viz/option_iv_surface.py
 *
 * Run it while the option market is open. It refuses otherwise, and
 * `MAX_SEAM_DISAGREEMENT` below is the whole reason why.
 *
 * Keys come from the repo-root `.env` rather than `credentials.ts`, as
 * `option-delta-surface.ts` does and for the same reason: these are market-data keys
 * rather than broker keys, and the live suites already read them from there.
 *
 * Puts below spot and calls above it, rather than one type across the whole band. Put-call
 * parity says the two at a strike share an implied volatility, so taking both is not
 * double-counting the same number — it is taking each half from the side that is actually
 * quoted. An in-the-money contract trades a couple of hundred dollars of intrinsic value
 * for a few cents of extrinsic, so its quote is wide and the volatility solved out of it
 * is mostly the width of the spread. The wings are the whole point of this chart, and the
 * only honest wings are the out-of-the-money ones.
 *
 * As with the delta surface, what it writes is tidy and deliberately not a grid:
 * expirations do not share a strike set, and inventing the missing ones is not this
 * script's decision to make.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { AlpacaMarketDataClient, type OptionChainRequest, type OptionSnapshot, type OptionType } from '@fleece/marketdata';
import { LoggerFactory, easternClock } from '@fleece/utilities';
import { config as loadEnv } from 'dotenv';

const logger = LoggerFactory.getLogger('OptionIvSurface');

const UNDERLYING = 'AAPL';

/**
 * How far out to reach. Same window as the delta surface, and for a related reason: past
 * a few months the term structure has flattened into a plane and the near-dated end —
 * where the skew is steepest and moves fastest — is squeezed into the first inch of the
 * axis.
 */
const EXPIRATION_WINDOW_DAYS = 120;

/**
 * Strikes within this fraction of spot. Wider than the delta surface's band on purpose:
 * delta goes flat in the wings and there is nothing out there to see, whereas the skew is
 * *only* visible in the wings — a chain priced the way Black-Scholes assumes would be flat
 * across every strike, and the shape of its departure from flat is the chart.
 *
 * Not wider still, because the far tail stops being a price. Somewhere past a third out
 * the bid is a penny on a contract nobody has traded, and the volatility solved from it
 * says more about the tick size than about what anyone expects.
 */
const STRIKE_BAND = 0.35;

/**
 * The smallest bid this will take a volatility from, in dollars.
 *
 * A nickel is not arbitrary. Measured over one AAPL chain in this band: the 89 contracts
 * bid under it quoted a mean spread of 130% of their own mid — 0.01 × 0.07 and the like —
 * against 24% for the 349 above it. A contract whose ask is seven times its bid has not
 * got a price, and the volatility solved from the mark of one is a statement about where
 * the minimum tick fell. Those contracts were also, exactly, the top of the range:
 * dropping them takes the surface's maximum from 85% to 66% and costs no expiration and
 * no part of the skew that anyone trades.
 *
 * Dropped rather than clamped. A clamp would draw tick noise as a real reading pinned at
 * the edge of the scale, which is worse than not drawing it — the eye reads a plateau as
 * a finding.
 */
const MINIMUM_BID = 0.05;

/**
 * The most the two sides of a strike may disagree before this refuses to write, as a
 * fraction — `0.01` is one volatility point.
 *
 * Put-call parity makes this measurable. A call and a put on the same strike and
 * expiration are the same claim decomposed two ways, so they share one implied volatility
 * and one vega, and Alpaca reporting two different numbers means its greeks and the
 * quotes it solved them from are not looking at the same underlying price.
 *
 * That happens every evening. OPRA stops quoting at the option close while the stock goes
 * on trading after hours, so by 9pm the quotes are frozen against one price and the
 * greeks are marked against another. It is not a small effect and it is not noise: it
 * pushes puts up and calls down by equal and opposite amounts, which lands as a cliff at
 * exactly the strike where this chart splices the two sides together. Measured one evening
 * with the stock $2.76 above its close, the seam step ran from 4.8 volatility points at
 * the December expiration to 17.8 at the September one — the same dollar error divided by
 * a vega that shrinks as expiry nears.
 *
 * A point of slack absorbs the ordinary case, where the greeks refresh a beat behind a
 * ticking underlying. Beyond that the surface would be drawing the clock, not the market.
 */
const MAX_SEAM_DISAGREEMENT = 0.01;

/** Alpaca's page maximum for a chain. */
const PAGE_SIZE = 1_000;

/** `dist/` at runtime, so three levels up is the repo root. */
const ROOT = resolve(__dirname, '../../..');
const OUTPUT = resolve(ROOT, 'viz/data/option-iv-surface.json');

/**
 * One contract, flat.
 *
 * `delta` rides along because it is the other axis a volatility surface is conventionally
 * quoted against — a trader asks for the 25-delta put, not for the 290 strike — and
 * carrying it means the renderer can label the wings that way without a second request.
 * `bid` and `ask` ride along as the evidence: they are what the volatility was solved
 * out of, and a reader who distrusts a point on the surface should be able to see the
 * quote behind it without going back to Alpaca.
 */
interface ContractRecord {
  readonly symbol: string;
  readonly expiration: string;
  readonly strike: number;
  readonly type: OptionType;
  /** As a fraction: `0.31` is 31%. */
  readonly iv: number;
  readonly delta: number;
  readonly bid: number;
  readonly ask: number;
}

/** What a pass over the chain kept, and what it did not. The counts are the log line. */
interface Selection {
  readonly contracts: ReadonlyArray<ContractRecord>;
  readonly unsolved: number;
  readonly thinlyQuoted: number;
  readonly inTheMoney: number;
}

/**
 * How far apart the two sides of a strike are, where both are quoted.
 *
 * `disagreement` is what shows on the chart and what the gate is set against;
 * `greeksAhead` is the same fact in the units that explain it.
 */
interface SeamReading {
  readonly expiration: string;
  /** `|call iv - put iv|` at the strike nearest spot, as a fraction. */
  readonly disagreement: number;
  /**
   * How far the underlying behind the greeks sits above the one behind the quotes, in
   * dollars.
   *
   * Subtracting the two parity relations leaves the deltas cancelling to one — a call's
   * delta less a put's is exactly 1 at the same strike — so the whole price error falls
   * out of a single pair as the volatility difference times vega. Alpaca states vega per
   * volatility *point*, hence the 100.
   */
  readonly greeksAhead: number;
}

/**
 * The last close, as the centre of the strike band and the line the two sides are split
 * on.
 *
 * A week back rather than today, because `dailyBars` answers about sessions and today is
 * not one before the open — on a Monday morning, or the Tuesday after a long weekend, a
 * one-day window comes back empty.
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

/** Whether Alpaca priced the contract well enough to take a volatility from it. */
function usable(snapshot: OptionSnapshot): boolean {
  const { iv, greeks, lq } = snapshot;
  return typeof iv === 'number' && greeks !== undefined && lq !== undefined && lq.bp >= MINIMUM_BID;
}

/**
 * Whether the contract is on its quoted side of spot.
 *
 * The strike that lands exactly on spot goes to the puts, arbitrarily but consistently,
 * so it appears once.
 */
function outOfTheMoney(snapshot: OptionSnapshot, spot: number): boolean {
  const { type, strike } = snapshot.contract;
  return type === 'put' ? strike <= spot : strike > spot;
}

/**
 * The seam, one reading per expiration, taken at the strike nearest spot.
 *
 * Nearest spot rather than an average over the chain because that is where this chart
 * joins its two halves, so it is the disagreement that would actually be drawn — and
 * because it is where vega is largest, which makes it the reading least disturbed by a
 * penny of rounding in either quote.
 */
function readSeams(snapshots: ReadonlyArray<OptionSnapshot>, spot: number): ReadonlyArray<SeamReading> {
  const sides = new Map<string, { call?: OptionSnapshot; put?: OptionSnapshot }>();

  for (const snapshot of snapshots) {
    if (!usable(snapshot)) {
      continue;
    }
    const { expiration, strike, type } = snapshot.contract;
    const key = `${expiration}:${strike}`;
    const pair = sides.get(key) ?? {};
    sides.set(key, type === 'call' ? { ...pair, call: snapshot } : { ...pair, put: snapshot });
  }

  const nearest = new Map<string, SeamReading & { distance: number }>();
  for (const { call, put } of sides.values()) {
    if (call === undefined || put === undefined || call.iv === undefined || put.iv === undefined || call.greeks === undefined) {
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

/** The middle reading, which is the one the gate is set against. Robust to a single ragged expiration. */
function median(values: ReadonlyArray<number>): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/**
 * Contracts on their quoted side of spot that Alpaca solved a volatility for and that
 * someone is bidding `MINIMUM_BID` or better on, oldest expiration first and by strike
 * within it.
 *
 * Alpaca solves from the mark, which is why the bid has to be looked at separately: a
 * contract quoted 0.00 × 0.05 still comes back carrying a volatility, solved from an ask
 * nobody has offered to meet. Absent greeks are dropped for the same reason the delta
 * surface drops them — it prices from a quote, and these had none — with the difference
 * that here the greeks are cargo and `iv` is the measure, so a contract missing either is
 * no use.
 */
function quoted(snapshots: ReadonlyArray<OptionSnapshot>, spot: number): Selection {
  const contracts: ContractRecord[] = [];
  let unsolved = 0;
  let thinlyQuoted = 0;
  let inTheMoney = 0;

  for (const snapshot of snapshots) {
    const { iv, greeks, contract, lq } = snapshot;

    if (!outOfTheMoney(snapshot, spot)) {
      inTheMoney += 1;
      continue;
    }
    if (typeof iv !== 'number' || greeks === undefined) {
      unsolved += 1;
      continue;
    }
    if (lq === undefined || lq.bp < MINIMUM_BID) {
      thinlyQuoted += 1;
      continue;
    }

    contracts.push({
      symbol: snapshot.S,
      expiration: contract.expiration,
      strike: contract.strike,
      type: contract.type,
      iv,
      delta: greeks.delta,
      bid: lq.bp,
      ask: lq.ap,
    });
  }

  contracts.sort((a, b) => (a.expiration === b.expiration ? a.strike - b.strike : a.expiration.localeCompare(b.expiration)));
  return { contracts, unsolved, thinlyQuoted, inTheMoney };
}

/**
 * Refuses the chain when the two sides of a strike do not agree.
 *
 * Refuses rather than warns. The surface a mismatched chain draws is not a rough one, it
 * is a confident one with a feature in it that is not in the market — a wall at the money
 * that looks exactly like a finding — and a reader has no way to tell it from the real
 * thing. This is the same call the coverage gate makes about a suite that skips itself:
 * better nothing than a number that means something else.
 */
function requireAgreement(seams: ReadonlyArray<SeamReading>, spot: number): number {
  if (seams.length === 0) {
    throw new Error(
      `No strike in ${UNDERLYING}'s chain is quoted on both sides, so there is no way to check the greeks against the quotes. Refusing to draw a surface that cannot be checked.`,
    );
  }

  const disagreement = median(seams.map((seam) => seam.disagreement));
  if (disagreement <= MAX_SEAM_DISAGREEMENT) {
    return disagreement;
  }

  const greeksAhead = median(seams.map((seam) => seam.greeksAhead));
  const worst = seams.reduce((a, b) => (a.disagreement >= b.disagreement ? a : b));
  throw new Error(
    [
      `${UNDERLYING}'s puts and calls disagree by ${(disagreement * 100).toFixed(1)} volatility points at the money, against a tolerance of ${(MAX_SEAM_DISAGREEMENT * 100).toFixed(1)}`,
      `(worst: ${(worst.disagreement * 100).toFixed(1)} points at the ${worst.expiration} expiration).`,
      `Parity says a strike has one volatility, so this is not skew — it is the greeks being marked against an underlying about ${Math.abs(greeksAhead).toFixed(2)} dollars`,
      `${greeksAhead >= 0 ? 'above' : 'below'} the ${spot.toFixed(2)} the quotes were struck at.`,
      'That is what the evening looks like: OPRA stops quoting at the option close and the stock trades on without it.',
      'Run this during the option session and the two come back into step.',
    ].join(' '),
  );
}

async function main(): Promise<void> {
  loadEnv({ path: resolve(ROOT, '.env'), quiet: true });

  const apiKey = process.env['ALPACA_PAPER_API_KEY'];
  const secretKey = process.env['ALPACA_PAPER_SECRET_KEY'];
  if (apiKey === undefined || secretKey === undefined) {
    throw new Error('This script needs ALPACA_PAPER_API_KEY and ALPACA_PAPER_SECRET_KEY in the repo-root .env.');
  }

  const client = new AlpacaMarketDataClient({ apiKey, secretKey });
  const today = easternClock.date();
  const spot = await lastClose(client, today);
  const expirationTo = easternClock.shiftDate(today, EXPIRATION_WINDOW_DAYS);

  logger.info(`${UNDERLYING} last closed at ${spot.toFixed(2)}. Fetching contracts expiring ${today} to ${expirationTo}, within ${STRIKE_BAND * 100}% of that.`);

  // Both types across the whole band, not each side of spot. Half of it is thrown away
  // below, and the half that is thrown away is what pays for the parity check: the seam
  // can only be measured where a strike carries a call and a put at once.
  const snapshots = await wholeChain(client, {
    underlying: UNDERLYING,
    expirationFrom: today,
    expirationTo,
    strikeFrom: Math.round(spot * (1 - STRIKE_BAND)),
    strikeTo: Math.round(spot * (1 + STRIKE_BAND)),
  });

  const seams = readSeams(snapshots, spot);
  const agreement = requireAgreement(seams, spot);
  logger.info(`Puts and calls agree to ${(agreement * 100).toFixed(2)} volatility points at the money across ${seams.length} expirations.`);

  const { contracts, unsolved, thinlyQuoted, inTheMoney } = quoted(snapshots, spot);
  if (contracts.length === 0) {
    throw new Error(`Alpaca solved a volatility for none of the ${snapshots.length} contracts in the band. There is nothing to plot.`);
  }

  const expirations = new Set(contracts.map((contract) => contract.expiration));
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify({ underlying: UNDERLYING, generatedAt: new Date().toISOString(), spot, seamAgreement: agreement, contracts }, null, 2)}\n`);

  logger.info(`Wrote ${contracts.length} contracts across ${expirations.size} expirations to ${OUTPUT}.`);
  logger.info(`Left out ${unsolved} Alpaca returned no volatility for, ${thinlyQuoted} bid under ${MINIMUM_BID.toFixed(2)}, and ${inTheMoney} on the in-the-money side of spot.`);
}

main().catch((err: unknown) => {
  logger.error('Could not write the option chain.', err);
  process.exitCode = 1;
});
