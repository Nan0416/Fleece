/**
 * Checks the live account's credit spreads against their closing rules, and posts what it
 * finds to Discord.
 *
 *   npm run position-monitor -w @fleece/playground
 *
 * Meant to run as a mini-cloud job every five minutes in market hours. It reads positions and
 * quotes and places nothing: a signal is for a person to act on. Outside market hours the
 * quotes are the close's and Alpaca's greeks drift from them, so a run then reports a stale
 * mark and delta.
 *
 * Every run posts a card per spread to the monitor channel, which is meant to be muted, and
 * prints the report to stdout. A run with a signal or a failure also posts a card for each
 * to the attention channel, which is meant to notify — on every run the condition holds, not
 * only the first. A run that fails, or cannot post, exits non-zero.
 *
 * Under mini-cloud, its pid and exit are reported to the agent. Run by hand, it reports nothing.
 */
import { Decimal, runJob } from '@fleece/utilities';

import { alpacaTradingClient, marketDataClient } from '../../client';
import { creditSpreadAttentionWebhookUrl, creditSpreadMonitorWebhookUrl } from '../../credentials';
import { DiscordNotifier } from './notifier';
import { PositionMonitor } from './position-monitor';
import type { CreditSpreadRules } from './strategies';
import { BearCallSpreadDetector, BullPutSpreadDetector, ChainedStrategyDetector } from './strategy-detectors';

/** Real money: the account whose spreads are watched. Nothing here trades in it. */
const LIVE = true;

const RULES: CreditSpreadRules = {
  takeProfitFraction: Decimal.of('0.5'),
  stopLossMultiple: Decimal.of(2),
  closeAtDaysToExpiration: 21,
};

async function main(): Promise<number> {
  const notifier = new DiscordNotifier({
    monitorWebhookUrl: creditSpreadMonitorWebhookUrl(),
    attentionWebhookUrl: creditSpreadAttentionWebhookUrl(),
  });
  try {
    const marketData = marketDataClient();
    const detector = new ChainedStrategyDetector([new BearCallSpreadDetector(marketData, RULES), new BullPutSpreadDetector(marketData, RULES)]);
    const outcome = await new PositionMonitor(alpacaTradingClient(LIVE), detector, notifier).run();
    // A run that could not check every spread did not do its job, whatever it posted.
    return outcome.kind === 'failed' || outcome.report.failures.length > 0 ? 1 : 0;
  } finally {
    notifier.close();
  }
}

void runJob(main);
