import { InjectorRuntime, loadInjectorConfig } from '@fleece/injector';
import { LoggerFactory } from '@fleece/shared';
import { Command } from 'commander';

const logger = LoggerFactory.getLogger('Cli');

export function buildInjectorCommand(): Command {
  const command = new Command('injector').description('the process that turns broker order events into ledger entries');

  command
    .command('start')
    .description('connect to the configured Alpaca accounts and record their fills')
    .option('--migrate', 'apply pending database migrations on startup')
    .action(async (options: { migrate?: boolean }) => {
      const runtime = await InjectorRuntime.start(loadInjectorConfig(), { runMigrations: options.migrate === true });

      // Draining on the way out is the point of handling these at all: an event
      // already accepted but not yet written is a fill nothing will report again.
      const shutdown = (signal: string): void => {
        logger.info(`Received ${signal}; draining queued events before exit.`);
        void runtime.stop().then(() => process.exit(0));
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
    });

  return command;
}
