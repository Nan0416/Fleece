import { LoggerFactory } from '@fleece/shared';
import { FleeceServer } from './server';
import { loadServiceConfig } from './stage-config';

const logger = LoggerFactory.getLogger('Main');

/**
 * The API process.
 *
 * Everything is configured from the environment — see `stage-config.ts` for the
 * settings and their defaults — so this takes no arguments and parses nothing. Node 22
 * runs TypeScript directly, so `node packages/service/src/main.ts` works without a
 * build; `npm start` runs the compiled copy.
 *
 * Migrations are applied here rather than by a separate command, because a service that
 * starts against a schema it does not understand is worse than one that will not start.
 */
async function main(): Promise<void> {
  const server = await FleeceServer.start(loadServiceConfig(), { runMigrations: true });

  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}.`);
    void server.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main().catch((err: unknown) => {
  logger.error('The API could not start.', err);
  process.exit(1);
});
