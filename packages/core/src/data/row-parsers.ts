import { AccountStatus, AccountType, Broker, DividendStatus, Document, InternalServiceError, OrderGroupStatus } from '@fleece/shared';

/**
 * Narrowing for values read back out of Postgres.
 *
 * A CHECK constraint already guarantees each of these, so a failure here means the
 * schema and the code have diverged — a deployment problem, not a request problem.
 * That is why these throw `InternalServiceError` rather than `InvalidRequestError`:
 * no caller can cause them and no caller can fix them.
 */

export function toAccountStatus(value: string, accountId: string): AccountStatus {
  if (value === 'active' || value === 'inactive') {
    return value;
  }
  throw new InternalServiceError(`Account ${accountId} has unrecognised status "${value}".`);
}

export function toAccountType(value: string, accountId: string): AccountType {
  if (value === 'live' || value === 'paper' || value === 'mirror') {
    return value;
  }
  throw new InternalServiceError(`Account ${accountId} has unrecognised type "${value}".`);
}

export function toOrderGroupStatus(value: string, groupId: string): OrderGroupStatus {
  if (value === 'open' || value === 'closed') {
    return value;
  }
  throw new InternalServiceError(`Order group ${groupId} has unrecognised status "${value}".`);
}

export function toBroker(value: string, brokerOrderId: string): Broker {
  if (value === 'alpaca' || value === 'traderq') {
    return value;
  }
  throw new InternalServiceError(`Broker order ${brokerOrderId} has unrecognised broker "${value}".`);
}

/**
 * `documents` is a JSONB column, so node-postgres hands back whatever was stored. The
 * shape is written by this service and never by a caller, so it is checked only
 * enough to keep a malformed row from surfacing as `undefined` far away.
 */
export function toDocuments(value: unknown, groupId: string): ReadonlyArray<Document> | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new InternalServiceError(`Order group ${groupId} has a documents column that is not an array.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new InternalServiceError(`Order group ${groupId} document ${index} is not an object.`);
    }
    const record: Record<string, unknown> = { ...entry };
    if (record.type !== 'execution-configs' || typeof record.documentId !== 'string' || typeof record.configId !== 'string' || typeof record.version !== 'number') {
      throw new InternalServiceError(`Order group ${groupId} document ${index} is not a recognised document.`);
    }
    return {
      type: 'execution-configs',
      documentId: record.documentId,
      configId: record.configId,
      version: record.version,
      obj: record.obj,
    };
  });
}

/**
 * Derives dividend status from the four dates rather than storing it.
 *
 * Storing it would mean a row that is correct on the day it is written and wrong
 * every day after, since nothing revisits a dividend once recorded. The legacy models
 * said as much — "status can be derived from the four dates. don't store the status
 * in database" — and this is where that lives now.
 */
export function toDividendStatus(
  dates: { readonly declarationDate: string; readonly exDividendDate: string; readonly recordDate: string; readonly payDate: string },
  today: string,
): DividendStatus {
  if (today >= dates.payDate) {
    return 'paid';
  }
  if (today >= dates.recordDate) {
    return 'recorded';
  }
  if (today >= dates.exDividendDate) {
    return 'pending';
  }
  return 'declared';
}
