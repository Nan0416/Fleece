import { createPool, migrate } from '@fleece/core';
import { FleeceServer, loadServiceConfig } from '@fleece/service';
import { LoggerFactory } from '@fleece/shared';
import { Command } from 'commander';
import path from 'node:path';
import { parsePositiveInteger } from '../args';

const logger = LoggerFactory.getLogger('Cli');

function coreMigrationsDir(): string {
  return path.resolve(path.dirname(require.resolve('@fleece/core/package.json')), 'migrations');
}

export function buildServeCommand(): Command {
  return new Command('serve')
    .description('run the Fleece API over the account ledger')
    .option('--port <port>', 'port to listen on (env FLEECE_PORT)', parsePositiveInteger)
    .option('--host <host>', 'address to bind (env FLEECE_HOST)')
    .option('--no-migrate', 'skip applying pending migrations on startup')
    .action(async (options: { port?: number; host?: string; migrate: boolean }) => {
      // Overrides are folded into the config here rather than applied to a started
      // server, so there is one place that decides flag-over-environment precedence.
      const base = loadServiceConfig();
      const config = { ...base, port: options.port ?? base.port, host: options.host ?? base.host };

      const server = await FleeceServer.start(config, { runMigrations: options.migrate });

      const shutdown = (signal: string): void => {
        logger.info(`Received ${signal}.`);
        void server.stop().then(() => process.exit(0));
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
    });
}

export function buildMigrateCommand(): Command {
  return new Command('migrate').description('apply pending database migrations and exit').action(async () => {
    const config = loadServiceConfig();
    const pool = createPool({ connectionString: config.databaseUrl });
    try {
      const applied = await migrate(pool, coreMigrationsDir());
      console.log(applied.length === 0 ? 'Schema is already up to date.' : `Applied ${applied.length} migration(s): ${applied.join(', ')}`);
    } finally {
      await pool.end();
    }
  });
}
