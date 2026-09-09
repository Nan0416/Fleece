/**
 * Writes AAPL's near-dated call chain — one record per contract, carrying the strike, the
 * expiration and the greeks — to `viz/data/option-delta-surface.json`, which
 * `viz/option_delta_surface.py` plots as a 3D delta surface.
 *
 *   npm run option-delta-surface -w @fleece/playground
 *   uv run --project viz viz/option_delta_surface.py
 *
 * Keys come from the repo-root `.env` rather than `credentials.ts`, unlike the other
 * scripts here. These are market-data keys rather than broker keys, and the live suites
 * already read them from there under the same two names.
 *
 * What it writes is tidy — one record per contract — and deliberately not a grid.
 * Expirations do not share a strike set: a weekly lists far fewer strikes than the
 * monthly beside it, and a grid built here would have to invent the ones that are
 * missing. The plot triangulates the scattered points instead, which is a decision the
 * plot is entitled to make and this script is not.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { AlpacaMarketDataClient, type OptionChainRequest, type OptionSnapshot, type OptionType } from '@fleece/marketdata';
import { LoggerFactory, easternClock } from '@fleece/utilities';
import { config as loadEnv } from 'dotenv';

const logger = LoggerFactory.getLogger('OptionDeltaSurface');

const UNDERLYING = 'AAPL';
const TYPE: OptionType = 'call';

/**
 * How far out to reach. AAPL lists LEAPS two years out and its whole chain runs to about
 * 3,100 contracts — a surface over all of it is a wall of near-1 delta with the
 * interesting part crushed into the first inch of the axis.
 */
const EXPIRATION_WINDOW_DAYS = 120;

/** Strikes within this fraction of spot. The deep wings are flat 0 and flat 1. */
const STRIKE_BAND = 0.3;

/** Alpaca's page maximum for a chain. Four of these would cover the whole of AAPL. */
const PAGE_SIZE = 1_000;

/** `dist/` at runtime, so three levels up is the repo root. */
const ROOT = resolve(__dirname, '../../..');
const OUTPUT = resolve(ROOT, 'viz/data/option-delta-surface.json');

/**
 * One contract, flat. `iv` is null rather than absent when Alpaca priced the greeks but
 * not the volatility, so every record carries the same keys and the reader never has to
 * ask whether a missing field means missing or means zero.
 */
interface ContractRecord {
  readonly symbol: string;
  readonly expiration: string;
  readonly strike: number;
  readonly type: OptionType;
  readonly delta: number;
  readonly gamma: number;
  readonly theta: number;
  readonly vega: number;
  readonly rho: number;
  readonly iv: number | null;
}

/**
 * The last close, as the centre of the strike band.
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

/**
 * Contracts Alpaca priced, oldest expiration first and by strike within it.
 *
 * The greeks come back undefined for a contract it could not price — no quote, usually,
 * on a strike nobody is trading — and those are dropped rather than zeroed, because a
 * zero delta is a real value that a far out-of-the-money call genuinely has.
 */
function priced(snapshots: ReadonlyArray<OptionSnapshot>): ReadonlyArray<ContractRecord> {
  const records: ContractRecord[] = [];

  for (const snapshot of snapshots) {
    const { greeks, contract } = snapshot;
    if (greeks === undefined) {
      continue;
    }
    records.push({
      symbol: snapshot.S,
      expiration: contract.expiration,
      strike: contract.strike,
      type: contract.type,
      delta: greeks.delta,
      gamma: greeks.gamma,
      theta: greeks.theta,
      vega: greeks.vega,
      rho: greeks.rho,
      iv: snapshot.iv ?? null,
    });
  }

  return records.sort((a, b) => (a.expiration === b.expiration ? a.strike - b.strike : a.expiration.localeCompare(b.expiration)));
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

  logger.info(`${UNDERLYING} last closed at ${spot.toFixed(2)}. Fetching ${TYPE}s expiring ${today} to ${expirationTo}, within ${STRIKE_BAND * 100}% of that.`);

  const snapshots = await wholeChain(client, {
    underlying: UNDERLYING,
    type: TYPE,
    expirationFrom: today,
    expirationTo,
    strikeFrom: Math.round(spot * (1 - STRIKE_BAND)),
    strikeTo: Math.round(spot * (1 + STRIKE_BAND)),
  });

  const contracts = priced(snapshots);
  const expirations = new Set(contracts.map((contract) => contract.expiration));
  const unpriced = snapshots.length - contracts.length;

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify({ underlying: UNDERLYING, type: TYPE, generatedAt: new Date().toISOString(), spot, contracts }, null, 2)}\n`);

  logger.info(`Wrote ${contracts.length} contracts across ${expirations.size} expirations to ${OUTPUT}.`);
  if (unpriced > 0) {
    logger.info(`Left out ${unpriced} that Alpaca returned without greeks — it prices from a quote, and these had none.`);
  }
}

main().catch((err: unknown) => {
  logger.error('Could not write the option chain.', err);
  process.exitCode = 1;
});
