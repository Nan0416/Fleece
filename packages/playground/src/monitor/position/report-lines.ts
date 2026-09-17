/**
 * A position monitor report as plain text, for stdout and so for the cron log.
 */
import { easternClock } from '@fleece/utilities';

import { dollars, errorMessage, percentOf, signedDollars } from './formatting';
import type { PositionMonitorReport } from './position-monitor';
import type { CreditSpreadEvaluation, StrategyEvaluation } from './strategies';

/** The header, each spread's state and signals, and what could not be checked or paired. */
export function reportLines(report: PositionMonitorReport): string[] {
  const signals = report.evaluations.reduce((count, evaluation) => count + evaluation.signals.length, 0);
  const failed = report.failures.length > 0 ? `, ${report.failures.length} failed` : '';
  const lines = [`${easternClock.datetime(report.at)} ${report.evaluations.length} spread(s), ${signals} signal(s)${failed}`];
  for (const evaluation of report.evaluations) {
    lines.push(`  ${summary(evaluation)}`);
    for (const warning of evaluation.warnings) {
      lines.push(`    warning: ${warning}`);
    }
  }
  for (const failure of report.failures) {
    lines.push(`  FAILED ${failure.strategy.describe()}: ${errorMessage(failure.error)}`);
  }
  for (const leg of report.unmatched) {
    lines.push(`  unmatched: ${leg.contract.symbol} x${leg.quantity.toString()}`);
  }
  for (const evaluation of report.evaluations) {
    for (const signal of evaluation.signals) {
      lines.push(`SIGNAL ${signal.kind} ${evaluation.strategy.describe()}: ${signal.reason}`);
    }
  }
  return lines;
}

/** One line per strategy, saying what matters for its kind. */
function summary(evaluation: StrategyEvaluation): string {
  switch (evaluation.kind) {
    case 'credit-spread':
      return creditSpreadSummary(evaluation);
  }
}

function creditSpreadSummary({ strategy, metrics }: CreditSpreadEvaluation): string {
  const { credit, unrealizedProfit, closeAtMid, closeAtNatural, maxLoss, netDelta, shortDelta, daysToExpiration } = metrics;
  const parts = [`credit ${dollars(credit)}`];
  if (unrealizedProfit !== undefined) {
    parts.push(credit.isPositive() ? `P&L ${signedDollars(unrealizedProfit)} (${percentOf(unrealizedProfit, credit)} of credit)` : `P&L ${signedDollars(unrealizedProfit)}`);
  }
  if (closeAtMid !== undefined && closeAtNatural !== undefined) {
    parts.push(`close ${dollars(closeAtMid)} mid / ${dollars(closeAtNatural)} natural`);
  }
  parts.push(`max loss ${dollars(maxLoss)}`);
  if (netDelta !== undefined) {
    parts.push(`net delta ${netDelta.toFixed(1)}`);
  }
  if (shortDelta !== undefined) {
    parts.push(`short delta ${shortDelta.toFixed(2)}`);
  }
  parts.push(`${daysToExpiration} DTE`);
  return `${strategy.describe()}: ${parts.join(', ')}`;
}
