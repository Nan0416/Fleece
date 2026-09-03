import { AccountType } from '@fleece/shared';
import { Command, InvalidArgumentError } from 'commander';
import { createClient, GlobalOptions } from '../client-factory';
import { formatTimestamp, printJson, printTable } from '../output';

const ACCOUNT_TYPES: ReadonlyArray<AccountType> = ['live', 'paper', 'mirror'];

function parseAccountType(value: string): AccountType {
  const match = ACCOUNT_TYPES.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new InvalidArgumentError(`must be one of: ${ACCOUNT_TYPES.join(', ')}`);
  }
  return match;
}

function globals(command: Command): GlobalOptions {
  return command.parent?.parent?.opts() ?? {};
}

export function buildAccountCommand(): Command {
  const command = new Command('account').description('manage the virtual accounts strategies trade under');

  command
    .command('list')
    .description('list accounts')
    .option('--status <status>', 'only active or inactive accounts')
    .action(async function (this: Command, options: { status?: 'active' | 'inactive' }) {
      const global = globals(this);
      const { accounts } = await createClient(global).listAccounts({ status: options.status });
      if (global.json === true) {
        printJson(accounts);
        return;
      }
      printTable(
        accounts,
        [
          { header: 'ACCOUNT ID', value: (account) => account.accountId },
          { header: 'NAME', value: (account) => account.name },
          { header: 'TYPE', value: (account) => account.accountType },
          { header: 'STATUS', value: (account) => account.status },
          { header: 'CREATED', value: (account) => formatTimestamp(account.createdAt) },
        ],
        'No accounts yet. Create one with "fleece account create".',
      );
    });

  command
    .command('get <accountId>')
    .description('show one account')
    .action(async function (this: Command, accountId: string) {
      const { account } = await createClient(globals(this)).getAccount({ accountId });
      printJson(account);
    });

  command
    .command('create')
    .description('create a virtual account')
    .requiredOption('--name <name>', 'display name')
    .requiredOption('--type <type>', `account type: ${ACCOUNT_TYPES.join(', ')}`, parseAccountType)
    .option('--id <accountId>', 'ten characters from 0-9 and A-Z (default: generated)')
    .action(async function (this: Command, options: { name: string; type: AccountType; id?: string }) {
      const { account } = await createClient(globals(this)).createAccount({ name: options.name, accountType: options.type, accountId: options.id });
      console.log(`Created ${account.accountType} account ${account.accountId} ("${account.name}").`);
    });

  command
    .command('rename <accountId> <name>')
    .description("change an account's display name")
    .action(async function (this: Command, accountId: string, name: string) {
      await createClient(globals(this)).updateAccountName({ accountId, name });
      console.log(`Renamed account ${accountId} to "${name}".`);
    });

  command
    .command('activate <accountId>')
    .description('mark an account active')
    .action(async function (this: Command, accountId: string) {
      await createClient(globals(this)).activateAccount({ accountId });
      console.log(`Account ${accountId} is now active.`);
    });

  command
    .command('deactivate <accountId>')
    .description('mark an account inactive')
    .action(async function (this: Command, accountId: string) {
      await createClient(globals(this)).deactivateAccount({ accountId });
      console.log(`Account ${accountId} is now inactive.`);
    });

  command
    .command('delete <accountId>')
    .description('delete an account and everything recorded against it')
    .option('--force', 'required for anything but a paper account')
    .action(async function (this: Command, accountId: string, options: { force?: boolean }) {
      await createClient(globals(this)).deleteAccount({ accountId, force: options.force });
      console.log(`Deleted account ${accountId}, along with its positions, profits, transactions, dividends and orders.`);
    });

  return command;
}
