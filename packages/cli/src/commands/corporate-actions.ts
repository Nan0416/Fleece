import { loadCorporateActionsConfig, runCorporateActions } from '@fleece/corporate-actions';
import { Command } from 'commander';
import { parseIsoDate } from '../args';

export function buildCorporateActionsCommand(): Command {
  const command = new Command('corporate-actions').description('record the dividends each account is owed');

  command
    .command('run')
    .description('process corporate actions for one day and exit')
    .option('--date <YYYY-MM-DD>', 'Eastern calendar date to process (default: today)', parseIsoDate)
    .action(async (options: { date?: string }) => {
      const result = await runCorporateActions(loadCorporateActionsConfig(), { referenceDate: options.date });
      console.log(`Processed ${result.symbolsProcessed} account/symbol pair(s) across ${result.accountsProcessed} account(s); recorded ${result.dividendsRecorded} dividend(s).`);
    });

  return command;
}
