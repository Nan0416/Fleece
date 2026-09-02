import { SortDirection } from '@fleece/shared';
import { Command } from 'commander';
import { parsePositiveInteger, parsePositiveNumber, parseSortDirection, parseTimestamp } from '../args';
import { createClient, GlobalOptions } from '../client-factory';
import { formatTimestamp, printJson, printTable } from '../output';

function globals(command: Command): GlobalOptions {
  return command.parent?.parent?.opts() ?? {};
}

interface PageOptions {
  readonly from: number;
  readonly limit: number;
  readonly sort: SortDirection;
}

/** The same three paging flags on every listing that has them. */
function withPaging(command: Command): Command {
  return command
    .option('--from <when>', 'ISO timestamp or epoch millis to page from (default: now)', parseTimestamp)
    .option('--limit <n>', 'rows to return', parsePositiveInteger, 50)
    .option('--sort <direction>', 'asc or desc', parseSortDirection, 'desc');
}

function paging(options: { from?: number; limit: number; sort: SortDirection }): PageOptions {
  // Defaults to now paging backwards, which is what someone asking "what happened?"
  // almost always means.
  return { from: options.from ?? Date.now(), limit: options.limit, sort: options.sort };
}

export function buildPositionCommand(): Command {
  const command = new Command('position').description('positions, splits and transfers');

  command
    .command('list <accountId>')
    .description("list an account's positions")
    .option('--include-closed', 'include positions closed out to zero')
    .action(async function (this: Command, accountId: string, options: { includeClosed?: boolean }) {
      const global = globals(this);
      const { positions } = await createClient(global).listPositions({ accountId, includeClosed: options.includeClosed });
      if (global.json === true) {
        printJson(positions);
        return;
      }
      printTable(
        positions,
        [
          { header: 'SYMBOL', value: (position) => position.symbol },
          { header: 'SIZE', value: (position) => String(position.size) },
          { header: 'AVG COST', value: (position) => position.avgPrice.toFixed(4) },
          { header: 'UPDATED', value: (position) => formatTimestamp(position.lastUpdatedAt) },
        ],
        `Account ${accountId} holds nothing.`,
      );
    });

  command
    .command('get <accountId> <symbol>')
    .description('show one position')
    .action(async function (this: Command, accountId: string, symbol: string) {
      const { position } = await createClient(globals(this)).getPosition({ accountId, symbol });
      printJson(position);
    });

  withPaging(command.command('history <accountId> <symbol>').description('the position at each point it changed, from the transaction log')).action(async function (
    this: Command,
    accountId: string,
    symbol: string,
    options: { from?: number; limit: number; sort: SortDirection },
  ) {
    const global = globals(this);
    const { positions } = await createClient(global).listHistoricalPositions({ accountId, symbol, ...paging(options) });
    if (global.json === true) {
      printJson(positions);
      return;
    }
    printTable(
      positions,
      [
        { header: 'WHEN', value: (position) => formatTimestamp(position.updatedAt) },
        { header: 'SIZE', value: (position) => String(position.size) },
      ],
      `No history for ${symbol} in account ${accountId}.`,
    );
  });

  command
    .command('split <accountId> <symbol> <ratio>')
    .description('apply a stock split; 2 means one share becomes two')
    .action(async function (this: Command, accountId: string, symbol: string, ratio: string) {
      const parsed = parsePositiveNumber(ratio);
      await createClient(globals(this)).stockSplit({ accountId, symbol, ratio: parsed });
      // Worth saying out loud: nothing stops this being run twice.
      console.log(`Applied a ${parsed}-for-1 split to ${symbol} in account ${accountId}. This is not idempotent — running it again splits again.`);
    });

  command
    .command('transfer')
    .description('move shares between two virtual accounts at a stated price')
    .requiredOption('--from-account <accountId>', 'account the shares leave')
    .requiredOption('--from-group <groupId>', 'order group on the sending side')
    .requiredOption('--to-account <accountId>', 'account the shares arrive in')
    .requiredOption('--to-group <groupId>', 'order group on the receiving side')
    .requiredOption('--symbol <symbol>', 'symbol to move')
    .requiredOption('--shares <n>', 'whole shares to move', parsePositiveInteger)
    .requiredOption('--price <price>', 'price the transfer is booked at', parsePositiveNumber)
    .option('--at <when>', 'ISO timestamp or epoch millis (default: now)', parseTimestamp)
    .action(async function (
      this: Command,
      options: { fromAccount: string; fromGroup: string; toAccount: string; toGroup: string; symbol: string; shares: number; price: number; at?: number },
    ) {
      await createClient(globals(this)).transferPosition({
        originAccountId: options.fromAccount,
        originGroupId: options.fromGroup,
        destinationAccountId: options.toAccount,
        destinationGroupId: options.toGroup,
        symbol: options.symbol,
        shares: options.shares,
        unitCost: options.price,
        timestamp: options.at,
      });
      console.log(`Moved ${options.shares} ${options.symbol} from ${options.fromAccount} to ${options.toAccount} at ${options.price}.`);
    });

  return command;
}

export function buildProfitCommand(): Command {
  const command = new Command('profit').description('realised profit');

  command
    .command('list <accountId>')
    .description('realised profit per symbol')
    .action(async function (this: Command, accountId: string) {
      const global = globals(this);
      const { profits } = await createClient(global).listProfits({ accountId });
      if (global.json === true) {
        printJson(profits);
        return;
      }
      printTable(
        profits,
        [
          { header: 'SYMBOL', value: (profit) => profit.symbol },
          { header: 'PROFIT', value: (profit) => profit.profit.toFixed(4) },
          { header: 'UPDATED', value: (profit) => formatTimestamp(profit.lastUpdatedAt) },
        ],
        `Account ${accountId} has not realised any profit yet.`,
      );
    });

  return command;
}

export function buildTransactionCommand(): Command {
  const command = new Command('transaction').description('the trade log');

  withPaging(command.command('list <accountId>').description("list an account's transactions").option('--symbol <symbol>', 'restrict to one symbol')).action(async function (
    this: Command,
    accountId: string,
    options: { symbol?: string; from?: number; limit: number; sort: SortDirection },
  ) {
    const global = globals(this);
    const { transactions } = await createClient(global).listTransactions({ accountId, symbol: options.symbol, ...paging(options) });
    if (global.json === true) {
      printJson(transactions);
      return;
    }
    printTable(
      transactions,
      [
        { header: 'WHEN', value: (transaction) => formatTimestamp(transaction.timestamp) },
        { header: 'SYMBOL', value: (transaction) => transaction.symbol },
        { header: 'SIZE', value: (transaction) => String(transaction.size) },
        { header: 'PRICE', value: (transaction) => transaction.avgPrice.toFixed(4) },
        { header: 'PROFIT', value: (transaction) => (transaction.profit === undefined ? '-' : transaction.profit.toFixed(4)) },
        { header: 'POSITION', value: (transaction) => String(transaction.cumulativeSize) },
      ],
      `No transactions for account ${accountId} in that window.`,
    );
  });

  command
    .command('for-order <brokerOrderId>')
    .description('every transaction one broker order produced')
    .action(async function (this: Command, brokerOrderId: string) {
      const { transactions } = await createClient(globals(this)).listTransactionsByReferenceId({ referenceId: brokerOrderId });
      printJson(transactions);
    });

  return command;
}

export function buildDividendCommand(): Command {
  const command = new Command('dividend').description('dividends each account is owed');

  command
    .command('list <accountId>')
    .description('list dividends')
    .option('--symbol <symbol>', 'restrict to one symbol')
    .action(async function (this: Command, accountId: string, options: { symbol?: string }) {
      const global = globals(this);
      const { dividends } = await createClient(global).listDividends({ accountId, symbol: options.symbol });
      if (global.json === true) {
        printJson(dividends);
        return;
      }
      printTable(
        dividends,
        [
          { header: 'SYMBOL', value: (dividend) => dividend.symbol },
          { header: 'EX-DATE', value: (dividend) => dividend.exDividendDate },
          { header: 'PAY DATE', value: (dividend) => dividend.payDate },
          { header: 'SHARES', value: (dividend) => String(dividend.size) },
          { header: 'PER SHARE', value: (dividend) => dividend.amountPerShare.toFixed(4) },
          { header: 'TOTAL', value: (dividend) => (dividend.size * dividend.amountPerShare).toFixed(2) },
          { header: 'STATUS', value: (dividend) => dividend.status },
        ],
        `No dividends recorded for account ${accountId}.`,
      );
    });

  return command;
}
