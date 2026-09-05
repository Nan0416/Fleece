import { LoggerFactory } from '@fleece/shared';
import { loadInjectorConfig } from './injector-config';
import { InjectorRuntime } from './injector-runtime';

const logger = LoggerFactory.getLogger('Main');

/**
 * The injector process: broker feeds in, ledger entries out.
 *
 * Configured entirely from the environment; see `injector-config.ts`. It holds
 * `@fleece/core` directly rather than calling the API over HTTP, which is the topology
 * the legacy ran — three processes against one database, coordinating through the row
 * locks on the write path rather than with each other.
 *
 * Migrations are left to the API, which usually starts first. Set
 * `FLEECE_INJECTOR_MIGRATE=true` to apply them here instead.
 */
async function main(): Promise<void> {
  const config = loadInjectorConfig();
  const runtime = await InjectorRuntime.start(config, { runMigrations: process.env['FLEECE_INJECTOR_MIGRATE'] === 'true' });

  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}.`);
    // Drained rather than dropped: an event accepted but not yet written is a fill
    // nothing will report again.
    void runtime.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main().catch((err: unknown) => {
  logger.error('The injector could not start.', err);
  process.exit(1);
});
