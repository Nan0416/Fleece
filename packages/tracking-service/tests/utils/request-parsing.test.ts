import { InvalidRequestError } from '@fleece/shared';
import { parseTrackBrokerOrdersRequest } from '../../src/utils/request-parsing';

describe('parseTrackBrokerOrdersRequest', () => {
  it('reads a claim naming several orders, which is what a spread sends', () => {
    const request = parseTrackBrokerOrdersRequest({ brokerOrderIds: ['mleg-parent', 'leg-a', 'leg-b'], accountId: 'MOMENTUM01' });
    expect(request).toEqual({ brokerOrderIds: ['mleg-parent', 'leg-a', 'leg-b'], accountId: 'MOMENTUM01' });
  });

  it('refuses a claim that names no orders, which would be accepted and do nothing', () => {
    expect(() => parseTrackBrokerOrdersRequest({ brokerOrderIds: [], accountId: 'MOMENTUM01' })).toThrow(InvalidRequestError);
  });

  it('refuses more orders than one claim may carry', () => {
    // Every id costs a lookup on the queue that also carries the broker's fills.
    const ids = Array.from({ length: 101 }, (_value, index) => `order-${index}`);
    expect(() => parseTrackBrokerOrdersRequest({ brokerOrderIds: ids, accountId: 'MOMENTUM01' })).toThrow(/at most 100/);
  });

  it('names the entry that was not a string, rather than the array', () => {
    expect(() => parseTrackBrokerOrdersRequest({ brokerOrderIds: ['order-1', 42], accountId: 'MOMENTUM01' })).toThrow(/brokerOrderIds\[1\]/);
  });

  it.each([
    ['no account', { brokerOrderIds: ['order-1'] }],
    ['an empty account', { brokerOrderIds: ['order-1'], accountId: '' }],
    ['no ids at all', { accountId: 'MOMENTUM01' }],
    ['a body that is not an object', 'order-1'],
  ])('refuses a claim with %s', (_name, body) => {
    expect(() => parseTrackBrokerOrdersRequest(body)).toThrow(InvalidRequestError);
  });
});
