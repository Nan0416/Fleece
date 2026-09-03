import {
  assertArray,
  assertInteger,
  assertNonEmptyString,
  assertNumber,
  assertOneOf,
  assertOptionalOneOf,
  assertOptionalString,
  assertRecord,
  AppendDocumentsRequest,
  CreateAccountRequest,
  CreateOrderGroupRequest,
  Document,
  InvalidRequestError,
  ListBrokerOrdersRequest,
  ListDividendsRequest,
  ListHistoricalPositionsRequest,
  ListOrderGroupsRequest,
  ListPositionsRequest,
  ListTransactionsRequest,
  parseOptionalBooleanParam,
  parseOptionalIntegerParam,
  SortDirection,
  StockSplitRequest,
  TimeWindowPage,
  TransferPositionRequest,
  UpdateAccountNameRequest,
} from '@fleece/shared';

const ACCOUNT_TYPES = ['live', 'paper', 'mirror'] as const;
const ACCOUNT_STATUSES = ['active', 'inactive'] as const;
const ORDER_GROUP_STATUSES = ['open', 'closed'] as const;
const SORT_DIRECTIONS: ReadonlyArray<SortDirection> = ['asc', 'desc'];

/** Caps a page so one request cannot ask for the whole table. */
const MAX_PAGE_LIMIT = 1000;

export function requireStringParam(query: unknown, field: string): string {
  return assertNonEmptyString(assertRecord(query, 'query')[field], field);
}

export function optionalStringParam(query: unknown, field: string): string | undefined {
  const value = assertRecord(query, 'query')[field];
  // An omitted query parameter and one present but empty both mean "not given";
  // Express hands back `''` for `?symbol=`.
  return value === '' ? undefined : assertOptionalString(value, field);
}

/**
 * The `from`/`limit`/`sort` triple every paged listing takes.
 *
 * All three are required rather than defaulted. An unbounded listing is exactly what
 * the deprecated legacy endpoint did, and defaulting them would quietly reintroduce
 * it for anyone who forgot.
 */
export function parseTimeWindowPage(query: unknown): TimeWindowPage {
  const record = assertRecord(query, 'query');
  const from = parseOptionalIntegerParam(record['from'], 'from');
  const limit = parseOptionalIntegerParam(record['limit'], 'limit');

  if (from === undefined) {
    throw new InvalidRequestError('from is required: an epoch timestamp in milliseconds to page from.');
  }
  if (from <= 0) {
    throw new InvalidRequestError(`from must be a positive epoch timestamp in milliseconds, got ${from}.`);
  }
  if (limit === undefined) {
    throw new InvalidRequestError(`limit is required: how many rows to return, at most ${MAX_PAGE_LIMIT}.`);
  }
  if (limit <= 0 || limit > MAX_PAGE_LIMIT) {
    throw new InvalidRequestError(`limit must be between 1 and ${MAX_PAGE_LIMIT}, got ${limit}.`);
  }

  return { from, limit, sort: assertOneOf(record['sort'], 'sort', SORT_DIRECTIONS) };
}

export function parseCreateAccountRequest(body: unknown): CreateAccountRequest {
  const record = assertRecord(body, 'body');
  return {
    accountId: assertOptionalString(record['accountId'], 'accountId'),
    name: assertNonEmptyString(record['name'], 'name'),
    accountType: assertOneOf(record['accountType'], 'accountType', ACCOUNT_TYPES),
  };
}

export function parseUpdateAccountNameRequest(query: unknown, body: unknown): UpdateAccountNameRequest {
  return {
    accountId: requireStringParam(query, 'accountId'),
    name: assertNonEmptyString(assertRecord(body, 'body')['name'], 'name'),
  };
}

export function parseListAccountsQuery(query: unknown) {
  const record = assertRecord(query, 'query');
  return { status: assertOptionalOneOf(record['status'] === '' ? undefined : record['status'], 'status', ACCOUNT_STATUSES) };
}

export function parseListPositionsQuery(query: unknown): ListPositionsRequest {
  const record = assertRecord(query, 'query');
  return {
    accountId: requireStringParam(query, 'accountId'),
    includeClosed: parseOptionalBooleanParam(record['includeClosed'], 'includeClosed'),
  };
}

export function parseListHistoricalPositionsQuery(query: unknown): ListHistoricalPositionsRequest {
  return {
    accountId: requireStringParam(query, 'accountId'),
    symbol: requireStringParam(query, 'symbol'),
    ...parseTimeWindowPage(query),
  };
}

export function parseStockSplitRequest(body: unknown): StockSplitRequest {
  const record = assertRecord(body, 'body');
  const ratio = assertNumber(record['ratio'], 'ratio');
  if (!(ratio > 0)) {
    throw new InvalidRequestError(`ratio must be greater than zero, got ${ratio}.`);
  }
  return {
    accountId: assertNonEmptyString(record['accountId'], 'accountId'),
    symbol: assertNonEmptyString(record['symbol'], 'symbol'),
    ratio,
  };
}

export function parseTransferPositionRequest(body: unknown): TransferPositionRequest {
  const record = assertRecord(body, 'body');
  const timestamp = record['timestamp'];
  return {
    originAccountId: assertNonEmptyString(record['originAccountId'], 'originAccountId'),
    originGroupId: assertNonEmptyString(record['originGroupId'], 'originGroupId'),
    destinationAccountId: assertNonEmptyString(record['destinationAccountId'], 'destinationAccountId'),
    destinationGroupId: assertNonEmptyString(record['destinationGroupId'], 'destinationGroupId'),
    symbol: assertNonEmptyString(record['symbol'], 'symbol'),
    unitCost: assertNumber(record['unitCost'], 'unitCost'),
    shares: assertInteger(record['shares'], 'shares'),
    timestamp: timestamp === undefined ? undefined : assertInteger(timestamp, 'timestamp'),
  };
}

export function parseListTransactionsQuery(query: unknown): ListTransactionsRequest {
  return {
    accountId: requireStringParam(query, 'accountId'),
    symbol: optionalStringParam(query, 'symbol'),
    ...parseTimeWindowPage(query),
  };
}

export function parseListDividendsQuery(query: unknown): ListDividendsRequest {
  return { accountId: requireStringParam(query, 'accountId'), symbol: optionalStringParam(query, 'symbol') };
}

export function parseCreateOrderGroupRequest(body: unknown): CreateOrderGroupRequest {
  const record = assertRecord(body, 'body');
  return {
    accountId: assertNonEmptyString(record['accountId'], 'accountId'),
    correlationType: assertNonEmptyString(record['correlationType'], 'correlationType'),
    correlationId: assertOptionalString(record['correlationId'], 'correlationId'),
  };
}

export function parseListOrderGroupsQuery(query: unknown): ListOrderGroupsRequest {
  const record = assertRecord(query, 'query');
  return {
    accountId: optionalStringParam(query, 'accountId'),
    correlationType: optionalStringParam(query, 'correlationType'),
    correlationId: optionalStringParam(query, 'correlationId'),
    symbol: optionalStringParam(query, 'symbol'),
    status: assertOptionalOneOf(record['status'] === '' ? undefined : record['status'], 'status', ORDER_GROUP_STATUSES),
    startTimestamp: parseOptionalIntegerParam(record['startTimestamp'], 'startTimestamp'),
    endTimestamp: parseOptionalIntegerParam(record['endTimestamp'], 'endTimestamp'),
  };
}

export function parseAppendDocumentsRequest(body: unknown): AppendDocumentsRequest {
  const record = assertRecord(body, 'body');
  const raw = assertArray(record['documents'], 'documents');
  const documents: Document[] = raw.map((entry, index) => {
    const document = assertRecord(entry, `documents[${index}]`);
    return {
      type: assertOneOf(document['type'], `documents[${index}].type`, ['execution-configs'] as const),
      documentId: assertNonEmptyString(document['documentId'], `documents[${index}].documentId`),
      configId: assertNonEmptyString(document['configId'], `documents[${index}].configId`),
      version: assertInteger(document['version'], `documents[${index}].version`),
      obj: document['obj'],
    };
  });
  return { groupId: assertNonEmptyString(record['groupId'], 'groupId'), documents };
}

export function parseListBrokerOrdersQuery(query: unknown): ListBrokerOrdersRequest {
  return {
    accountId: optionalStringParam(query, 'accountId'),
    brokerAccountId: optionalStringParam(query, 'brokerAccountId'),
    symbol: optionalStringParam(query, 'symbol'),
    status: optionalStringParam(query, 'status'),
    ...parseTimeWindowPage(query),
  };
}
