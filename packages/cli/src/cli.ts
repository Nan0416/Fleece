import { AppError, LoggerFactory, LogLevel } from '@fleece/shared';
import { Command, InvalidArgumentError } from 'commander';
import { buildAccountCommand } from './commands/account';
import { buildCorporateActionsCommand } from './commands/corporate-actions';
import { buildInjectorCommand } from './commands/injector';
import { buildDividendCommand, buildPositionCommand, buildProfitCommand, buildTransactionCommand } from './commands/ledger';
import { buildBrokerOrderCommand, buildOrderGroupCommand } from './commands/order';
import { buildMigrateCommand, buildServeCommand } from './commands/serve';

const LOG_LEVELS: ReadonlyArray<LogLevel> = ['debug', 'info', 'warn', 'error'];

/** Commands that print a table, where service log lines would only be noise. */
const QUIET_COMMANDS = new Set(['account', 'position', 'profit', 'transaction', 'dividend', 'order-group', 'broker-order', 'migrate', 'corporate-actions']);

const EXAMPLES = `
Examples:
  fleece serve
  fleece injector start
  fleece corporate-actions run --date 2026-02-06
  fleece account create --name "Momentum" --type paper
  fleece position list MOMENTUM01
  fleece transaction list MOMENTUM01 --symbol AAPL --limit 20
  fleece broker-order orphans

Three processes, one database:
  'serve' answers questions about the ledger, 'injector start' records what the broker
  reports, and 'corporate-actions run' records dividends. They write concurrently and
  do not coordinate; the ledger locks the position being written.
`;

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('fleece')
    .description('a virtual-account ledger over your broker account')
    .version('1.0.0')
    .option('--service <url>', 'service base URL (env FLEECE_SERVICE_URL, default http://127.0.0.1:3100)')
    .option('--token <token>', 'bearer token (env FLEECE_TOKEN)')
    .option('--json', 'print raw JSON instead of a table')
    .option('--log-level <level>', 'debug, info, warn or error', (value) => {
      const match = LOG_LEVELS.find((level) => level === value);
      if (match === undefined) {
        throw new InvalidArgumentError(`must be one of: ${LOG_LEVELS.join(', ')}`);
      }
      return match;
    })
    .addHelpText('after', EXAMPLES)
    .showHelpAfterError('(run "fleece --help" to see the available commands)');

  program.hook('preAction', (thisCommand, actionCommand) => {
    const level: LogLevel | undefined = thisCommand.opts().logLevel;
    if (level !== undefined) {
      LoggerFactory.setLevel(level);
      return;
    }
    // `serve` and `injector start` are long-running processes whose logs are the
    // point, so they keep the default level.
    const root = actionCommand.parent?.name() ?? actionCommand.name();
    if (QUIET_COMMANDS.has(root)) {
      LoggerFactory.setLevel('warn');
    }
  });

  program.addCommand(buildServeCommand());
  program.addCommand(buildMigrateCommand());
  program.addCommand(buildInjectorCommand());
  program.addCommand(buildCorporateActionsCommand());
  program.addCommand(buildAccountCommand());
  program.addCommand(buildPositionCommand());
  program.addCommand(buildProfitCommand());
  program.addCommand(buildTransactionCommand());
  program.addCommand(buildDividendCommand());
  program.addCommand(buildOrderGroupCommand());
  program.addCommand(buildBrokerOrderCommand());

  return program;
}

export async function main(argv: ReadonlyArray<string> = process.argv): Promise<void> {
  await buildProgram().parseAsync([...argv]);
}

export function run(): void {
  main().catch((err: unknown) => {
    // An AppError is an expected outcome the user should read as a sentence; a stack
    // trace would bury the one line that matters.
    if (err instanceof AppError || err instanceof Error) {
      console.error(`Error: ${err.message}`);
      if (!(err instanceof AppError) && process.env['FLEECE_LOG_LEVEL'] === 'debug') {
        console.error(err.stack);
      }
    } else {
      console.error(`Error: ${String(err)}`);
    }
    process.exit(1);
  });
}
