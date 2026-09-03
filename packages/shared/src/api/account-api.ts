import { Account, AccountStatus, AccountType } from '../models/account';

export interface CreateAccountRequest {
  /** Omit to have one generated. */
  readonly accountId?: string;
  readonly name: string;
  readonly accountType: AccountType;
}

export interface CreateAccountResponse {
  readonly account: Account;
}

export interface GetAccountRequest {
  readonly accountId: string;
}

export interface GetAccountResponse {
  readonly account: Account;
}

export interface ListAccountsRequest {
  /** Omit for every account, whatever its status. */
  readonly status?: AccountStatus;
}

export interface ListAccountsResponse {
  readonly accounts: ReadonlyArray<Account>;
}

export interface UpdateAccountNameRequest {
  readonly accountId: string;
  readonly name: string;
}

export interface UpdateAccountNameResponse {}

export interface ActivateAccountRequest {
  readonly accountId: string;
}

export interface ActivateAccountResponse {}

export interface DeactivateAccountRequest {
  readonly accountId: string;
}

export interface DeactivateAccountResponse {}

export interface DeleteAccountRequest {
  readonly accountId: string;
  /**
   * Required to delete anything but a paper account, and it takes the account's
   * positions, profits and transactions with it.
   */
  readonly force?: boolean;
}

export interface DeleteAccountResponse {}
