import { Account, BrokerOrder, OrderGroup } from '@fleece/shared';
import { AccountDao, CreateAccountInput, ListAccountsInput } from '../../src/data/account-dao';
import { ListOrderGroupsInput, OrderGroupDao } from '../../src/data/order-group-dao';

/** Fakes that store what they are given, implementing the rules a caller depends on. */

export class FakeAccountDao implements AccountDao {
  readonly accounts = new Map<string, Account>();

  seed(accountId: string, overrides: Partial<Account> = {}): Account {
    const account: Account = { accountId, name: accountId, status: 'active', accountType: 'paper', createdAt: 1, lastUpdatedAt: 1, ...overrides };
    this.accounts.set(accountId, account);
    return account;
  }

  async createAccount(input: CreateAccountInput): Promise<{ account: Account }> {
    const account: Account = { ...input, createdAt: 1, lastUpdatedAt: 1 };
    this.accounts.set(input.accountId, account);
    return { account };
  }

  async getAccount(input: { accountId: string }): Promise<{ account: Account | null }> {
    return { account: this.accounts.get(input.accountId) ?? null };
  }

  async listAccounts(input: ListAccountsInput): Promise<{ accounts: ReadonlyArray<Account> }> {
    const all = [...this.accounts.values()];
    return { accounts: input.status === undefined ? all : all.filter((account) => account.status === input.status) };
  }

  async setStatus(input: { accountId: string; status: 'active' | 'inactive' }): Promise<{ account: Account | null }> {
    const existing = this.accounts.get(input.accountId);
    if (existing === undefined) {
      return { account: null };
    }
    const updated = { ...existing, status: input.status };
    this.accounts.set(input.accountId, updated);
    return { account: updated };
  }

  async setName(input: { accountId: string; name: string }): Promise<{ account: Account | null }> {
    const existing = this.accounts.get(input.accountId);
    if (existing === undefined) {
      return { account: null };
    }
    const updated = { ...existing, name: input.name };
    this.accounts.set(input.accountId, updated);
    return { account: updated };
  }

  async deleteAccount(input: { accountId: string }): Promise<{ deleted: boolean }> {
    return { deleted: this.accounts.delete(input.accountId) };
  }
}

export class FakeOrderGroupDao implements OrderGroupDao {
  readonly groups = new Map<string, OrderGroup>();
  readonly listCalls: ListOrderGroupsInput[] = [];

  seed(groupId: string, overrides: Partial<OrderGroup> = {}): OrderGroup {
    const group: OrderGroup = {
      groupId,
      correlationId: `corr-${groupId}`,
      correlationType: 'test',
      status: 'open',
      accountId: 'ACCOUNT001',
      brokerOrders: [] as ReadonlyArray<BrokerOrder>,
      createdAt: 1,
      lastUpdatedAt: 1,
      ...overrides,
    };
    this.groups.set(groupId, group);
    return group;
  }

  async createOrderGroup(input: {
    groupId: string;
    correlationId: string;
    correlationType: string;
    status: 'open' | 'closed';
    accountId: string;
  }): Promise<{ orderGroup: OrderGroup }> {
    return { orderGroup: this.seed(input.groupId, input) };
  }

  async getOrderGroup(input: { groupId: string }): Promise<{ orderGroup: OrderGroup | null }> {
    return { orderGroup: this.groups.get(input.groupId) ?? null };
  }

  async listOrderGroups(input: ListOrderGroupsInput): Promise<{ orderGroups: ReadonlyArray<OrderGroup> }> {
    this.listCalls.push(input);
    return { orderGroups: [...this.groups.values()] };
  }

  async setStatus(input: { groupId: string; status: 'open' | 'closed' }): Promise<{ orderGroup: OrderGroup | null }> {
    const existing = this.groups.get(input.groupId);
    if (existing === undefined) {
      return { orderGroup: null };
    }
    const updated = { ...existing, status: input.status };
    this.groups.set(input.groupId, updated);
    return { orderGroup: updated };
  }

  async setDocuments(input: {
    groupId: string;
    documents: ReadonlyArray<OrderGroup['documents']> extends never ? never : Parameters<OrderGroupDao['setDocuments']>[0]['documents'];
  }): Promise<{ orderGroup: OrderGroup | null }> {
    const existing = this.groups.get(input.groupId);
    if (existing === undefined) {
      return { orderGroup: null };
    }
    const updated = { ...existing, documents: input.documents };
    this.groups.set(input.groupId, updated);
    return { orderGroup: updated };
  }

  async deleteOrderGroup(input: { groupId: string }): Promise<{ deleted: boolean }> {
    return { deleted: this.groups.delete(input.groupId) };
  }
}
