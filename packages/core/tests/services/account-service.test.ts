import { ConflictError, ForbiddenError, InvalidRequestError, NotFoundError } from '@fleece/shared';
import { AccountService } from '../../src/services/account-service';
import { FakeAccountDao } from './fake-daos';

describe('AccountService', () => {
  let dao: FakeAccountDao;
  let service: AccountService;

  beforeEach(() => {
    dao = new FakeAccountDao();
    service = new AccountService(dao);
  });

  describe('createAccount', () => {
    it('generates an id when none is given', async () => {
      const { account } = await service.createAccount({ name: 'Momentum', accountType: 'paper' });
      expect(account.accountId).toMatch(/^[0-9A-Z]{10}$/);
    });

    it('uses a caller-supplied id', async () => {
      const { account } = await service.createAccount({ accountId: 'MOMENTUM01', name: 'Momentum', accountType: 'paper' });
      expect(account.accountId).toBe('MOMENTUM01');
    });

    it('starts an account active', async () => {
      const { account } = await service.createAccount({ name: 'Momentum', accountType: 'paper' });
      expect(account.status).toBe('active');
    });

    it('rejects a malformed id before writing anything', async () => {
      await expect(service.createAccount({ accountId: 'too-short', name: 'Momentum', accountType: 'paper' })).rejects.toThrow(InvalidRequestError);
      expect(dao.accounts.size).toBe(0);
    });

    it('rejects a malformed name before writing anything', async () => {
      await expect(service.createAccount({ name: 'bad|name', accountType: 'paper' })).rejects.toThrow(InvalidRequestError);
      expect(dao.accounts.size).toBe(0);
    });
  });

  describe('getAccount', () => {
    it('says which ids are in use when the account is missing', async () => {
      await expect(service.getAccount({ accountId: 'NOSUCHACC1' })).rejects.toThrow(NotFoundError);
      await expect(service.getAccount({ accountId: 'NOSUCHACC1' })).rejects.toThrow(/List accounts/);
    });
  });

  describe('activate and deactivate', () => {
    it('changes status', async () => {
      dao.seed('MOMENTUM01');
      await service.deactivateAccount({ accountId: 'MOMENTUM01' });
      expect(dao.accounts.get('MOMENTUM01')?.status).toBe('inactive');
      await service.activateAccount({ accountId: 'MOMENTUM01' });
      expect(dao.accounts.get('MOMENTUM01')?.status).toBe('active');
    });

    it('is a no-op when the account is already in that state', async () => {
      dao.seed('MOMENTUM01', { status: 'active' });
      await expect(service.activateAccount({ accountId: 'MOMENTUM01' })).resolves.toEqual({});
    });

    it('fails on an account that does not exist', async () => {
      await expect(service.activateAccount({ accountId: 'NOSUCHACC1' })).rejects.toThrow(NotFoundError);
    });
  });

  describe('updateAccountName', () => {
    it('renames', async () => {
      dao.seed('MOMENTUM01', { name: 'Old' });
      await service.updateAccountName({ accountId: 'MOMENTUM01', name: 'New Name' });
      expect(dao.accounts.get('MOMENTUM01')?.name).toBe('New Name');
    });

    it('validates the new name', async () => {
      dao.seed('MOMENTUM01');
      await expect(service.updateAccountName({ accountId: 'MOMENTUM01', name: 'bad|name' })).rejects.toThrow(InvalidRequestError);
    });

    it('is a no-op when the name is unchanged', async () => {
      dao.seed('MOMENTUM01', { name: 'Momentum' });
      await expect(service.updateAccountName({ accountId: 'MOMENTUM01', name: 'Momentum' })).resolves.toEqual({});
    });
  });

  describe('deleteAccount', () => {
    it('deletes a paper account without ceremony', async () => {
      dao.seed('PAPER00001', { accountType: 'paper' });
      await service.deleteAccount({ accountId: 'PAPER00001' });
      expect(dao.accounts.has('PAPER00001')).toBe(false);
    });

    it.each(['live', 'mirror'] as const)('refuses to delete a %s account without force', async (accountType) => {
      dao.seed('REALMONEY1', { accountType });
      await expect(service.deleteAccount({ accountId: 'REALMONEY1' })).rejects.toThrow(ForbiddenError);
      expect(dao.accounts.has('REALMONEY1')).toBe(true);
    });

    it('says what will be lost, so force is an informed choice', async () => {
      dao.seed('REALMONEY1', { accountType: 'live' });
      await expect(service.deleteAccount({ accountId: 'REALMONEY1' })).rejects.toThrow(/positions, profits and transactions/);
    });

    it('deletes a live account when forced', async () => {
      dao.seed('REALMONEY1', { accountType: 'live' });
      await service.deleteAccount({ accountId: 'REALMONEY1', force: true });
      expect(dao.accounts.has('REALMONEY1')).toBe(false);
    });

    it('reports a conflict when something else deleted it first', async () => {
      dao.seed('PAPER00001');
      dao.deleteAccount = async () => ({ deleted: false });
      await expect(service.deleteAccount({ accountId: 'PAPER00001' })).rejects.toThrow(ConflictError);
    });
  });

  describe('listAccounts', () => {
    it('filters by status when asked and returns everything when not', async () => {
      dao.seed('ACTIVE0001', { status: 'active' });
      dao.seed('INACTIVE01', { status: 'inactive' });

      expect((await service.listAccounts()).accounts).toHaveLength(2);
      expect((await service.listAccounts({ status: 'inactive' })).accounts.map((account) => account.accountId)).toEqual(['INACTIVE01']);
    });
  });
});
