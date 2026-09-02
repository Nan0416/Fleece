import { InvalidRequestError, NotFoundError } from '@fleece/shared';
import { AccountDao } from '../../src/data/account-dao';
import { OrderGroupService } from '../../src/services/order-group-service';
import { FakeAccountDao, FakeOrderGroupDao } from './fake-daos';

const WINDOW = { startTimestamp: 1_000, endTimestamp: 2_000 };

describe('OrderGroupService', () => {
  let groups: FakeOrderGroupDao;
  let accounts: FakeAccountDao;
  let service: OrderGroupService;

  beforeEach(() => {
    groups = new FakeOrderGroupDao();
    accounts = new FakeAccountDao();
    accounts.seed('ACCOUNT001');
    service = new OrderGroupService(groups, accounts as AccountDao);
  });

  describe('listOrderGroups', () => {
    /**
     * The rule looks arbitrary and is not: each search property has an index paired
     * with the creation timestamp, so one property plus a window is a range scan.
     * Anything else is a table scan the service refuses rather than serves slowly.
     */
    it('requires a search property', async () => {
      await expect(service.listOrderGroups({})).rejects.toThrow(InvalidRequestError);
      await expect(service.listOrderGroups({})).rejects.toThrow(/needs one search property/);
    });

    it('refuses more than one search property', async () => {
      await expect(service.listOrderGroups({ accountId: 'ACCOUNT001', status: 'open', ...WINDOW })).rejects.toThrow(/accepts one search property/);
    });

    it('requires a time window alongside a search property', async () => {
      await expect(service.listOrderGroups({ accountId: 'ACCOUNT001' })).rejects.toThrow(/needs both startTimestamp and endTimestamp/);
      await expect(service.listOrderGroups({ accountId: 'ACCOUNT001', startTimestamp: 1_000 })).rejects.toThrow(/needs both startTimestamp and endTimestamp/);
    });

    it('accepts a search property with a window', async () => {
      await expect(service.listOrderGroups({ accountId: 'ACCOUNT001', ...WINDOW })).resolves.toEqual({ orderGroups: [] });
      await expect(service.listOrderGroups({ correlationType: 'breakout', ...WINDOW })).resolves.toEqual({ orderGroups: [] });
      await expect(service.listOrderGroups({ status: 'open', ...WINDOW })).resolves.toEqual({ orderGroups: [] });
    });

    it('exempts correlationId, which is selective on its own', async () => {
      await expect(service.listOrderGroups({ correlationId: 'corr-1' })).resolves.toEqual({ orderGroups: [] });
    });

    it('refuses a window alongside correlationId, rather than ignoring it', async () => {
      await expect(service.listOrderGroups({ correlationId: 'corr-1', ...WINDOW })).rejects.toThrow(/cannot be combined with a time window/);
    });

    it('does not count symbol as a search property, since it only narrows one', async () => {
      await expect(service.listOrderGroups({ accountId: 'ACCOUNT001', symbol: 'AAPL', ...WINDOW })).resolves.toEqual({ orderGroups: [] });
      expect(groups.listCalls[0].symbol).toBe('AAPL');
    });
  });

  describe('createOrderGroup', () => {
    it('generates a group id and a correlation id when none is given', async () => {
      const { groupId } = await service.createOrderGroup({ accountId: 'ACCOUNT001', correlationType: 'breakout' });
      const stored = groups.groups.get(groupId);
      expect(stored?.correlationId).toEqual(expect.any(String));
      expect(stored?.correlationId).not.toBe('');
      expect(stored?.status).toBe('open');
    });

    it('keeps a caller-supplied correlation id, which is how a group is found again', async () => {
      const { groupId } = await service.createOrderGroup({ accountId: 'ACCOUNT001', correlationType: 'breakout', correlationId: 'run-42' });
      expect(groups.groups.get(groupId)?.correlationId).toBe('run-42');
    });

    it('refuses to create a group for an account that does not exist', async () => {
      await expect(service.createOrderGroup({ accountId: 'NOSUCHACC1', correlationType: 'breakout' })).rejects.toThrow(NotFoundError);
    });
  });

  describe('appendDocuments', () => {
    const document = (documentId: string, version: number) => ({ type: 'execution-configs' as const, documentId, configId: 'cfg', version, obj: {} });

    it('adds documents to a group that has none', async () => {
      groups.seed('group-1');
      await service.appendDocuments({ groupId: 'group-1', documents: [document('doc-1', 1)] });
      expect(groups.groups.get('group-1')?.documents).toHaveLength(1);
    });

    it('replaces a document with the same id rather than duplicating it', async () => {
      groups.seed('group-1', { documents: [document('doc-1', 1)] });
      await service.appendDocuments({ groupId: 'group-1', documents: [document('doc-1', 2)] });

      const stored = groups.groups.get('group-1')?.documents;
      expect(stored).toHaveLength(1);
      expect(stored?.[0].version).toBe(2);
    });

    it('keeps documents the request did not mention', async () => {
      groups.seed('group-1', { documents: [document('doc-1', 1)] });
      await service.appendDocuments({ groupId: 'group-1', documents: [document('doc-2', 1)] });
      expect(
        groups.groups
          .get('group-1')
          ?.documents?.map((entry) => entry.documentId)
          .sort(),
      ).toEqual(['doc-1', 'doc-2']);
    });

    it('fails on a group that does not exist', async () => {
      await expect(service.appendDocuments({ groupId: 'nope', documents: [] })).rejects.toThrow(NotFoundError);
    });
  });

  describe('closeOrderGroup', () => {
    it('closes an existing group', async () => {
      groups.seed('group-1');
      await service.closeOrderGroup({ groupId: 'group-1' });
      expect(groups.groups.get('group-1')?.status).toBe('closed');
    });

    it('fails on a group that does not exist', async () => {
      await expect(service.closeOrderGroup({ groupId: 'nope' })).rejects.toThrow(NotFoundError);
    });
  });
});
