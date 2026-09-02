import { InvalidRequestError } from '@fleece/shared';
import { parseCreateAccountRequest, parseListOrderGroupsQuery, parseTimeWindowPage, parseTransferPositionRequest, requireStringParam } from '../../src/utils/request-parsing';

describe('parseTimeWindowPage', () => {
  it('accepts a complete page', () => {
    expect(parseTimeWindowPage({ from: '1000', limit: '50', sort: 'asc' })).toEqual({ from: 1000, limit: 50, sort: 'asc' });
  });

  /**
   * All three are required rather than defaulted: an unbounded listing is exactly what
   * the deprecated legacy endpoint did, and a default would quietly reintroduce it.
   */
  it('requires from, and says what it is', () => {
    expect(() => parseTimeWindowPage({ limit: '50', sort: 'asc' })).toThrow(/from is required/);
  });

  it('requires limit', () => {
    expect(() => parseTimeWindowPage({ from: '1000', sort: 'asc' })).toThrow(/limit is required/);
  });

  it('caps the page so one request cannot ask for the whole table', () => {
    expect(() => parseTimeWindowPage({ from: '1000', limit: '100000', sort: 'asc' })).toThrow(/between 1 and 1000/);
  });

  it('rejects a non-positive from', () => {
    expect(() => parseTimeWindowPage({ from: '0', limit: '50', sort: 'asc' })).toThrow(InvalidRequestError);
  });

  it('accepts only the two sort directions', () => {
    expect(parseTimeWindowPage({ from: '1', limit: '1', sort: 'desc' }).sort).toBe('desc');
    // 'dec' was the legacy spelling; it is not accepted, so a caller that missed the
    // rename fails loudly rather than silently paging the wrong way.
    expect(() => parseTimeWindowPage({ from: '1', limit: '1', sort: 'dec' })).toThrow(InvalidRequestError);
  });
});

describe('parseCreateAccountRequest', () => {
  it('accepts a request with a generated id', () => {
    expect(parseCreateAccountRequest({ name: 'Momentum', accountType: 'paper' })).toEqual({ accountId: undefined, name: 'Momentum', accountType: 'paper' });
  });

  it('rejects an unknown account type', () => {
    expect(() => parseCreateAccountRequest({ name: 'Momentum', accountType: 'crypto' })).toThrow(InvalidRequestError);
  });

  it('rejects a missing name', () => {
    expect(() => parseCreateAccountRequest({ accountType: 'paper' })).toThrow(InvalidRequestError);
  });
});

describe('parseTransferPositionRequest', () => {
  const valid = {
    originAccountId: 'A1',
    originGroupId: 'G1',
    destinationAccountId: 'A2',
    destinationGroupId: 'G2',
    symbol: 'AAPL',
    unitCost: 120,
    shares: 4,
  };

  it('accepts a complete request and leaves the timestamp optional', () => {
    expect(parseTransferPositionRequest(valid)).toEqual({ ...valid, timestamp: undefined });
  });

  it('requires whole shares', () => {
    expect(() => parseTransferPositionRequest({ ...valid, shares: 1.5 })).toThrow(InvalidRequestError);
  });

  it('rejects a missing side', () => {
    expect(() => parseTransferPositionRequest({ ...valid, destinationGroupId: undefined })).toThrow(InvalidRequestError);
  });
});

describe('parseListOrderGroupsQuery', () => {
  it('treats an empty query parameter as absent, which is what Express hands back', () => {
    // `?symbol=` arrives as '', and passing that through would search for the empty
    // symbol rather than not filtering.
    expect(parseListOrderGroupsQuery({ accountId: 'A1', symbol: '', status: '' })).toEqual({
      accountId: 'A1',
      correlationType: undefined,
      correlationId: undefined,
      symbol: undefined,
      status: undefined,
      startTimestamp: undefined,
      endTimestamp: undefined,
    });
  });

  it('rejects an unknown status', () => {
    expect(() => parseListOrderGroupsQuery({ status: 'settling' })).toThrow(InvalidRequestError);
  });
});

describe('requireStringParam', () => {
  it('rejects a missing parameter by name', () => {
    expect(() => requireStringParam({}, 'accountId')).toThrow(/accountId/);
  });
});
