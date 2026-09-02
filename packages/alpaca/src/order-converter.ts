import {
  BrokerOrderClass,
  BrokerOrderEvent,
  InternalServiceError,
  LimitBrokerOrderEvent,
  MarketBrokerOrderEvent,
  StopBrokerOrderEvent,
  StopLimitBrokerOrderEvent,
} from '@fleece/shared';
import { AlpacaOrderCorrelation, decodeAlpacaOrderCorrelation } from './correlation';
import { AlpacaAccountIdentifier, AlpacaOrder } from './models';

/**
 * The one place Alpaca's wire format becomes the ledger's vocabulary.
 *
 * Two things happen here that matter downstream. Quantities become signed — Alpaca
 * reports an absolute quantity plus a `side`, while the accounting works in signed
 * sizes throughout — and the order's correlation is decoded out of `client_order_id`,
 * which is what attributes the fill to a virtual account.
 */
export function convertAlpacaOrderToBrokerOrderEvent(order: AlpacaOrder, account: AlpacaAccountIdentifier): BrokerOrderEvent {
  return convert(order, account, decodeAlpacaOrderCorrelation(order.client_order_id));
}

function convert(order: AlpacaOrder, account: AlpacaAccountIdentifier, correlation: AlpacaOrderCorrelation): BrokerOrderEvent {
  switch (order.order_type) {
    case 'market':
      return toMarketEvent(order, account, correlation);
    case 'limit':
      return toLimitEvent(order, account, correlation);
    case 'stop':
      return toStopEvent(order, account, correlation);
    case 'stop_limit':
      return toStopLimitEvent(order, account, correlation);
    default:
      throw new InternalServiceError(`Alpaca order ${order.id} has unrecognised order_type "${order.order_type}".`);
  }
}

function toMarketEvent(order: AlpacaOrder, account: AlpacaAccountIdentifier, correlation: AlpacaOrderCorrelation): MarketBrokerOrderEvent {
  const absoluteQty = strictParseFloat(order.qty, `order ${order.id} qty`);
  const absoluteFilledQty = strictParseFloat(order.filled_qty, `order ${order.id} filled_qty`);
  const sign = order.side === 'buy' ? 1 : -1;

  return {
    orderType: 'market',
    broker: 'alpaca',
    brokerAccountId: account.accountId,
    live: account.live,
    id: order.id,
    correlationId: order.client_order_id,
    accountId: correlation.virtualAccountId,
    groupId: correlation.groupId,
    reservationId: correlation.reservationId,

    replacedBy: order.replaced_by === null ? undefined : order.replaced_by,
    replaces: order.replaces === null ? undefined : order.replaces,
    status: order.status,

    symbol: order.symbol,

    timeInForce: order.time_in_force,
    // Alpaca sends an empty string for a plain order rather than omitting the field.
    orderClass: toOrderClass(order.order_class),

    side: order.side,
    extendedHours: order.extended_hours,
    limitPrice: undefined,
    stopPrice: undefined,
    qty: sign * absoluteQty,
    filledQty: sign * absoluteFilledQty,
    filledAvgPrice: order.filled_avg_price === null ? undefined : strictParseFloat(order.filled_avg_price, `order ${order.id} filled_avg_price`),

    createdAt: strictParseDate(order.created_at, `order ${order.id} created_at`),
    updatedAt: strictParseDate(order.updated_at, `order ${order.id} updated_at`),
    filledAt: optionalDate(order.filled_at),
    expiredAt: optionalDate(order.expired_at),
    canceledAt: optionalDate(order.canceled_at),
    failedAt: optionalDate(order.failed_at),
    replacedAt: optionalDate(order.replaced_at),
    legs: order.legs === null ? undefined : order.legs.map((leg) => convert(leg, account, correlation)),
  };
}

function toLimitEvent(order: AlpacaOrder, account: AlpacaAccountIdentifier, correlation: AlpacaOrderCorrelation): LimitBrokerOrderEvent {
  return {
    ...toMarketEvent(order, account, correlation),
    orderType: 'limit',
    limitPrice: requirePrice(order.limit_price, `order ${order.id} limit_price`),
    stopPrice: undefined,
  };
}

function toStopEvent(order: AlpacaOrder, account: AlpacaAccountIdentifier, correlation: AlpacaOrderCorrelation): StopBrokerOrderEvent {
  return {
    ...toMarketEvent(order, account, correlation),
    orderType: 'stop',
    limitPrice: undefined,
    stopPrice: requirePrice(order.stop_price, `order ${order.id} stop_price`),
  };
}

function toStopLimitEvent(order: AlpacaOrder, account: AlpacaAccountIdentifier, correlation: AlpacaOrderCorrelation): StopLimitBrokerOrderEvent {
  return {
    ...toMarketEvent(order, account, correlation),
    orderType: 'stop_limit',
    limitPrice: requirePrice(order.limit_price, `order ${order.id} limit_price`),
    stopPrice: requirePrice(order.stop_price, `order ${order.id} stop_price`),
  };
}

function toOrderClass(value: AlpacaOrder['order_class']): BrokerOrderClass {
  return value === '' ? 'regular' : value;
}

function strictParseFloat(value: string, field: string): number {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new InternalServiceError(`Alpaca sent "${value}" for ${field}, which is not a number.`);
  }
  return parsed;
}

function requirePrice(value: string | null, field: string): number {
  if (value === null) {
    throw new InternalServiceError(`Alpaca sent no ${field}, but the order type requires one.`);
  }
  return strictParseFloat(value, field);
}

function strictParseDate(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new InternalServiceError(`Alpaca sent "${value}" for ${field}, which is not a timestamp.`);
  }
  return parsed;
}

function optionalDate(value: string | null | undefined): number | undefined {
  return typeof value === 'string' ? Date.parse(value) : undefined;
}
