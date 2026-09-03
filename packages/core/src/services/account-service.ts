import {
  Account,
  ActivateAccountRequest,
  ActivateAccountResponse,
  assertAccountId,
  assertAccountName,
  ConflictError,
  CreateAccountRequest,
  CreateAccountResponse,
  DeactivateAccountRequest,
  DeactivateAccountResponse,
  DeleteAccountRequest,
  DeleteAccountResponse,
  ForbiddenError,
  generateAccountId,
  GetAccountRequest,
  GetAccountResponse,
  InternalServiceError,
  ListAccountsRequest,
  ListAccountsResponse,
  LoggerFactory,
  NotFoundError,
  UpdateAccountNameRequest,
  UpdateAccountNameResponse,
} from '@fleece/shared';
import { AccountDao } from '../data/account-dao';

const logger = LoggerFactory.getLogger('AccountService');

export class AccountService {
  constructor(private readonly accountDao: AccountDao) {}

  async createAccount(request: CreateAccountRequest): Promise<CreateAccountResponse> {
    const accountId = request.accountId === undefined ? generateAccountId() : assertAccountId(request.accountId);
    assertAccountName(request.name);

    logger.info(`Creating ${request.accountType} account ${accountId} named "${request.name}".`);
    const { account } = await this.accountDao.createAccount({
      accountId,
      name: request.name,
      accountType: request.accountType,
      status: 'active',
    });
    return { account };
  }

  async getAccount(request: GetAccountRequest): Promise<GetAccountResponse> {
    return { account: await this.requireAccount(request.accountId) };
  }

  async listAccounts(request: ListAccountsRequest = {}): Promise<ListAccountsResponse> {
    return await this.accountDao.listAccounts({ status: request.status });
  }

  async updateAccountName(request: UpdateAccountNameRequest): Promise<UpdateAccountNameResponse> {
    const account = await this.requireAccount(request.accountId);
    if (account.name === request.name) {
      logger.info(`Account ${request.accountId} is already named "${request.name}"; nothing to do.`);
      return {};
    }
    assertAccountName(request.name);
    logger.info(`Renaming account ${request.accountId} from "${account.name}" to "${request.name}".`);
    await this.accountDao.setName({ accountId: request.accountId, name: request.name });
    return {};
  }

  async activateAccount(request: ActivateAccountRequest): Promise<ActivateAccountResponse> {
    await this.setStatus(request.accountId, 'active');
    return {};
  }

  async deactivateAccount(request: DeactivateAccountRequest): Promise<DeactivateAccountResponse> {
    await this.setStatus(request.accountId, 'inactive');
    return {};
  }

  /**
   * Deleting an account takes its positions, profits, transactions, dividends, order
   * groups, broker orders and broker order records with it, by foreign key cascade.
   *
   * The legacy implementation deleted only the first three, leaving order groups and
   * broker orders pointing at an account that no longer existed — though its own
   * doc comment said it removed "position, profit and transaction records, order
   * records, order guards, etc". The cascade is that comment, enforced.
   */
  async deleteAccount(request: DeleteAccountRequest): Promise<DeleteAccountResponse> {
    const account = await this.requireAccount(request.accountId);

    if (request.force !== true && account.accountType !== 'paper') {
      throw new ForbiddenError(
        `Account ${request.accountId} is a ${account.accountType} account, and deleting it also deletes its positions, profits and transactions. Pass force to confirm.`,
      );
    }

    logger.info(`Deleting ${account.accountType} account ${request.accountId} and everything recorded against it.`);
    const { deleted } = await this.accountDao.deleteAccount({ accountId: request.accountId });
    if (!deleted) {
      // It existed a moment ago, so something else deleted it concurrently.
      throw new ConflictError(`Account ${request.accountId} was deleted by something else while this request was in flight.`);
    }
    return {};
  }

  private async setStatus(accountId: string, status: 'active' | 'inactive'): Promise<void> {
    const account = await this.requireAccount(accountId);
    if (account.status === status) {
      logger.info(`Account ${accountId} is already ${status}; nothing to do.`);
      return;
    }
    logger.info(`Setting account ${accountId} to ${status}.`);
    const result = await this.accountDao.setStatus({ accountId, status });
    if (result.account === null) {
      throw new InternalServiceError(`Account ${accountId} disappeared while its status was being set to ${status}.`);
    }
  }

  private async requireAccount(accountId: string): Promise<Account> {
    const { account } = await this.accountDao.getAccount({ accountId });
    if (account === null) {
      throw new NotFoundError(`Account ${accountId} does not exist. List accounts to see which ids are in use.`);
    }
    return account;
  }
}
