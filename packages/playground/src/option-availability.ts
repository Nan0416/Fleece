/**
 * Two tasks over the option availability cache a backtest reads; `TASK` below picks one.
 *
 * - `load` sweeps each watchlist symbol's option chain for when every contract first
 *   printed, and writes it to the cache. Slow and rerunnable: the first sweep of a busy
 *   underlying is hundreds of requests, and every one after it re-asks only for
 *   contracts whose answer can still change.
 * - `read` prints the contracts the cache says were tradable at one instant.
 *
 *   npm run option-availability -w @fleece/playground
 */
import { WATCHLIST } from '@fleece/marketdata';
import { easternClock, LoggerFactory } from '@fleece/utilities';

import { marketDataClient, optionsAvailabilitiesHelper } from './research';

const logger = LoggerFactory.getLogger('OptionAvailability');

async function load(): Promise<void> {
  const client = marketDataClient();
  const helper = optionsAvailabilitiesHelper(client);

  for (const entry of WATCHLIST) {
    const started = Date.now();
    await helper.save(entry.symbol);
    logger.info(`${entry.symbol} took ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  }
}

async function read(): Promise<void> {
  const client = marketDataClient();
  const helper = optionsAvailabilitiesHelper(client);
  const symbols = await helper.availableOptions('AAPL', easternClock.timestamp('2025-01-23'));
  console.log(symbols.map((s) => s.symbol).join('\n'));
}

// Every task is referenced here, so the one not picked still compiles under `noUnusedLocals`.
const TASKS = { load, read };
const TASK: keyof typeof TASKS = 'read';

TASKS[TASK]().catch((error: unknown) => {
  logger.error(`${String(error)}`);
  process.exitCode = 1;
});
