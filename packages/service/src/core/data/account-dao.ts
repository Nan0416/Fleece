import { Account, AccountStatus, AccountType } from '@fleece/shared';

export interface CreateAccountInput {
  readonly accountId: string;
  readonly name: string;
  readonly status: AccountStatus;
  readonly accountType: AccountType;
}

export interface CreateAccountOutput {
  readonly account: Account;
}

export interface GetAccountInput {
  readonly accountId: string;
}

export interface GetAccountOutput {
  readonly account: Account | null;
}

export interface ListAccountsInput {
  readonly status?: AccountStatus;
}

export interface ListAccountsOutput {
  readonly accounts: ReadonlyArray<Account>;
}

export interface SetAccountStatusInput {
  readonly accountId: string;
  readonly status: AccountStatus;
}

export interface SetAccountStatusOutput {
  readonly account: Account | null;
}

export interface SetAccountNameInput {
  readonly accountId: string;
  readonly name: string;
}

export interface SetAccountNameOutput {
  readonly account: Account | null;
}

export interface DeleteAccountInput {
  readonly accountId: string;
}

export interface DeleteAccountOutput {
  readonly deleted: boolean;
}

export interface AccountDao {
  createAccount(input: CreateAccountInput): Promise<CreateAccountOutput>;
  getAccount(input: GetAccountInput): Promise<GetAccountOutput>;
  listAccounts(input: ListAccountsInput): Promise<ListAccountsOutput>;
  setStatus(input: SetAccountStatusInput): Promise<SetAccountStatusOutput>;
  setName(input: SetAccountNameInput): Promise<SetAccountNameOutput>;
  /**
   * Removes the account and, by foreign key cascade, its positions, profits,
   * transactions, dividends, order groups, broker orders and broker order records.
   */
  deleteAccount(input: DeleteAccountInput): Promise<DeleteAccountOutput>;
}
