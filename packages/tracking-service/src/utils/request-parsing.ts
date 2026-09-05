import { assertNonEmptyString, assertRecord, InvalidRequestError, TrackBrokerOrdersRequest } from '@fleece/shared';

/**
 * How many orders one claim may name.
 *
 * A composite order is the reason this is more than one — a spread claims its parent and
 * up to four contracts together — and a cap is the reason it is not unbounded: every id
 * costs a lookup on the queue that also carries the broker's fills, so a claim naming ten
 * thousand orders would stall the write path behind it.
 */
const MAX_CLAIMED_ORDERS = 100;

export function parseTrackBrokerOrdersRequest(body: unknown): TrackBrokerOrdersRequest {
  const record = assertRecord(body, 'body');
  const ids = record['brokerOrderIds'];

  if (!Array.isArray(ids)) {
    throw new InvalidRequestError('brokerOrderIds is required: an array of the broker order ids this account is claiming.');
  }
  if (ids.length === 0) {
    throw new InvalidRequestError('brokerOrderIds is empty. A claim that names no orders would be accepted and do nothing.');
  }
  if (ids.length > MAX_CLAIMED_ORDERS) {
    throw new InvalidRequestError(`brokerOrderIds names ${ids.length} orders; at most ${MAX_CLAIMED_ORDERS} may be claimed at once. Split it.`);
  }

  return {
    brokerOrderIds: ids.map((id: unknown, index: number) => assertNonEmptyString(id, `brokerOrderIds[${index}]`)),
    accountId: assertNonEmptyString(record['accountId'], 'accountId'),
  };
}
