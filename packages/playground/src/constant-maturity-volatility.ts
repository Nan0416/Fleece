/**
 * Runs the 30-minute constant-maturity implied volatility sampler over a stretch of history
 * and prints each chunk. Nothing is persisted.
 *
 *   npm run constant-maturity-volatility -w @fleece/playground
 */
import { easternClock, LoggerFactory } from '@fleece/utilities';

import { BacktestMarketDataImpl } from './backtest/marketdata';
import { BacktestTime } from './backtest/time';
import { marketDataClient, optionsAvailabilitiesHelper } from './client';
import { ConstantMaturityVolatilitySampler, type ConstantMaturityVolatilityPoint, type ExpirationVolatility } from './utils/constant-maturity-volatility';

const logger = LoggerFactory.getLogger('ConstantMaturityVolatilityRunner');

const RUN_FROM = '2025-01-01';
const RUN_TO = '2026-08-31';
const SYMBOL = 'AAPL';
const DIVIDEND_YIELD = 0.0;
/** Close to VIX's, which reads 30 days from expirations more than 23 and fewer than 37 days out. */
const DAYS_TO_EXPIRATION = { target: 30, min: 23, max: 37 };
/** Steps of 30 s, which is what lands the sampler 90 s after each chunk ends. */
const STEP = 30_000;

function describe(expiration: ExpirationVolatility | undefined): string {
  return expiration === undefined ? '-' : `${expiration.expiration} ${(expiration.tYears * 365).toFixed(1)}d ${(expiration.iv * 100).toFixed(1)}%`;
}

function line(point: ConstantMaturityVolatilityPoint): string {
  const iv = point.iv === undefined ? '-' : `${(point.iv * 100).toFixed(1)}%`;
  return `${point.date} ${point.time}, iv ${iv} (near ${describe(point.near)}, next ${describe(point.next)})`;
}

async function main(): Promise<void> {
  const client = marketDataClient();
  const availabilities = optionsAvailabilitiesHelper(client);
  const marketData = new BacktestMarketDataImpl(client, availabilities);
  const sampler = new ConstantMaturityVolatilitySampler({ symbol: SYMBOL, dividendYield: DIVIDEND_YIELD, data: marketData, availabilities, daysToExpiration: DAYS_TO_EXPIRATION });

  // Market data first, so the sampler reads it on the instant the clock has just reached.
  const time = new BacktestTime(easternClock.timestamp(RUN_FROM), easternClock.timestamp(RUN_TO, '23:59:59'), STEP).subscribe(marketData).subscribe(sampler);
  await time.init();
  while (await time.forward()) {
    // Each step is the sampler measuring; the points are printed once the range is done.
  }

  for (const point of sampler.getIvs()) {
    logger.info(line(point));
  }
}

main().catch((error: unknown) => {
  logger.error(`${String(error)}`);
  process.exitCode = 1;
});
