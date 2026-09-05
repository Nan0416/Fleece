import { InvalidRequestError } from '@fleece/shared';
import {
  parseCreateAccountRequest,
  parseListBrokerOrdersQuery,
  parseStockSplitRequest,
  parseTimeWindowPage,
  parseTransferPositionRequest,
  requireStringParam,
} from '../../src/utils/request-parsing';

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

describe('requireStringParam', () => {
  it('takes a query parameter that must be there', () => {
    expect(requireStringParam({ accountId: 'A1' }, 'accountId')).toBe('A1');
  });

  it('refuses a missing or empty one rather than searching for nothing', () => {
    expect(() => requireStringParam({}, 'accountId')).toThrow(InvalidRequestError);
    expect(() => requireStringParam({ accountId: '' }, 'accountId')).toThrow(InvalidRequestError);
  });
});

describe('decimals on the wire', () => {
  const valid = {
    originAccountId: 'A1',
    destinationAccountId: 'A2',
    symbol: 'AAPL',
    assetClass: 'equity',
    unitCost: '120.25',
    size: '4',
  };

  it('reads a decimal from a string, keeping every digit sent', () => {
    const request = parseTransferPositionRequest({ ...valid, unitCost: '120.123456789' });
    expect(request.unitCost.toString()).toBe('120.123456789');
    expect(request.timestamp).toBeUndefined();
  });

  /**
   * The rule the whole redesign rests on, enforced at the one place a caller can reach.
   * `JSON.parse` produces a double, so by the time a number arrives here whatever
   * precision it could not hold is already gone — accepting it would let the failure
   * this system exists to prevent in through the front door.
   */
  it('refuses a JSON number, and says to send a string instead', () => {
    expect(() => parseTransferPositionRequest({ ...valid, unitCost: 120.25 })).toThrow(InvalidRequestError);
    expect(() => parseTransferPositionRequest({ ...valid, unitCost: 120.25 })).toThrow(/must be sent as a string/);
  });

  it('refuses a string that is not a number rather than producing a NaN', () => {
    expect(() => parseTransferPositionRequest({ ...valid, unitCost: 'cheap' })).toThrow(InvalidRequestError);
  });

  it('accepts a fractional size, because fractional shares and crypto are both real', () => {
    expect(parseTransferPositionRequest({ ...valid, size: '0.333333333' }).size.toString()).toBe('0.333333333');
  });

  it('requires a positive size, since direction comes from which account is which', () => {
    expect(() => parseTransferPositionRequest({ ...valid, size: '-4' })).toThrow(/greater than zero/);
    expect(() => parseTransferPositionRequest({ ...valid, size: '0' })).toThrow(/greater than zero/);
  });

  it('rejects a missing side', () => {
    expect(() => parseTransferPositionRequest({ ...valid, destinationAccountId: undefined })).toThrow(InvalidRequestError);
  });

  it('takes a split ratio as a string too, so a three-for-two is exact', () => {
    expect(parseStockSplitRequest({ accountId: 'A1', symbol: 'AAPL', ratio: '1.5' }).ratio.toString()).toBe('1.5');
    expect(() => parseStockSplitRequest({ accountId: 'A1', symbol: 'AAPL', ratio: 1.5 })).toThrow(/must be sent as a string/);
  });
});

describe('parseListBrokerOrdersQuery', () => {
  it('treats an empty query parameter as absent, which is what Express hands back', () => {
    // `?symbol=` arrives as '', and passing that through would search for the empty
    // symbol rather than not filtering.
    const parsed = parseListBrokerOrdersQuery({ accountId: 'A1', symbol: '', status: '', assetClass: '', from: '1000', limit: '50', sort: 'asc' });
    expect(parsed).toEqual({ accountId: 'A1', brokerAccountId: undefined, symbol: undefined, status: undefined, assetClass: undefined, from: 1000, limit: 50, sort: 'asc' });
  });

  it('accepts an asset class and rejects one it does not know', () => {
    expect(parseListBrokerOrdersQuery({ assetClass: 'option', from: '1000', limit: '50', sort: 'asc' }).assetClass).toBe('option');
    expect(() => parseListBrokerOrdersQuery({ assetClass: 'futures', from: '1000', limit: '50', sort: 'asc' })).toThrow(InvalidRequestError);
  });
});
