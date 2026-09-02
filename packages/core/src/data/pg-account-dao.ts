import { Account, ConflictError } from '@fleece/shared';
import { Pool } from 'pg';
import {
  AccountDao,
  CreateAccountInput,
  CreateAccountOutput,
  DeleteAccountInput,
  DeleteAccountOutput,
  GetAccountInput,
  GetAccountOutput,
  ListAccountsInput,
  ListAccountsOutput,
  SetAccountNameInput,
  SetAccountNameOutput,
  SetAccountStatusInput,
  SetAccountStatusOutput,
} from './account-dao';
import { toAccountStatus, toAccountType } from './row-parsers';

interface AccountRow {
  readonly account_id: string;
  readonly name: string;
  readonly status: string;
  readonly account_type: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function toAccount(row: AccountRow): Account {
  return {
    accountId: row.account_id,
    name: row.name,
    status: toAccountStatus(row.status, row.account_id),
    accountType: toAccountType(row.account_type, row.account_id),
    createdAt: row.created_at.getTime(),
    lastUpdatedAt: row.updated_at.getTime(),
  };
}

const SELECT_COLUMNS = 'account_id, name, status, account_type, created_at, updated_at';

/** Postgres unique-violation. The only unique constraint here is the primary key. */
const UNIQUE_VIOLATION = '23505';

export class PgAccountDao implements AccountDao {
  constructor(private readonly pool: Pool) {}

  async createAccount(input: CreateAccountInput): Promise<CreateAccountOutput> {
    try {
      const result = await this.pool.query<AccountRow>(`INSERT INTO account (account_id, name, status, account_type) VALUES ($1, $2, $3, $4) RETURNING ${SELECT_COLUMNS}`, [
        input.accountId,
        input.name,
        input.status,
        input.accountType,
      ]);
      return { account: toAccount(result.rows[0]) };
    } catch (err) {
      // Raised rather than pre-checked with a SELECT, because a check-then-insert
      // loses the race it is trying to prevent.
      if (typeof err === 'object' && err !== null && 'code' in err && err.code === UNIQUE_VIOLATION) {
        throw new ConflictError(`Account ${input.accountId} already exists. Choose a different id, or omit it to have one generated.`);
      }
      throw err;
    }
  }

  async getAccount(input: GetAccountInput): Promise<GetAccountOutput> {
    const result = await this.pool.query<AccountRow>(`SELECT ${SELECT_COLUMNS} FROM account WHERE account_id = $1`, [input.accountId]);
    const row = result.rows[0];
    return { account: row === undefined ? null : toAccount(row) };
  }

  async listAccounts(input: ListAccountsInput): Promise<ListAccountsOutput> {
    const result =
      input.status === undefined
        ? await this.pool.query<AccountRow>(`SELECT ${SELECT_COLUMNS} FROM account ORDER BY created_at, account_id`)
        : await this.pool.query<AccountRow>(`SELECT ${SELECT_COLUMNS} FROM account WHERE status = $1 ORDER BY created_at, account_id`, [input.status]);
    return { accounts: result.rows.map(toAccount) };
  }

  async setStatus(input: SetAccountStatusInput): Promise<SetAccountStatusOutput> {
    const result = await this.pool.query<AccountRow>(`UPDATE account SET status = $2, updated_at = now() WHERE account_id = $1 RETURNING ${SELECT_COLUMNS}`, [
      input.accountId,
      input.status,
    ]);
    const row = result.rows[0];
    return { account: row === undefined ? null : toAccount(row) };
  }

  async setName(input: SetAccountNameInput): Promise<SetAccountNameOutput> {
    const result = await this.pool.query<AccountRow>(`UPDATE account SET name = $2, updated_at = now() WHERE account_id = $1 RETURNING ${SELECT_COLUMNS}`, [
      input.accountId,
      input.name,
    ]);
    const row = result.rows[0];
    return { account: row === undefined ? null : toAccount(row) };
  }

  async deleteAccount(input: DeleteAccountInput): Promise<DeleteAccountOutput> {
    const result = await this.pool.query('DELETE FROM account WHERE account_id = $1', [input.accountId]);
    return { deleted: (result.rowCount ?? 0) > 0 };
  }
}
