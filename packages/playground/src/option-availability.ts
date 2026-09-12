/**
 * Sweeps an underlying's option chain for when each contract first printed, and writes it
 * to the availability cache a backtest reads.
 *
 *   npm run option-availability -w @fleece/playground
 *
 * Slow and rerunnable: the first sweep of a busy underlying is hundreds of requests, and
 * every one after it re-asks only for contracts whose answer can still change.
 */
import { LoggerFactory } from '@fleece/utilities';

import { getCachePath } from './credentials';
import { marketDataClient } from './research';
import { OptionsAvailabilitiesHelperImpl } from './utils/options-availabilities';

const logger = LoggerFactory.getLogger('OptionAvailability');

const UNDERLYINGS = ['AMZN'];

async function main(): Promise<void> {
  const helper = new OptionsAvailabilitiesHelperImpl(getCachePath(), marketDataClient());

  for (const underlying of UNDERLYINGS) {
    const started = Date.now();
    await helper.save(underlying);
    logger.info(`${underlying} took ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  }
}

main().catch((error: unknown) => {
  logger.error(`${String(error)}`);
  process.exitCode = 1;
});
