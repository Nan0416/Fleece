import { InternalServiceError } from '@fleece/shared';
import { toAccountStatus, toAccountType, toAssetClass, toBroker, toBrokerOrderAttribution, toDecimal, toDividendStatus, toOptionalDecimal } from '../../src/data/row-parsers';

describe('row parsers', () => {
  describe('narrowing a value a CHECK constraint already guarantees', () => {
    it('accepts what the constraint allows', () => {
      expect(toAccountStatus('active', 'ACCOUNT001')).toBe('active');
      expect(toAccountType('paper', 'ACCOUNT001')).toBe('paper');
      expect(toBroker('alpaca', 'order-1')).toBe('alpaca');
      expect(toAssetClass('option', 'Position ACCOUNT001/AAPL')).toBe('option');
      expect(toBrokerOrderAttribution('default', 'order-1')).toBe('default');
    });

    it('treats anything else as the schema and the code having diverged, not as a bad request', () => {
      // No caller can cause these and no caller can fix them, which is why they are not
      // InvalidRequestError.
      expect(() => toAccountStatus('archived', 'ACCOUNT001')).toThrow(InternalServiceError);
      expect(() => toAssetClass('futures', 'Position ACCOUNT001/AAPL')).toThrow(InternalServiceError);
      expect(() => toBrokerOrderAttribution('guessed', 'order-1')).toThrow(InternalServiceError);
    });

    it('names the row it could not read, so the bad row can be found', () => {
      expect(() => toAssetClass('futures', 'Position ACCOUNT001/AAPL')).toThrow(/Position ACCOUNT001\/AAPL/);
    });
  });

  describe('reading a NUMERIC column', () => {
    it('keeps every digit Postgres sent, which is the whole reason the column is NUMERIC', () => {
      // As a double this is 0.1234567890123456805, and the last digits are lost. The
      // column is read as text precisely so that it is not.
      expect(toDecimal('0.123456789012345678', 'test').toString()).toBe('0.123456789012345678');
    });

    it('round-trips a value that has no exact binary representation', () => {
      expect(toDecimal('0.1', 'test').add(toDecimal('0.2', 'test')).toString()).toBe('0.3');
    });

    it('reads a NULL column as absent rather than as zero', () => {
      expect(toOptionalDecimal(null, 'test')).toBeUndefined();
      expect(toOptionalDecimal('0', 'test')?.toString()).toBe('0');
    });

    it('refuses a value that is not a finite decimal rather than producing a NaN that spreads', () => {
      expect(() => toDecimal('not a number', 'ledger_transaction.total_cost')).toThrow(InternalServiceError);
      expect(() => toDecimal('not a number', 'ledger_transaction.total_cost')).toThrow(/ledger_transaction\.total_cost/);
    });
  });

  describe('dividend status', () => {
    const dates = { declarationDate: '2026-08-01', exDividendDate: '2026-08-10', recordDate: '2026-08-11', payDate: '2026-08-25' };

    it('is derived from the four dates and today, never stored', () => {
      expect(toDividendStatus(dates, '2026-08-05')).toBe('declared');
      expect(toDividendStatus(dates, '2026-08-10')).toBe('pending');
      expect(toDividendStatus(dates, '2026-08-11')).toBe('recorded');
      expect(toDividendStatus(dates, '2026-08-25')).toBe('paid');
    });
  });
});
