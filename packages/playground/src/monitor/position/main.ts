/**
 * Checks the live account's credit spreads against their closing rules, and prints a signal
 * for each rule that says to act.
 *
 *   npm run position-monitor -w @fleece/playground
 *
 * Meant to run from cron every five minutes in market hours. It reads positions and quotes
 * and places nothing: a signal is for a person to act on. Outside market hours the quotes
 * are the close's and Alpaca's greeks drift from them, so a run then reports a stale mark
 * and delta.
 *
 * The report goes to stdout, one `SIGNAL` line per signal. A failed run logs the error and
 * exits non-zero.
 */
import { Decimal, easternClock, LoggerFactory } from '@fleece/utilities';

import { alpacaTradingClient, marketDataClient } from '../../client';
import { PositionMonitor, type PositionMonitorReport } from './position-monitor';
import type { CreditSpreadRules } from './strategies';
import { BearCallSpreadDetector, BullPutSpreadDetector, ChainedStrategyDetector } from './strategy-detectors';

const logger = LoggerFactory.getLogger('PositionMonitor');

/** Real money: the account whose spreads are watched. Nothing here trades in it. */
const LIVE = true;

const RULES: CreditSpreadRules = {
  takeProfitFraction: Decimal.of('0.5'),
  stopLossMultiple: Decimal.of(2),
  closeAtDaysToExpiration: 21,
};

function print(report: PositionMonitorReport): void {
  const signals = report.evaluations.flatMap((evaluation) => evaluation.signals);
  const failed = report.failures.length > 0 ? `, ${report.failures.length} failed` : '';
  console.log(`${easternClock.datetime(report.at)} ${report.evaluations.length} spread(s), ${signals.length} signal(s)${failed}`);
  for (const evaluation of report.evaluations) {
    console.log(`  ${evaluation.summary}`);
    for (const warning of evaluation.warnings) {
      console.log(`    warning: ${warning}`);
    }
  }
  for (const failure of report.failures) {
    logger.error(`Could not evaluate ${failure.strategy}.`, failure.error);
  }
  for (const leg of report.unmatched) {
    console.log(`  unmatched: ${leg.contract.symbol} x${leg.quantity.toString()}`);
  }
  for (const signal of signals) {
    console.log(`SIGNAL ${signal.kind} ${signal.strategy}: ${signal.message}`);
  }
}

async function main(): Promise<void> {
  const marketData = marketDataClient();
  const detector = new ChainedStrategyDetector([new BearCallSpreadDetector(marketData, RULES), new BullPutSpreadDetector(marketData, RULES)]);
  const report = await new PositionMonitor(alpacaTradingClient(LIVE), detector).run();
  print(report);
  // A run that could not check every spread did not do its job, whatever it printed.
  if (report.failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  logger.error('The position monitor run failed.', err);
  process.exitCode = 1;
});
