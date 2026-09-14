/**
 * Two tasks over the implied volatility history a backtest reads; `TASK` below picks one.
 *
 * - `load` sweeps each symbol's at-the-money option prices every half hour, from where its
 *   file ends, and writes them to the cache. The first sweep of a symbol is two requests a
 *   session back to February 2024; every one after it asks only for the sessions since.
 * - `read` prints one symbol's 11:00 volatility for its most recent sessions.
 *
 *   npm run implied-volatility-history -w @fleece/playground
 */
import { easternClock, LoggerFactory } from '@fleece/utilities';

import { impliedVolatilityHistoryHelper, marketDataClient, optionsAvailabilitiesHelper } from './client';
import { solvePoint } from './utils/implied-volatility-history';

const logger = LoggerFactory.getLogger('ImpliedVolatilityHistoryRunner');

const SYMBOLS = ['AAPL'];

async function load(): Promise<void> {
  const client = marketDataClient();
  const helper = impliedVolatilityHistoryHelper(client, optionsAvailabilitiesHelper(client));

  for (const symbol of SYMBOLS) {
    const started = Date.now();
    await helper.save(symbol);
    logger.info(`${symbol} took ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  }
}

async function read(): Promise<void> {
  const client = marketDataClient();
  const helper = impliedVolatilityHistoryHelper(client, optionsAvailabilitiesHelper(client));
  const sessions = await helper.sessions('AAPL');

  for (const session of sessions.slice(-10)) {
    const sample = session.samples.find((candidate) => candidate.time === '11:00');
    if (sample?.status !== 'measured') {
      logger.info(`${session.date} 11:00 ${sample === undefined ? 'no sample' : sample.reason}`);
      continue;
    }
    const point = solvePoint(session.date, sample, 0.043, 0.004);
    const iv = point === undefined ? 'does not solve' : `put ${(point.putIv * 100).toFixed(1)}%  call ${(point.callIv * 100).toFixed(1)}%`;
    logger.info(`${session.date} 11:00  spot ${sample.spot} at ${easternClock.time(sample.spotAt)}  ${sample.putSymbol} ${sample.putPrice} / ${sample.callPrice}  ${iv}`);
  }
}

// Every task is referenced here, so the one not picked still compiles under `noUnusedLocals`.
const TASKS = { load, read };
const TASK: keyof typeof TASKS = 'load';

TASKS[TASK]().catch((error: unknown) => {
  logger.error(`${String(error)}`);
  process.exitCode = 1;
});
