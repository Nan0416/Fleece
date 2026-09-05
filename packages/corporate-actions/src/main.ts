import { LoggerFactory } from '@fleece/shared';
import { loadCorporateActionsConfig } from './corporate-actions-config';
import { runCorporateActions } from './corporate-actions-runtime';

const logger = LoggerFactory.getLogger('Main');

/**
 * The dividend job: one run, then exit.
 *
 * Configured from the environment; see `corporate-actions-config.ts`. Splits are not
 * applied here — applying one is not idempotent and the job cannot tell a split it has
 * already applied from one it has not, so they go through the API deliberately. See
 * `md/OPEN-ITEMS.md` item 9.
 */
async function main(): Promise<void> {
  const result = await runCorporateActions(loadCorporateActionsConfig());
  logger.info(`Recorded ${result.dividendsRecorded} dividend(s) across ${result.symbolsProcessed} symbol(s) in ${result.accountsProcessed} account(s).`);
}

void main().catch((err: unknown) => {
  logger.error('The corporate-actions run failed.', err);
  process.exit(1);
});
