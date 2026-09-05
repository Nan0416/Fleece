import {
  AccountStatus,
  AccountType,
  AssetClass,
  Broker,
  BrokerOrderAttribution,
  BrokerOrderClass,
  BrokerOrderSide,
  BrokerOrderTimeInForce,
  BrokerOrderType,
  BrokerPositionIntent,
  Decimal,
  DividendStatus,
  InternalServiceError,
  isAssetClass,
  isBrokerOrderAttribution,
} from '@fleece/shared';

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

export function toBroker(value: string, brokerOrderId: string): Broker {
  if (value === 'alpaca' || value === 'traderq') {
    return value;
  }
  throw new InternalServiceError(`Broker order ${brokerOrderId} has unrecognised broker "${value}".`);
}

export function toAssetClass(value: string, context: string): AssetClass {
  if (isAssetClass(value)) {
    return value;
  }
  throw new InternalServiceError(`${context} has unrecognised asset class "${value}".`);
}

export function toBrokerOrderAttribution(value: string, brokerOrderId: string): BrokerOrderAttribution {
  if (isBrokerOrderAttribution(value)) {
    return value;
  }
  throw new InternalServiceError(`Broker order ${brokerOrderId} has unrecognised attribution "${value}".`);
}

export function toBrokerOrderClass(value: string, brokerOrderId: string): BrokerOrderClass {
  if (value === 'regular' || value === 'oco' || value === 'oto' || value === 'bracket' || value === 'mleg') {
    return value;
  }
  throw new InternalServiceError(`Broker order ${brokerOrderId} has unrecognised order class "${value}".`);
}

export function toBrokerOrderType(value: string, brokerOrderId: string): BrokerOrderType {
  if (value === 'market' || value === 'limit' || value === 'stop' || value === 'stop_limit') {
    return value;
  }
  throw new InternalServiceError(`Broker order ${brokerOrderId} has unrecognised order type "${value}".`);
}

export function toBrokerOrderSide(value: string | null, brokerOrderId: string): BrokerOrderSide | undefined {
  if (value === null) {
    return undefined;
  }
  if (value === 'buy' || value === 'sell') {
    return value;
  }
  throw new InternalServiceError(`Broker order ${brokerOrderId} has unrecognised side "${value}".`);
}

export function toBrokerOrderTimeInForce(value: string, brokerOrderId: string): BrokerOrderTimeInForce {
  if (value === 'day' || value === 'gtc' || value === 'opg' || value === 'cls' || value === 'ioc' || value === 'fok') {
    return value;
  }
  throw new InternalServiceError(`Broker order ${brokerOrderId} has unrecognised time in force "${value}".`);
}

export function toBrokerPositionIntent(value: string | null, brokerOrderId: string): BrokerPositionIntent | undefined {
  if (value === null) {
    return undefined;
  }
  if (value === 'buy_to_open' || value === 'buy_to_close' || value === 'sell_to_open' || value === 'sell_to_close') {
    return value;
  }
  throw new InternalServiceError(`Broker order ${brokerOrderId} has unrecognised position intent "${value}".`);
}

/**
 * A `NUMERIC` column.
 *
 * node-postgres hands `NUMERIC` back as a **string** rather than a number, precisely so
 * that nothing is lost on the way — which is the whole reason these columns are
 * `NUMERIC` and this function takes a string. Anything else means the column type and
 * the parser have diverged, and reading it as a number would silently reintroduce the
 * floating-point error the schema exists to avoid.
 */
export function toDecimal(value: string, context: string): Decimal {
  return Decimal.parse(value, context);
}

/** A nullable `NUMERIC` column. */
export function toOptionalDecimal(value: string | null, context: string): Decimal | undefined {
  return value === null ? undefined : Decimal.parse(value, context);
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
