/**
 * Two tasks over the option quote spread cache; `TASK` below picks one.
 *
 * - `load` captures each watchlist symbol's live chain and appends it to the cache. Run it
 *   during regular hours, at different times of day and on different days.
 * - `read` prints the quote the cache estimates for one contract.
 *
 *   npm run option-quote-spread -w @fleece/playground
 */
import { parseOccSymbol, WATCHLIST } from '@fleece/marketdata';
import { easternClock, LoggerFactory } from '@fleece/utilities';

import { marketDataClient, optionsQuoteSpreadHelper } from './research';

const logger = LoggerFactory.getLogger('OptionQuoteSpread');

async function load(): Promise<void> {
  const helper = optionsQuoteSpreadHelper(marketDataClient());
  for (const entry of WATCHLIST) {
    try {
      await helper.save(entry.symbol);
    } catch (error: unknown) {
      logger.error(`Could not capture ${entry.symbol}: ${String(error)}`);
    }
  }
}

async function read(): Promise<void> {
  const helper = optionsQuoteSpreadHelper(marketDataClient());
  const contract = parseOccSymbol('DELL261023P00500000');
  if (contract === undefined) {
    throw new Error('Not an OCC contract symbol.');
  }
  const quote = await helper.estimateQuote({ contract, underlyingPrice: 543, referencePrice: 22.6, timestamp: easternClock.timestamp('2026-09-14', '15:12:00') });
  console.log(`${contract.symbol}: bid ${quote.bid.toFixed(3)}, ask ${quote.ask.toFixed(3)}, spread ${quote.spread.toFixed(3)}`);
}

// Every task is referenced here, so the one not picked still compiles under `noUnusedLocals`.
const TASKS = { load, read };
const TASK: keyof typeof TASKS = 'load'; // 'load';

TASKS[TASK]().catch((error: unknown) => {
  logger.error(`${String(error)}`);
  process.exitCode = 1;
});
