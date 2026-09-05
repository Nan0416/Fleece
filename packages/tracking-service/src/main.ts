import { LoggerFactory } from '@fleece/shared';
import { loadTrackingConfig } from './tracking-config';
import { TrackingServiceRuntime } from './tracking-service-runtime';

const logger = LoggerFactory.getLogger('Main');

/**
 * The tracking service: broker feeds in, ledger entries out, and a port for claims about
 * whose an order is.
 *
 * Configured entirely from the environment; see `tracking-config.ts`. It holds
 * `@fleece/core` directly rather than calling the API over HTTP, which is the topology
 * the legacy ran — three processes against one database, coordinating through the row
 * locks on the write path rather than with each other.
 *
 * Migrations are left to the API, which usually starts first. Set
 * `FLEECE_TRACKING_MIGRATE=true` to apply them here instead.
 */
async function main(): Promise<void> {
  const config = loadTrackingConfig();
  const runtime = await TrackingServiceRuntime.start(config, { runMigrations: process.env['FLEECE_TRACKING_MIGRATE'] === 'true' });

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
  logger.error('The tracking service could not start.', err);
  process.exit(1);
});
