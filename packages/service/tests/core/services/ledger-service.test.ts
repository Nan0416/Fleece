import { Decimal, InvalidRequestError, NotFoundError } from '@fleece/utilities';
import { LedgerService } from '../../../src/core/services/ledger-service';
import { FakeAccountDao } from './fake-daos';
import { aPosition, aTransaction, FakeLedgerDao } from './fake-ledger-dao';

const d = (value: string): Decimal => Decimal.of(value);

describe('LedgerService', () => {
  let ledgerDao: FakeLedgerDao;
  let accountDao: FakeAccountDao;
  let service: LedgerService;

  beforeEach(() => {
    ledgerDao = new FakeLedgerDao();
    accountDao = new FakeAccountDao();
    accountDao.seed('MOMENTUM01');
    accountDao.seed('CARRY00001');
    service = new LedgerService(ledgerDao, accountDao);
  });

  /**
   * Every read and every write asks whether the account exists first. A position
   * written against an account that does not exist is a row nothing will ever list.
   */
  describe('requiring the account', () => {
    it.each([
      ['listPositions', () => service.listPositions({ accountId: 'NOSUCHACC1' })],
      ['getPosition', () => service.getPosition({ accountId: 'NOSUCHACC1', symbol: 'AAPL' })],
      ['listProfits', () => service.listProfits({ accountId: 'NOSUCHACC1' })],
      ['getProfit', () => service.getProfit({ accountId: 'NOSUCHACC1', symbol: 'AAPL' })],
      ['listTransactions', () => service.listTransactions({ accountId: 'NOSUCHACC1', from: 1, limit: 10, sort: 'desc' })],
      ['stockSplit', () => service.stockSplit({ accountId: 'NOSUCHACC1', symbol: 'AAPL', ratio: d('2') })],
    ])('%s refuses an account that does not exist, before reaching the DAO', async (_label, call) => {
      await expect(call()).rejects.toThrow(NotFoundError);
      expect(ledgerDao.calls).toHaveLength(0);
    });

    it('names the account it could not find', async () => {
      await expect(service.listPositions({ accountId: 'NOSUCHACC1' })).rejects.toThrow(/NOSUCHACC1/);
    });
  });

  describe('listPositions', () => {
    it('excludes closed positions unless asked for them', async () => {
      await service.listPositions({ accountId: 'MOMENTUM01' });
      expect(ledgerDao.inputFor('listPositions')).toMatchObject({ includeClosed: false });
    });

    it('passes the asset-class filter through', async () => {
      await service.listPositions({ accountId: 'MOMENTUM01', includeClosed: true, assetClass: 'option' });
      expect(ledgerDao.inputFor('listPositions')).toMatchObject({ includeClosed: true, assetClass: 'option' });
    });
  });

  describe('getPosition', () => {
    it('returns the position when there is one', async () => {
      ledgerDao.position = aPosition();
      await expect(service.getPosition({ accountId: 'MOMENTUM01', symbol: 'AAPL' })).resolves.toEqual({ position: ledgerDao.position });
    });

    it('is a 404 for a symbol the account has never held', async () => {
      ledgerDao.position = null;
      await expect(service.getPosition({ accountId: 'MOMENTUM01', symbol: 'AAPL' })).rejects.toThrow(NotFoundError);
    });
  });

  describe('getProfit', () => {
    it('explains that a profit row appears only once a position has been reduced', async () => {
      ledgerDao.profit = null;
      await expect(service.getProfit({ accountId: 'MOMENTUM01', symbol: 'AAPL' })).rejects.toThrow(/reduced/);
    });
  });

  describe('stockSplit', () => {
    it('applies a positive ratio', async () => {
      await service.stockSplit({ accountId: 'MOMENTUM01', symbol: 'AAPL', ratio: d('2') });
      expect(ledgerDao.inputFor('applyStockSplit')).toMatchObject({ symbol: 'AAPL' });
    });

    it.each([
      ['zero', '0'],
      ['negative', '-2'],
    ])('refuses a %s ratio before writing anything', async (_label, ratio) => {
      await expect(service.stockSplit({ accountId: 'MOMENTUM01', symbol: 'AAPL', ratio: d(ratio) })).rejects.toThrow(InvalidRequestError);
      expect(ledgerDao.called('applyStockSplit')).toBe(false);
    });

    it('is not an error to split a symbol the account has never held', async () => {
      ledgerDao.position = null;
      await expect(service.stockSplit({ accountId: 'MOMENTUM01', symbol: 'AAPL', ratio: d('2') })).resolves.toEqual({});
    });
  });

  describe('applyCumulativeFill', () => {
    it('reports the transaction a report produced', async () => {
      ledgerDao.cumulativeTransaction = aTransaction({ size: d('4') });
      const { transaction } = await service.applyCumulativeFill({
        referenceId: 'order-1',
        accountId: 'MOMENTUM01',
        symbol: 'AAPL',
        assetClass: 'equity',
        multiplier: Decimal.ONE,
        cumulativeFilledSize: d('4'),
        cumulativeFilledTotalCost: d('400'),
        timestamp: 1,
      });
      expect(transaction?.size.toString()).toBe('4');
    });

    it('reports null for a duplicate report rather than inventing an empty transaction', async () => {
      // The websocket and the REST backfill both reporting one fill is the expected
      // case, not the exceptional one.
      ledgerDao.cumulativeTransaction = null;
      const { transaction } = await service.applyCumulativeFill({
        referenceId: 'order-1',
        accountId: 'MOMENTUM01',
        symbol: 'AAPL',
        assetClass: 'equity',
        multiplier: Decimal.ONE,
        cumulativeFilledSize: d('4'),
        cumulativeFilledTotalCost: d('400'),
        timestamp: 1,
      });
      expect(transaction).toBeNull();
    });
  });

  describe('getOrderFillProgress', () => {
    it('reports reconciled when the stored counters agree with the transactions behind them', async () => {
      const { reconciled } = await service.getOrderFillProgress({ referenceId: 'order-1' });
      expect(reconciled).toBe(true);
    });

    it('reports not reconciled when they disagree', async () => {
      // The counter was made cheap to write and therefore possible to drift; this is
      // the only thing that says so.
      ledgerDao.discrepancies = [
        { referenceId: 'order-1', accountId: 'MOMENTUM01', symbol: 'AAPL', storedSize: d('10'), summedSize: d('9'), storedTotalCost: d('1000'), summedTotalCost: d('900') },
      ];
      const { reconciled } = await service.getOrderFillProgress({ referenceId: 'order-1' });
      expect(reconciled).toBe(false);
    });
  });

  describe('transferPosition', () => {
    const transfer = {
      originAccountId: 'MOMENTUM01',
      destinationAccountId: 'CARRY00001',
      symbol: 'AAPL',
      assetClass: 'equity' as const,
      size: d('10'),
      unitCost: d('100'),
    };

    it('signs the origin negative and the destination positive', async () => {
      await service.transferPosition(transfer);
      const input = ledgerDao.inputFor('transferPosition');
      expect(input).toMatchObject({ symbol: 'AAPL', brokerAccountId: expect.any(String) });
      expect(input).toMatchObject({ origin: { accountId: 'MOMENTUM01' }, destination: { accountId: 'CARRY00001' } });
    });

    it('gives each side a synthetic order naming the other as its counterpart', async () => {
      await service.transferPosition(transfer);
      const input = ledgerDao.inputFor('transferPosition');
      expect(input).toMatchObject({
        origin: { record: { counterpartAccountId: 'CARRY00001', size: expect.anything() } },
        destination: { record: { counterpartAccountId: 'MOMENTUM01' } },
      });
    });

    it('refuses a transfer to the same account', async () => {
      await expect(service.transferPosition({ ...transfer, destinationAccountId: 'MOMENTUM01' })).rejects.toThrow(/two different accounts/);
      expect(ledgerDao.called('transferPosition')).toBe(false);
    });

    it.each([
      ['zero', '0'],
      ['negative', '-10'],
    ])('refuses a %s size and says how to transfer the other way', async (_label, size) => {
      await expect(service.transferPosition({ ...transfer, size: d(size) })).rejects.toThrow(/swap origin and destination/);
    });

    it('refuses a non-positive unit cost', async () => {
      await expect(service.transferPosition({ ...transfer, unitCost: d('0') })).rejects.toThrow(InvalidRequestError);
    });

    it('refuses to mix a paper account with a live one, whichever way round', async () => {
      // The one operation that could move a position from a simulated account into a
      // real one, after which the totals on both sides are fiction.
      accountDao.seed('LIVEACCT01', { accountType: 'live' });
      await expect(service.transferPosition({ ...transfer, destinationAccountId: 'LIVEACCT01' })).rejects.toThrow(/Both sides of a transfer must be the same account type/);
      await expect(service.transferPosition({ ...transfer, originAccountId: 'LIVEACCT01' })).rejects.toThrow(InvalidRequestError);
      expect(ledgerDao.called('transferPosition')).toBe(false);
    });

    it('refuses when either account does not exist', async () => {
      await expect(service.transferPosition({ ...transfer, destinationAccountId: 'NOSUCHACC1' })).rejects.toThrow(NotFoundError);
      await expect(service.transferPosition({ ...transfer, originAccountId: 'NOSUCHACC1' })).rejects.toThrow(NotFoundError);
    });
  });
});
