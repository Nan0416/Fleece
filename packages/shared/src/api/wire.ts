import { Account, Dividend, HistoricalPosition, Position, Profit, Transaction } from '../models/account';
import { BrokerOrder, BrokerOrderRecord, OrderFillProgress } from '../models/order';
import {
  assertArray,
  assertBoolean,
  assertDecimal,
  assertInteger,
  assertNonEmptyString,
  assertOneOf,
  assertOptionalDecimal,
  assertOptionalOneOf,
  assertOptionalString,
  assertRecord,
  assertString,
} from '../utils/assertions';

/**
 * Reading a response back into the domain models.
 *
 * **Why this has to exist.** A `Decimal` crosses the wire as a string — a JSON number is
 * a double and would discard exactly the precision the ledger is built to keep. So the
 * JSON a caller receives does not have the shape its `Response` type claims: `size` is
 * `"10.000000000"`, not a `Decimal`. Something has to turn one into the other, and a
 * cast cannot: there is no type assertion that makes a string behave like a Decimal.
 *
 * Guideline 18 names "the client/server type boundary" as a sanctioned place for `as`.
 * These functions retire that exception rather than use it — the conversion has to walk
 * the fields anyway, so checking them costs almost nothing and turns a promise about the
 * response into a fact about it.
 */

const ACCOUNT_STATUSES = ['active', 'inactive'] as const;
const ACCOUNT_TYPES = ['live', 'paper', 'mirror'] as const;
const ASSET_CLASSES = ['equity', 'option', 'crypto'] as const;
const BROKERS = ['alpaca', 'traderq'] as const;
const ORDER_CLASSES = ['regular', 'oco', 'oto', 'bracket', 'mleg'] as const;
const ORDER_TYPES = ['market', 'limit', 'stop', 'stop_limit'] as const;
const SIDES = ['buy', 'sell'] as const;
const TIMES_IN_FORCE = ['day', 'gtc', 'opg', 'cls', 'ioc', 'fok'] as const;
const POSITION_INTENTS = ['buy_to_open', 'buy_to_close', 'sell_to_open', 'sell_to_close'] as const;

/** Applies a reviver across a list, naming the index that failed rather than "an item". */
function reviveEach<T>(value: unknown, field: string, revive: (entry: unknown, entryField: string) => T): ReadonlyArray<T> {
  return assertArray(value, field).map((entry, index) => revive(entry, `${field}[${index}]`));
}

export function reviveAccount(value: unknown, field = 'account'): Account {
  const record = assertRecord(value, field);
  return {
    accountId: assertNonEmptyString(record['accountId'], `${field}.accountId`),
    name: assertString(record['name'], `${field}.name`),
    status: assertOneOf(record['status'], `${field}.status`, ACCOUNT_STATUSES),
    accountType: assertOneOf(record['accountType'], `${field}.accountType`, ACCOUNT_TYPES),
    createdAt: assertInteger(record['createdAt'], `${field}.createdAt`),
    lastUpdatedAt: assertInteger(record['lastUpdatedAt'], `${field}.lastUpdatedAt`),
  };
}

export function reviveAccounts(value: unknown, field = 'accounts'): ReadonlyArray<Account> {
  return reviveEach(value, field, reviveAccount);
}

export function revivePosition(value: unknown, field = 'position'): Position {
  const record = assertRecord(value, field);
  return {
    accountId: assertNonEmptyString(record['accountId'], `${field}.accountId`),
    symbol: assertNonEmptyString(record['symbol'], `${field}.symbol`),
    assetClass: assertOneOf(record['assetClass'], `${field}.assetClass`, ASSET_CLASSES),
    size: assertDecimal(record['size'], `${field}.size`),
    totalCost: assertDecimal(record['totalCost'], `${field}.totalCost`),
    multiplier: assertDecimal(record['multiplier'], `${field}.multiplier`),
    avgPrice: assertDecimal(record['avgPrice'], `${field}.avgPrice`),
    premium: assertDecimal(record['premium'], `${field}.premium`),
    createdAt: assertInteger(record['createdAt'], `${field}.createdAt`),
    lastUpdatedAt: assertInteger(record['lastUpdatedAt'], `${field}.lastUpdatedAt`),
  };
}

export function revivePositions(value: unknown, field = 'positions'): ReadonlyArray<Position> {
  return reviveEach(value, field, revivePosition);
}

export function reviveHistoricalPosition(value: unknown, field = 'position'): HistoricalPosition {
  const record = assertRecord(value, field);
  return {
    accountId: assertNonEmptyString(record['accountId'], `${field}.accountId`),
    symbol: assertNonEmptyString(record['symbol'], `${field}.symbol`),
    assetClass: assertOneOf(record['assetClass'], `${field}.assetClass`, ASSET_CLASSES),
    size: assertDecimal(record['size'], `${field}.size`),
    updatedAt: assertInteger(record['updatedAt'], `${field}.updatedAt`),
  };
}

export function reviveHistoricalPositions(value: unknown, field = 'positions'): ReadonlyArray<HistoricalPosition> {
  return reviveEach(value, field, reviveHistoricalPosition);
}

export function reviveProfit(value: unknown, field = 'profit'): Profit {
  const record = assertRecord(value, field);
  return {
    accountId: assertNonEmptyString(record['accountId'], `${field}.accountId`),
    symbol: assertNonEmptyString(record['symbol'], `${field}.symbol`),
    assetClass: assertOneOf(record['assetClass'], `${field}.assetClass`, ASSET_CLASSES),
    profit: assertDecimal(record['profit'], `${field}.profit`),
    createdAt: assertInteger(record['createdAt'], `${field}.createdAt`),
    lastUpdatedAt: assertInteger(record['lastUpdatedAt'], `${field}.lastUpdatedAt`),
  };
}

export function reviveProfits(value: unknown, field = 'profits'): ReadonlyArray<Profit> {
  return reviveEach(value, field, reviveProfit);
}

export function reviveTransaction(value: unknown, field = 'transaction'): Transaction {
  const record = assertRecord(value, field);
  return {
    referenceId: assertNonEmptyString(record['referenceId'], `${field}.referenceId`),
    accountId: assertNonEmptyString(record['accountId'], `${field}.accountId`),
    symbol: assertNonEmptyString(record['symbol'], `${field}.symbol`),
    assetClass: assertOneOf(record['assetClass'], `${field}.assetClass`, ASSET_CLASSES),
    timestamp: assertInteger(record['timestamp'], `${field}.timestamp`),
    size: assertDecimal(record['size'], `${field}.size`),
    totalCost: assertDecimal(record['totalCost'], `${field}.totalCost`),
    multiplier: assertDecimal(record['multiplier'], `${field}.multiplier`),
    avgPrice: assertDecimal(record['avgPrice'], `${field}.avgPrice`),
    premium: assertDecimal(record['premium'], `${field}.premium`),
    // Absent means the transaction realised nothing, which is a different statement
    // from realising zero — so `undefined` has to survive the round trip.
    profit: assertOptionalDecimal(record['profit'], `${field}.profit`),
    roi: assertOptionalDecimal(record['roi'], `${field}.roi`),
    cumulativeSize: assertDecimal(record['cumulativeSize'], `${field}.cumulativeSize`),
    cumulativeTotalCost: assertDecimal(record['cumulativeTotalCost'], `${field}.cumulativeTotalCost`),
    cumulativeProfit: assertDecimal(record['cumulativeProfit'], `${field}.cumulativeProfit`),
    cumulativeAvgPrice: assertDecimal(record['cumulativeAvgPrice'], `${field}.cumulativeAvgPrice`),
  };
}

export function reviveTransactions(value: unknown, field = 'transactions'): ReadonlyArray<Transaction> {
  return reviveEach(value, field, reviveTransaction);
}

export function reviveDividend(value: unknown, field = 'dividend'): Dividend {
  const record = assertRecord(value, field);
  return {
    accountId: assertNonEmptyString(record['accountId'], `${field}.accountId`),
    symbol: assertNonEmptyString(record['symbol'], `${field}.symbol`),
    exDividendDate: assertNonEmptyString(record['exDividendDate'], `${field}.exDividendDate`),
    size: assertDecimal(record['size'], `${field}.size`),
    amountPerShare: assertDecimal(record['amountPerShare'], `${field}.amountPerShare`),
    declarationDate: assertNonEmptyString(record['declarationDate'], `${field}.declarationDate`),
    recordDate: assertNonEmptyString(record['recordDate'], `${field}.recordDate`),
    payDate: assertNonEmptyString(record['payDate'], `${field}.payDate`),
    status: assertOneOf(record['status'], `${field}.status`, ['declared', 'pending', 'recorded', 'paid'] as const),
  };
}

export function reviveDividends(value: unknown, field = 'dividends'): ReadonlyArray<Dividend> {
  return reviveEach(value, field, reviveDividend);
}

export function reviveBrokerOrder(value: unknown, field = 'brokerOrder'): BrokerOrder {
  const record = assertRecord(value, field);
  return {
    brokerOrderId: assertNonEmptyString(record['brokerOrderId'], `${field}.brokerOrderId`),
    parentBrokerOrderId: assertOptionalString(record['parentBrokerOrderId'], `${field}.parentBrokerOrderId`),
    accountId: assertNonEmptyString(record['accountId'], `${field}.accountId`),
    broker: assertOneOf(record['broker'], `${field}.broker`, BROKERS),
    brokerAccountId: assertNonEmptyString(record['brokerAccountId'], `${field}.brokerAccountId`),
    // Absent on a composite parent, which trades no instrument of its own.
    symbol: assertOptionalString(record['symbol'], `${field}.symbol`),
    assetClass: assertOneOf(record['assetClass'], `${field}.assetClass`, ASSET_CLASSES),
    multiplier: assertDecimal(record['multiplier'], `${field}.multiplier`),
    // Free text on purpose: a status this list has not caught up with must survive the
    // round trip, not be rejected on the way through.
    status: assertNonEmptyString(record['status'], `${field}.status`),
    orderClass: assertOneOf(record['orderClass'], `${field}.orderClass`, ORDER_CLASSES),
    orderType: assertOneOf(record['orderType'], `${field}.orderType`, ORDER_TYPES),
    side: assertOptionalOneOf(record['side'], `${field}.side`, SIDES),
    positionIntent: assertOptionalOneOf(record['positionIntent'], `${field}.positionIntent`, POSITION_INTENTS),
    timeInForce: assertOneOf(record['timeInForce'], `${field}.timeInForce`, TIMES_IN_FORCE),
    extendedHours: assertBoolean(record['extendedHours'], `${field}.extendedHours`),
    qty: assertDecimal(record['qty'], `${field}.qty`),
    ratioQty: assertOptionalDecimal(record['ratioQty'], `${field}.ratioQty`),
    limitPrice: assertOptionalDecimal(record['limitPrice'], `${field}.limitPrice`),
    stopPrice: assertOptionalDecimal(record['stopPrice'], `${field}.stopPrice`),
    filledQty: assertDecimal(record['filledQty'], `${field}.filledQty`),
    filledAvgPrice: assertOptionalDecimal(record['filledAvgPrice'], `${field}.filledAvgPrice`),
    submittedAt: record['submittedAt'] === undefined ? undefined : assertInteger(record['submittedAt'], `${field}.submittedAt`),
    filledAt: record['filledAt'] === undefined ? undefined : assertInteger(record['filledAt'], `${field}.filledAt`),
    createdAt: assertInteger(record['createdAt'], `${field}.createdAt`),
    lastUpdatedAt: assertInteger(record['lastUpdatedAt'], `${field}.lastUpdatedAt`),
  };
}

export function reviveBrokerOrders(value: unknown, field = 'brokerOrders'): ReadonlyArray<BrokerOrder> {
  return reviveEach(value, field, reviveBrokerOrder);
}

export function reviveOrderFillProgress(value: unknown, field = 'progress'): OrderFillProgress {
  const record = assertRecord(value, field);
  return {
    referenceId: assertNonEmptyString(record['referenceId'], `${field}.referenceId`),
    accountId: assertNonEmptyString(record['accountId'], `${field}.accountId`),
    symbol: assertNonEmptyString(record['symbol'], `${field}.symbol`),
    appliedSize: assertDecimal(record['appliedSize'], `${field}.appliedSize`),
    appliedTotalCost: assertDecimal(record['appliedTotalCost'], `${field}.appliedTotalCost`),
    createdAt: assertInteger(record['createdAt'], `${field}.createdAt`),
    lastUpdatedAt: assertInteger(record['lastUpdatedAt'], `${field}.lastUpdatedAt`),
  };
}

export function reviveOrderFillProgressList(value: unknown, field = 'progress'): ReadonlyArray<OrderFillProgress> {
  return reviveEach(value, field, reviveOrderFillProgress);
}

/**
 * A broker's own payload, kept verbatim so an execution can be replayed.
 *
 * Only `id` is checked. The rest is whatever the broker sent and is never read
 * generically, so validating it would mean this file having an opinion about a schema
 * that is not ours.
 */
export function reviveBrokerOrderRecord(value: unknown, field = 'record'): BrokerOrderRecord {
  const record = assertRecord(value, field);
  assertNonEmptyString(record['id'], `${field}.id`);
  return { ...record, id: assertNonEmptyString(record['id'], `${field}.id`) };
}

export function reviveBrokerOrderRecords(value: unknown, field = 'records'): ReadonlyArray<BrokerOrderRecord> {
  return reviveEach(value, field, reviveBrokerOrderRecord);
}
