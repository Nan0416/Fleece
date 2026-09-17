/**
 * Two tasks over the option quote spread cache; `TASK` below picks one.
 *
 * - `load` captures each watchlist symbol's live chain and appends it to the cache. Run it
 *   during regular hours, at different times of day and on different days — which is what
 *   scheduling it as a mini-cloud job is for.
 * - `read` prints the quote the cache estimates for one contract.
 *
 *   npm run option-quote-spread -w @fleece/playground
 *
 * Under mini-cloud, either one reports its pid and exit to the agent, and `load` records how
 * many chains it captured in its instance's event log. Run by hand, it reports nothing.
 */
import { parseOccSymbol, WATCHLIST } from '@fleece/marketdata';
import { easternClock, LoggerFactory, runJob, type JobReporter } from '@fleece/utilities';

import { marketDataClient, optionsQuoteSpreadHelper } from './research';

const logger = LoggerFactory.getLogger('OptionQuoteSpread');

/** Exits 0 even when some symbols fail: one chain missing from a capture is not a failed capture. */
async function load(reporter: JobReporter | undefined): Promise<number> {
  const helper = optionsQuoteSpreadHelper(marketDataClient());
  const failed: string[] = [];
  for (const entry of WATCHLIST) {
    try {
      await helper.save(entry.symbol);
    } catch (error: unknown) {
      logger.error(`Could not capture ${entry.symbol}: ${String(error)}`);
      failed.push(entry.symbol);
    }
  }
  const message = `Captured ${WATCHLIST.length - failed.length} of ${WATCHLIST.length} chains.`;
  // Symbols only: the reasons are in the log, and a watchlist's worth of them could outgrow a report.
  await reporter?.log(failed.length === 0 ? 'success' : 'warning', failed.length === 0 ? { message } : { message, failed });
  return 0;
}

async function read(): Promise<number> {
  const helper = optionsQuoteSpreadHelper(marketDataClient());
  const contract = parseOccSymbol('DELL261023P00500000');
  if (contract === undefined) {
    throw new Error('Not an OCC contract symbol.');
  }
  const quote = await helper.estimateQuote({ contract, underlyingPrice: 543, referencePrice: 22.6, timestamp: easternClock.timestamp('2026-09-14', '15:12:00') });
  console.log(`${contract.symbol}: bid ${quote.bid.toFixed(3)}, ask ${quote.ask.toFixed(3)}, spread ${quote.spread.toFixed(3)}`);
  return 0;
}

// Every task is referenced here, so the one not picked still compiles under `noUnusedLocals`.
const TASKS = { load, read };
const TASK: keyof typeof TASKS = 'load'; // 'load';

void runJob(TASKS[TASK]);
