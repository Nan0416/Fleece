/**
 * Runs the 30-minute constant-maturity implied volatility prototype over a stretch of history
 * and prints each chunk. Nothing is persisted.
 *
 *   npm run implied-volatility-v2 -w @fleece/playground
 */
import { easternClock, LoggerFactory } from '@fleece/utilities';

import { BacktestAccountImpl } from './backtest/account';
import { BacktestDriver } from './backtest/driver';
import { BacktestMarketDataImpl } from './backtest/marketdata';
import { BacktestTime } from './backtest/time';
import { TradeReport } from './backtest/trade-report';
import { marketDataClient, optionsAvailabilitiesHelper } from './client';
import { ImpliedVolatilityHistoryV2 } from './utils/implied-volatility-v2';

const logger = LoggerFactory.getLogger('ImpliedVolatilityV2Runner');

const RUN_FROM = '2025-01-01';
const RUN_TO = '2026-08-31';
const SYMBOL = 'AAPL';
const DIVIDEND_YIELD = 0.0;
/** Close to VIX's, which reads 30 days from expirations more than 23 and fewer than 37 days out. */
const DAYS_TO_EXPIRATION = { target: 30, min: 23, max: 37 };

async function main(): Promise<void> {
  const time = new BacktestTime(easternClock.timestamp(RUN_FROM), easternClock.timestamp(RUN_TO, '23:59:59'), 30_000);
  const client = marketDataClient();
  const availabilities = optionsAvailabilitiesHelper(client);
  const marketData = new BacktestMarketDataImpl(client, availabilities);
  const account = new BacktestAccountImpl(new TradeReport());

  const driver = new BacktestDriver({ time, marketData, account });
  driver.addStrategy(new ImpliedVolatilityHistoryV2({ symbol: SYMBOL, dividendYield: DIVIDEND_YIELD, availabilities, daysToExpiration: DAYS_TO_EXPIRATION }));
  await driver.run();
}

main().catch((error: unknown) => {
  logger.error(`${String(error)}`);
  process.exitCode = 1;
});
