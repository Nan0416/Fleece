/**
 * Exercises the research helpers end to end on one past session, and prints what each
 * one found. Run it to check the helpers still work, or as a worked example of the
 * order they compose in.
 *
 *   npm run option-research -w @fleece/playground
 *
 * Keys come from the repo-root `.env`. The first run fetches; every run after it reads
 * the cache under `packages/playground/data/research/`.
 */
import { LoggerFactory, easternClock } from '@fleece/utilities';

import { findGreek, findPrice, loadContracts, loadTradingMinuteBars } from './research';

const logger = LoggerFactory.getLogger('OptionResearch');

const SESSION = '2025-03-03';
const UNDERLYING = 'SPY';
const DAYS_TO_EXPIRY = 40;
/** How far past 40 days out to keep looking for an expiration that actually traded. */
const EXPIRATION_WINDOW_DAYS = 16;
/** Roughly the three-month bill over that session. */
const RISK_FREE_RATE = 0.043;
/** SPY's trailing yield, near enough for a worked example. */
const DIVIDEND_YIELD = 0.012;
const AT = '10:00:00';

async function main(): Promise<void> {
  const contracts = await loadContracts(SESSION, UNDERLYING, 'call', DAYS_TO_EXPIRY, EXPIRATION_WINDOW_DAYS);
  if (contracts.length === 0) {
    throw new Error(`No ${UNDERLYING} calls traded on ${SESSION} expiring ${DAYS_TO_EXPIRY} to ${DAYS_TO_EXPIRY + EXPIRATION_WINDOW_DAYS} days out.`);
  }
  const expiration = contracts[0].expiration;
  logger.info(`${contracts.length} ${UNDERLYING} calls traded on ${SESSION} expiring ${expiration}, strikes ${contracts[0].strike} to ${contracts[contracts.length - 1].strike}.`);

  const minutes = await loadTradingMinuteBars(SESSION, UNDERLYING, contracts);
  const printed = minutes.reduce((most, minute) => Math.max(most, minute.optionPrices.size), 0);
  logger.info(`${minutes.length} minutes on ${SESSION}, holding up to ${printed} of those contracts at once.`);

  const at = easternClock.timestamp(SESSION, AT);
  const minute = findPrice(at, minutes);
  if (minute === undefined) {
    throw new Error(`Nothing printed at or before ${SESSION} ${AT}.`);
  }
  logger.info(`At ${easternClock.time(minute.timestamp)}, ${UNDERLYING} is ${minute.stockSpotPrice?.toFixed(2)} with ${minute.optionPrices.size} contracts quoted.`);

  const risks = findGreek(minute, RISK_FREE_RATE, DIVIDEND_YIELD);
  logger.info(`Solved an implied volatility for ${risks.size} of them. Nearest the money:`);

  const spot = minute.stockSpotPrice ?? 0;
  const nearest = [...risks.entries()].sort(([left], [right]) => Math.abs(strikeOf(left, minute) - spot) - Math.abs(strikeOf(right, minute) - spot)).slice(0, 8);
  for (const [symbol, risk] of nearest) {
    const carried = minute.optionPrices.get(symbol)?.at !== minute.timestamp;
    logger.info(
      `  ${symbol}  strike ${String(strikeOf(symbol, minute)).padStart(6)}  px ${risk.price.toFixed(2).padStart(7)}  iv ${(risk.impliedVolatility * 100).toFixed(1).padStart(5)}%` +
        `  delta ${risk.delta.toFixed(3).padStart(6)}  gamma ${risk.gamma.toFixed(4)}  theta ${risk.thetaPerDay.toFixed(3)}  vega ${risk.vegaPerPoint.toFixed(3)}${carried ? '  (carried)' : ''}`,
    );
  }
}

function strikeOf(symbol: string, minute: { readonly optionPrices: ReadonlyMap<string, { readonly occSymbol: { readonly strike: number } }> }): number {
  return minute.optionPrices.get(symbol)?.occSymbol.strike ?? 0;
}

main().catch((error: unknown) => {
  logger.error(`${String(error)}`);
  process.exitCode = 1;
});
