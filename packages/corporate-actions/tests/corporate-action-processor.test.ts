import { AccountService, DividendService, LedgerService } from '@fleece/core';
import { MarketDataClient } from '@fleece/marketdata';
import { CorporateActionProcessor } from '../src/corporate-action-processor';
import { account, dividend, FakeAccountService, FakeDividendService, FakeLedgerService, FakeMarketDataClient, historyEntry, position, ThrowingMarketDataClient } from './fakes';

const REFERENCE_DATE = '2026-02-10';

interface Harness {
  readonly processor: CorporateActionProcessor;
  readonly dividends: FakeDividendService;
  readonly marketData: FakeMarketDataClient;
}

function harness(options: {
  accounts?: ReturnType<typeof account>[];
  positions?: ReturnType<typeof position>[];
  history?: ReturnType<typeof historyEntry>[];
  dividends?: ReturnType<typeof dividend>[];
  marketDataClient?: MarketDataClient;
}): Harness {
  const dividendService = new FakeDividendService();
  const marketData = new FakeMarketDataClient(options.dividends ?? []);
  const processor = new CorporateActionProcessor({
    accountService: new FakeAccountService(options.accounts ?? [account('MOMENTUM01')]) as unknown as AccountService,
    ledgerService: new FakeLedgerService(options.positions ?? [], options.history ?? []) as unknown as LedgerService,
    dividendService: dividendService as unknown as DividendService,
    marketDataClient: options.marketDataClient ?? marketData,
  });
  return { processor, dividends: dividendService, marketData };
}

describe('CorporateActionProcessor', () => {
  describe('which position earns the dividend', () => {
    it('uses the close of the day before the ex-dividend date, not the position today', async () => {
      // Buying on the ex-dividend date does not earn the dividend; holding at the
      // close of the day before does.
      const { processor, dividends } = harness({
        positions: [position('MOMENTUM01', 'AAPL', 500)],
        history: [
          historyEntry('MOMENTUM01', 'AAPL', '2026-02-03', 100),
          historyEntry('MOMENTUM01', 'AAPL', '2026-02-05', 200),
          // Bought more on the ex-dividend date itself; those shares earn nothing.
          historyEntry('MOMENTUM01', 'AAPL', '2026-02-06', 500),
        ],
        dividends: [dividend({ exDividendDate: '2026-02-06' })],
      });

      await processor.process({ referenceDate: REFERENCE_DATE });

      expect(dividends.recorded).toHaveLength(1);
      expect(dividends.recorded[0].size.toString()).toBe('200');
    });

    it('uses the last close of that day when the position moved several times', async () => {
      const { processor, dividends } = harness({
        positions: [position('MOMENTUM01', 'AAPL', 300)],
        history: [
          { ...historyEntry('MOMENTUM01', 'AAPL', '2026-02-05', 100), updatedAt: Date.parse('2026-02-05T15:00:00Z') },
          { ...historyEntry('MOMENTUM01', 'AAPL', '2026-02-05', 300), updatedAt: Date.parse('2026-02-05T20:30:00Z') },
        ],
        dividends: [dividend({ exDividendDate: '2026-02-06' })],
      });

      await processor.process({ referenceDate: REFERENCE_DATE });

      expect(dividends.recorded[0].size.toString()).toBe('300');
    });

    it('records nothing when the position was flat going into the ex-dividend date', async () => {
      const { processor, dividends } = harness({
        positions: [position('MOMENTUM01', 'AAPL', 0)],
        history: [historyEntry('MOMENTUM01', 'AAPL', '2026-02-02', 100), historyEntry('MOMENTUM01', 'AAPL', '2026-02-04', 0)],
        dividends: [dividend({ exDividendDate: '2026-02-06' })],
      });

      await processor.process({ referenceDate: REFERENCE_DATE });

      expect(dividends.recorded).toHaveLength(0);
    });

    it('records nothing when the account first held the symbol after the ex-dividend date', async () => {
      const { processor, dividends } = harness({
        positions: [position('MOMENTUM01', 'AAPL', 100)],
        history: [historyEntry('MOMENTUM01', 'AAPL', '2026-02-08', 100)],
        dividends: [dividend({ exDividendDate: '2026-02-06' })],
      });

      await processor.process({ referenceDate: REFERENCE_DATE });

      expect(dividends.recorded).toHaveLength(0);
    });

    it('records a negative size for a short, which owes the dividend rather than earning it', async () => {
      const { processor, dividends } = harness({
        positions: [position('MOMENTUM01', 'AAPL', -50)],
        history: [historyEntry('MOMENTUM01', 'AAPL', '2026-02-04', -50)],
        dividends: [dividend({ exDividendDate: '2026-02-06' })],
      });

      await processor.process({ referenceDate: REFERENCE_DATE });

      expect(dividends.recorded[0].size.toString()).toBe('-50');
    });
  });

  describe('the window it looks in', () => {
    it('spans a month either side of the reference date', async () => {
      const { processor, marketData } = harness({ positions: [position('MOMENTUM01', 'AAPL', 100)] });

      await processor.process({ referenceDate: REFERENCE_DATE });

      expect(marketData.dividendQueries).toEqual([{ symbol: 'AAPL', dateType: 'ex_dividend_date', fromDate: '2026-01-11', toDate: '2026-03-12' }]);
    });

    it('looks backwards as well as forwards, so a late-published dividend is still caught', async () => {
      const { processor, dividends } = harness({
        positions: [position('MOMENTUM01', 'AAPL', 100)],
        history: [historyEntry('MOMENTUM01', 'AAPL', '2026-01-15', 100)],
        dividends: [dividend({ exDividendDate: '2026-01-20' })],
      });

      await processor.process({ referenceDate: REFERENCE_DATE });

      expect(dividends.recorded).toHaveLength(1);
    });

    it('records an upcoming dividend before it is paid', async () => {
      const { processor, dividends } = harness({
        positions: [position('MOMENTUM01', 'AAPL', 100)],
        history: [historyEntry('MOMENTUM01', 'AAPL', '2026-02-04', 100)],
        dividends: [dividend({ exDividendDate: '2026-03-01', payDate: '2026-03-10' })],
      });

      await processor.process({ referenceDate: REFERENCE_DATE });

      expect(dividends.recorded).toHaveLength(1);
      expect(dividends.recorded[0].exDividendDate).toBe('2026-03-01');
    });
  });

  describe('scope', () => {
    it('covers closed positions, since a dividend can be owed on shares since sold', async () => {
      const { processor, dividends } = harness({
        positions: [position('MOMENTUM01', 'AAPL', 0)],
        history: [historyEntry('MOMENTUM01', 'AAPL', '2026-02-04', 100), historyEntry('MOMENTUM01', 'AAPL', '2026-02-09', 0)],
        dividends: [dividend({ exDividendDate: '2026-02-06' })],
      });

      await processor.process({ referenceDate: REFERENCE_DATE });

      expect(dividends.recorded[0].size.toString()).toBe('100');
    });

    it('covers every account', async () => {
      const { processor, dividends } = harness({
        accounts: [account('MOMENTUM01'), account('REVERSION1')],
        positions: [position('MOMENTUM01', 'AAPL', 100)],
        history: [historyEntry('MOMENTUM01', 'AAPL', '2026-02-04', 100)],
        dividends: [dividend({ exDividendDate: '2026-02-06' })],
      });

      const result = await processor.process({ referenceDate: REFERENCE_DATE });

      expect(result.accountsProcessed).toBe(2);
      expect(dividends.recorded).toHaveLength(2);
    });

    it('records every dividend in the window, not just the nearest', async () => {
      const { processor, dividends } = harness({
        positions: [position('MOMENTUM01', 'AAPL', 100)],
        history: [historyEntry('MOMENTUM01', 'AAPL', '2026-01-15', 100)],
        dividends: [dividend({ exDividendDate: '2026-01-20' }), dividend({ exDividendDate: '2026-02-20' })],
      });

      await processor.process({ referenceDate: REFERENCE_DATE });

      expect(dividends.recorded.map((entry) => entry.exDividendDate)).toEqual(['2026-01-20', '2026-02-20']);
    });
  });

  describe('failure', () => {
    it('keeps going when one symbol cannot be looked up', async () => {
      const { processor } = harness({
        positions: [position('MOMENTUM01', 'AAPL', 100), position('MOMENTUM01', 'MSFT', 50)],
        marketDataClient: new ThrowingMarketDataClient(),
      });

      const result = await processor.process({ referenceDate: REFERENCE_DATE });

      // Both failed, but the run completed rather than aborting on the first.
      expect(result.accountsProcessed).toBe(1);
      expect(result.symbolsProcessed).toBe(0);
      expect(result.dividendsRecorded).toBe(0);
    });
  });
});
