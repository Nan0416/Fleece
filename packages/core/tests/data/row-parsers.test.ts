import { InternalServiceError } from '@fleece/shared';
import { toAccountStatus, toAccountType, toBroker, toDividendStatus, toDocuments, toOrderGroupStatus } from '../../src/data/row-parsers';

describe('toDividendStatus', () => {
  const dates = { declarationDate: '2026-02-01', exDividendDate: '2026-02-06', recordDate: '2026-02-09', payDate: '2026-02-13' };

  it.each([
    ['before the ex-dividend date', '2026-02-05', 'declared'],
    ['on the ex-dividend date', '2026-02-06', 'pending'],
    ['between ex-dividend and record', '2026-02-08', 'pending'],
    ['on the record date', '2026-02-09', 'recorded'],
    ['between record and pay', '2026-02-11', 'recorded'],
    ['on the pay date', '2026-02-13', 'paid'],
    ['after the pay date', '2026-03-01', 'paid'],
  ])('is %s -> %s', (_when, today, expected) => {
    expect(toDividendStatus(dates, today)).toBe(expected);
  });

  it('is derived rather than stored, so the same row reads differently as time passes', () => {
    // The point of deriving it: a stored status would be correct the day it was
    // written and wrong every day after, since nothing revisits a recorded dividend.
    expect(toDividendStatus(dates, '2026-02-01')).toBe('declared');
    expect(toDividendStatus(dates, '2026-06-01')).toBe('paid');
  });
});

describe('column narrowing', () => {
  it('accepts the values the CHECK constraints allow', () => {
    expect(toAccountStatus('active', 'ACC')).toBe('active');
    expect(toAccountType('paper', 'ACC')).toBe('paper');
    expect(toOrderGroupStatus('open', 'G')).toBe('open');
    expect(toBroker('alpaca', 'BO')).toBe('alpaca');
  });

  it('treats anything else as a deployment fault, not a caller error', () => {
    // A CHECK constraint already guarantees these, so reaching here means the schema
    // and the code have diverged — which no caller can cause and none can fix.
    expect(() => toAccountStatus('archived', 'ACC')).toThrow(InternalServiceError);
    expect(() => toAccountType('crypto', 'ACC')).toThrow(InternalServiceError);
    expect(() => toOrderGroupStatus('settling', 'G')).toThrow(InternalServiceError);
    expect(() => toBroker('schwab', 'BO')).toThrow(InternalServiceError);
  });
});

describe('toDocuments', () => {
  it('reads back a stored document', () => {
    const stored = [{ type: 'execution-configs', documentId: 'doc-1', configId: 'cfg-1', version: 3, obj: { a: 1 } }];
    expect(toDocuments(stored, 'G')).toEqual(stored);
  });

  it('treats an absent column as no documents rather than an empty list', () => {
    expect(toDocuments(null, 'G')).toBeUndefined();
    expect(toDocuments(undefined, 'G')).toBeUndefined();
  });

  it('rejects a malformed document rather than letting an undefined surface far away', () => {
    expect(() => toDocuments('not an array', 'G')).toThrow(InternalServiceError);
    expect(() => toDocuments([{ type: 'execution-configs' }], 'G')).toThrow(InternalServiceError);
    expect(() => toDocuments([{ type: 'something-else', documentId: 'd', configId: 'c', version: 1 }], 'G')).toThrow(InternalServiceError);
  });
});
