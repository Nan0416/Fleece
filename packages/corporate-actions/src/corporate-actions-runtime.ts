import { createLedgerServices, createPool } from '@fleece/core';
import { PolygonClient } from '@fleece/marketdata';
import { LoggerFactory } from '@fleece/shared';
import { CorporateActionProcessor, ProcessCorporateActionsResponse } from './corporate-action-processor';
import { CorporateActionsConfig } from './corporate-actions-config';

const logger = LoggerFactory.getLogger('CorporateActionsRuntime');

export interface RunCorporateActionsOptions {
  /** Eastern calendar date to process, ISO `YYYY-MM-DD`. Defaults to today. */
  readonly referenceDate?: string;
}

/**
 * Runs the job once and closes.
 *
 * This is a job, not a service: it starts, does a day's work and exits, which is how
 * the legacy `main-corporate-action` reported itself too — `reportExit` rather than
 * `reportTermination`.
 */
export async function runCorporateActions(config: CorporateActionsConfig, options: RunCorporateActionsOptions = {}): Promise<ProcessCorporateActionsResponse> {
  const pool = createPool({ connectionString: config.databaseUrl });
  try {
    const { accountService, ledgerService, dividendService } = createLedgerServices({ pool });
    const processor = new CorporateActionProcessor({
      accountService,
      ledgerService,
      dividendService,
      marketDataClient: new PolygonClient({ apiKey: config.polygonApiKey }),
    });
    return await processor.process({ referenceDate: options.referenceDate });
  } finally {
    // Always: a job that leaves a pool open never exits, and a scheduler waiting on it
    // sees a hang rather than a failure.
    await pool.end();
    logger.debug('Database pool closed.');
  }
}
