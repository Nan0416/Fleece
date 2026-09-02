import { OrderGroupStatus, SortDirection } from '@fleece/shared';
import { Command, InvalidArgumentError } from 'commander';
import { parsePositiveInteger, parseSortDirection, parseTimestamp } from '../args';
import { createClient, GlobalOptions } from '../client-factory';
import { formatTimestamp, printJson, printTable } from '../output';

function globals(command: Command): GlobalOptions {
  return command.parent?.parent?.opts() ?? {};
}

function parseGroupStatus(value: string): OrderGroupStatus {
  if (value !== 'open' && value !== 'closed') {
    throw new InvalidArgumentError('must be open or closed');
  }
  return value;
}

export function buildOrderGroupCommand(): Command {
  const command = new Command('order-group').description('the groups broker orders belong to');

  command
    .command('get <groupId>')
    .description('show one order group and its broker orders')
    .action(async function (this: Command, groupId: string) {
      const { orderGroup } = await createClient(globals(this)).getOrderGroup({ groupId });
      printJson(orderGroup);
    });

  command
    .command('create')
    .description('create an order group')
    .requiredOption('--account <accountId>', 'account the group trades for')
    .requiredOption('--type <correlationType>', 'what kind of thing this group is, e.g. TakeProfit or GridOrder')
    .option('--correlation <correlationId>', 'caller-supplied id (default: generated)')
    .action(async function (this: Command, options: { account: string; type: string; correlation?: string }) {
      const { groupId } = await createClient(globals(this)).createOrderGroup({ accountId: options.account, correlationType: options.type, correlationId: options.correlation });
      console.log(groupId);
    });

  command
    .command('list')
    .description('list order groups; exactly one search property, with a time window unless it is --correlation')
    .option('--account <accountId>', 'groups for one account')
    .option('--type <correlationType>', 'groups of one kind, e.g. TakeProfit')
    .option('--status <status>', 'open or closed', parseGroupStatus)
    .option('--correlation <correlationId>', 'groups with one correlation id (needs no window)')
    .option('--symbol <symbol>', 'narrow to groups holding an order in this symbol')
    .option('--start <when>', 'window start, ISO timestamp or epoch millis', parseTimestamp)
    .option('--end <when>', 'window end, ISO timestamp or epoch millis', parseTimestamp)
    .action(async function (
      this: Command,
      options: { account?: string; type?: string; status?: OrderGroupStatus; correlation?: string; symbol?: string; start?: number; end?: number },
    ) {
      const global = globals(this);
      const { orderGroups } = await createClient(global).listOrderGroups({
        accountId: options.account,
        correlationType: options.type,
        status: options.status,
        correlationId: options.correlation,
        symbol: options.symbol,
        startTimestamp: options.start,
        endTimestamp: options.end,
      });
      if (global.json === true) {
        printJson(orderGroups);
        return;
      }
      printTable(
        orderGroups,
        [
          { header: 'GROUP ID', value: (group) => group.groupId },
          { header: 'ACCOUNT', value: (group) => group.accountId },
          { header: 'TYPE', value: (group) => group.correlationType },
          { header: 'STATUS', value: (group) => group.status },
          { header: 'ORDERS', value: (group) => String(group.brokerOrders.length) },
          { header: 'CREATED', value: (group) => formatTimestamp(group.createdAt) },
        ],
        'No order groups matched.',
      );
    });

  command
    .command('close <groupId>')
    .description('mark an order group closed')
    .action(async function (this: Command, groupId: string) {
      await createClient(globals(this)).closeOrderGroup({ groupId });
      console.log(`Order group ${groupId} is now closed.`);
    });

  command
    .command('delete <groupId>')
    .description('delete an order group, its broker orders and their records')
    .action(async function (this: Command, groupId: string) {
      await createClient(globals(this)).deleteOrderGroup({ groupId });
      console.log(`Deleted order group ${groupId}. The transactions its orders produced are unchanged.`);
    });

  return command;
}

export function buildBrokerOrderCommand(): Command {
  const command = new Command('broker-order').description('orders as the broker reported them');

  command
    .command('get <brokerOrderId>')
    .description('show one broker order')
    .action(async function (this: Command, brokerOrderId: string) {
      const { brokerOrder } = await createClient(globals(this)).getBrokerOrder({ brokerOrderId });
      printJson(brokerOrder);
    });

  command
    .command('list')
    .description('list broker orders; at most one search property')
    .option('--account <accountId>', 'orders for one virtual account')
    .option('--broker-account <brokerAccountId>', 'orders at one broker account')
    .option('--symbol <symbol>', 'orders in one symbol')
    .option('--status <status>', 'orders in one status')
    .option('--from <when>', 'ISO timestamp or epoch millis to page from (default: now)', parseTimestamp)
    .option('--limit <n>', 'rows to return', parsePositiveInteger, 50)
    .option('--sort <direction>', 'asc or desc', parseSortDirection, 'desc')
    .action(async function (
      this: Command,
      options: { account?: string; brokerAccount?: string; symbol?: string; status?: string; from?: number; limit: number; sort: SortDirection },
    ) {
      const global = globals(this);
      const { brokerOrders } = await createClient(global).listBrokerOrders({
        accountId: options.account,
        brokerAccountId: options.brokerAccount,
        symbol: options.symbol,
        status: options.status,
        from: options.from ?? Date.now(),
        limit: options.limit,
        sort: options.sort,
      });
      if (global.json === true) {
        printJson(brokerOrders);
        return;
      }
      printTable(
        brokerOrders,
        [
          { header: 'BROKER ORDER ID', value: (order) => order.brokerOrderId },
          { header: 'SYMBOL', value: (order) => order.symbol },
          { header: 'ACCOUNT', value: (order) => order.accountId },
          { header: 'BROKER', value: (order) => order.broker },
          { header: 'STATUS', value: (order) => order.status },
          { header: 'GROUP', value: (order) => order.groupId ?? '(orphan)' },
          { header: 'CREATED', value: (order) => formatTimestamp(order.createdAt) },
        ],
        'No broker orders matched.',
      );
    });

  command
    .command('orphans')
    .description('orders with no group: placed outside the system, or never claimed')
    .action(async function (this: Command) {
      const global = globals(this);
      const { brokerOrders } = await createClient(global).listOrphanBrokerOrders({});
      if (global.json === true) {
        printJson(brokerOrders);
        return;
      }
      printTable(
        brokerOrders,
        [
          { header: 'BROKER ORDER ID', value: (order) => order.brokerOrderId },
          { header: 'SYMBOL', value: (order) => order.symbol },
          { header: 'ACCOUNT', value: (order) => order.accountId },
          { header: 'STATUS', value: (order) => order.status },
          { header: 'CREATED', value: (order) => formatTimestamp(order.createdAt) },
        ],
        'No orphan orders — every order the ledger knows about belongs to a group.',
      );
    });

  command
    .command('records <brokerOrderId>')
    .description('the raw broker events for one order')
    .action(async function (this: Command, brokerOrderId: string) {
      const { records } = await createClient(globals(this)).listBrokerOrderRecords({ brokerOrderId });
      printJson(records);
    });

  return command;
}
