import {
  AssetClass,
  BrokerOrderClass,
  BrokerOrderEvent,
  BrokerOrderSide,
  BrokerPositionIntent,
  Decimal,
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
 * Three things happen here that matter downstream. Quantities become signed — Alpaca
 * reports an absolute quantity plus a `side`, while the accounting works in signed
 * sizes throughout. The order's correlation is decoded out of `client_order_id`, which
 * is what attributes the fill to a virtual account. And a composite order is
 * **flattened**: one Alpaca payload becomes one event per order it describes, each leg
 * naming its parent in `parentBrokerOrderId`.
 *
 * Flattening is why this returns a list. A leg is a real order at the broker, with its
 * own id, instrument, status and fills, and nesting it inside its parent left it with
 * no `broker_order` row — so an option fill wrote a `ledger_transaction.reference_id`
 * pointing at an order the ledger held nothing for.
 *
 * **Every order in the payload becomes an event, the parent included.** A spread's
 * parent trades no instrument — no symbol, no side, and a price that is the package's
 * signed net rather than anything a contract traded at — so it is a container that books
 * no fill. It is still converted, because it is the id everything upstream holds: what
 * a placement returns, what a cancel names, what a tracking request claims. Discarding
 * it left those pointing at a row that did not exist, and left the spread's net price —
 * the number it was actually traded at — recorded nowhere.
 *
 * The parent comes first, so its row exists before the legs that name it.
 *
 * **Every leg inherits the parent's correlation**, so a leg is booked to the account
 * and reservation encoded in the parent's client order id. Alpaca assigns legs
 * client order ids of its own, so there is nothing else to attribute them from. For a
 * spread this is exactly right — the legs are the spread and cannot be traded apart
 * from it. For a bracket or an OTO it is a judgement rather than a fact, and it
 * supersedes the tracking-request path described in `md/OPEN-ITEMS.md` item 1 for any
 * leg that arrives nested.
 */
export function convertAlpacaOrderToBrokerOrderEvents(order: AlpacaOrder, account: AlpacaAccountIdentifier): ReadonlyArray<BrokerOrderEvent> {
  // Decoded once, from the top-level order: it is the only payload carrying a client
  // order id we set.
  const correlation = decodeAlpacaOrderCorrelation(order.client_order_id);
  const legs = order.legs ?? [];

  if (isMultiLegParent(order)) {
    if (legs.length === 0) {
      // Refused rather than returned empty. An empty list means "this order did
      // nothing", and a spread whose legs are missing is not that — it is a fill we
      // cannot see. Alpaca omits `legs` unless `nested=true` is asked for, so the usual
      // cause is a request that forgot it, and the usual symptom would be every
      // backfilled spread silently disappearing.
      throw new InternalServiceError(
        `Alpaca reported multi-leg order ${order.id} as ${order.status} with no legs, so there is nothing to book. Check that the request asked for nested=true.`,
      );
    }
    return [convert(order, account, correlation), ...legs.map((leg) => convert(leg, account, correlation, order.id))];
  }

  return [convert(order, account, correlation), ...legs.map((leg) => convert(leg, account, correlation, order.id))];
}

/**
 * Whether this is the container of a spread rather than one of its contracts.
 *
 * The parent and its legs both carry `order_class: 'mleg'`, so the class alone cannot
 * separate them. The empty symbol can: Alpaca leaves the parent's blank because the
 * spread trades no instrument of its own. This is the last place that empty string is
 * read as a value — every event this converter emits carries `undefined` instead.
 */
function isMultiLegParent(order: AlpacaOrder): boolean {
  return order.order_class === 'mleg' && order.symbol === '';
}

/** A single contract inside a spread. It has an instrument and a side; it has no price. */
function isMultiLegLeg(order: AlpacaOrder): boolean {
  return order.order_class === 'mleg' && order.symbol !== '';
}

function convert(order: AlpacaOrder, account: AlpacaAccountIdentifier, correlation: AlpacaOrderCorrelation, parentBrokerOrderId?: string): BrokerOrderEvent {
  switch (order.order_type) {
    case 'market':
      return toMarketEvent(order, account, correlation, parentBrokerOrderId);
    case 'limit':
      return toLimitEvent(order, account, correlation, parentBrokerOrderId);
    case 'stop':
      return toStopEvent(order, account, correlation, parentBrokerOrderId);
    case 'stop_limit':
      return toStopLimitEvent(order, account, correlation, parentBrokerOrderId);
    default:
      throw new InternalServiceError(`Alpaca order ${order.id} has unrecognised order_type "${String(order.order_type)}".`);
  }
}

function toMarketEvent(order: AlpacaOrder, account: AlpacaAccountIdentifier, correlation: AlpacaOrderCorrelation, parentBrokerOrderId?: string): MarketBrokerOrderEvent {
  const { side, sell } = toDirection(order);
  // Alpaca reports a magnitude plus a side; the accounting works in signed sizes.
  const signed = (value: Decimal): Decimal => (sell ? value.neg() : value);
  const absoluteQty = strictParseDecimal(order.qty, `order ${order.id} qty`);
  const absoluteFilledQty = strictParseDecimal(order.filled_qty, `order ${order.id} filled_qty`);

  return {
    orderType: 'market',
    broker: 'alpaca',
    brokerAccountId: account.accountId,
    live: account.live,
    id: order.id,
    parentBrokerOrderId,
    correlationId: order.client_order_id,
    accountId: correlation.virtualAccountId,
    reservationId: correlation.reservationId,

    replacedBy: order.replaced_by === null ? undefined : order.replaced_by,
    replaces: order.replaces === null ? undefined : order.replaces,
    status: order.status,

    // Alpaca leaves a spread parent's symbol empty. The sentinel is converted away
    // here and nowhere else: downstream a missing instrument is `undefined`, which the
    // compiler makes every reader account for.
    symbol: isMultiLegParent(order) ? undefined : order.symbol,
    assetClass: alpacaOrderAssetClass(order),

    timeInForce: order.time_in_force,
    // Alpaca sends an empty string for a plain order rather than omitting the field.
    orderClass: toOrderClass(order.order_class),

    side,
    positionIntent: toPositionIntent(order),
    ratioQty: order.ratio_qty === undefined || order.ratio_qty === null ? undefined : strictParseDecimal(order.ratio_qty, `order ${order.id} ratio_qty`),
    extendedHours: order.extended_hours,
    limitPrice: undefined,
    stopPrice: undefined,
    qty: signed(absoluteQty),
    filledQty: signed(absoluteFilledQty),
    filledAvgPrice: order.filled_avg_price === null ? undefined : strictParseDecimal(order.filled_avg_price, `order ${order.id} filled_avg_price`),

    createdAt: strictParseDate(order.created_at, `order ${order.id} created_at`),
    updatedAt: strictParseDate(order.updated_at, `order ${order.id} updated_at`),
    filledAt: optionalDate(order.filled_at),
    expiredAt: optionalDate(order.expired_at),
    canceledAt: optionalDate(order.canceled_at),
    failedAt: optionalDate(order.failed_at),
    replacedAt: optionalDate(order.replaced_at),
  };
}

function toLimitEvent(order: AlpacaOrder, account: AlpacaAccountIdentifier, correlation: AlpacaOrderCorrelation, parentBrokerOrderId?: string): LimitBrokerOrderEvent {
  return {
    ...toMarketEvent(order, account, correlation, parentBrokerOrderId),
    orderType: 'limit',
    // A leg of a spread carries `order_type: 'limit'` and a null `limit_price`: the
    // price belongs to the spread, and is on the parent. Demanding one here would throw
    // on every multi-leg fill, and the injector would log and drop the whole event.
    limitPrice: isMultiLegLeg(order) ? undefined : requirePrice(order.limit_price, `order ${order.id} limit_price`),
    stopPrice: undefined,
  };
}

function toStopEvent(order: AlpacaOrder, account: AlpacaAccountIdentifier, correlation: AlpacaOrderCorrelation, parentBrokerOrderId?: string): StopBrokerOrderEvent {
  return {
    ...toMarketEvent(order, account, correlation, parentBrokerOrderId),
    orderType: 'stop',
    limitPrice: undefined,
    stopPrice: requirePrice(order.stop_price, `order ${order.id} stop_price`),
  };
}

function toStopLimitEvent(order: AlpacaOrder, account: AlpacaAccountIdentifier, correlation: AlpacaOrderCorrelation, parentBrokerOrderId?: string): StopLimitBrokerOrderEvent {
  return {
    ...toMarketEvent(order, account, correlation, parentBrokerOrderId),
    orderType: 'stop_limit',
    limitPrice: requirePrice(order.limit_price, `order ${order.id} limit_price`),
    stopPrice: requirePrice(order.stop_price, `order ${order.id} stop_price`),
  };
}

interface OrderDirection {
  /** Undefined for a spread, which has no direction of its own. */
  readonly side: BrokerOrderSide | undefined;
  /** Whether to negate Alpaca's magnitude. False where there is no direction. */
  readonly sell: boolean;
}

/**
 * A spread has no side, and Alpaca does not say so consistently: the REST response
 * gives `''` and the websocket gives `'buy'` for the very same order. Trusting either
 * would sign the parent's quantity from a value that means nothing.
 *
 * Anything else with no side is a fault rather than a spread, and is refused instead of
 * defaulting to a sell — which is what an untested `order.side === 'buy' ? 1 : -1` did,
 * turning an empty side into a negative position.
 */
function toDirection(order: AlpacaOrder): OrderDirection {
  if (isMultiLegParent(order)) {
    return { side: undefined, sell: false };
  }
  if (order.side !== 'buy' && order.side !== 'sell') {
    throw new InternalServiceError(`Alpaca order ${order.id} has side "${order.side}" and is not a multi-leg parent, so its direction cannot be established.`);
  }
  return { side: order.side, sell: order.side === 'sell' };
}

/**
 * Alpaca's asset class as Fleece's.
 *
 * Exported because `@fleece/broker` needs the same answer when it seeds its reservation
 * tracker from open orders: what an order holds against the account depends on whether
 * a unit is a share or a claim on a hundred of them, and a second copy of this mapping
 * is a second place for that to be decided differently.
 */
export function alpacaOrderAssetClass(order: AlpacaOrder): AssetClass {
  switch (order.asset_class) {
    case 'us_equity':
      return 'equity';
    case 'us_option':
      return 'option';
    case 'crypto':
      return 'crypto';
    case '':
      // Empty on a multi-leg parent, which trades nothing itself. It takes its first
      // leg's class so the field is never a lie — nothing books against the parent, so
      // the multiplier this feeds is only ever read off the legs.
      return order.legs === null || order.legs[0] === undefined ? 'option' : alpacaOrderAssetClass(order.legs[0]);
    default:
      throw new InternalServiceError(`Alpaca order ${order.id} has unrecognised asset_class "${String(order.asset_class)}".`);
  }
}

function toOrderClass(value: AlpacaOrder['order_class']): BrokerOrderClass {
  // Alpaca calls a plain order both '' and 'simple', depending on where you read.
  return value === '' || value === 'simple' ? 'regular' : value;
}

function toPositionIntent(order: AlpacaOrder): BrokerPositionIntent | undefined {
  // '' is what the websocket sends on a multi-leg parent; REST omits the field there.
  return order.position_intent === undefined || order.position_intent === '' ? undefined : order.position_intent;
}

/**
 * Alpaca sends every quantity and price as a **string**, and this is where they become
 * numbers. Parsing straight into `Decimal` rather than through `Number` is not a
 * translation of the old behaviour but a strict improvement on it: a decimal string
 * converts to a decimal exactly, where converting it to a double loses whatever the
 * double cannot represent — before the ledger ever sees it.
 */
function strictParseDecimal(value: string, field: string): Decimal {
  try {
    return Decimal.of(value);
  } catch {
    throw new InternalServiceError(`Alpaca sent "${value}" for ${field}, which is not a number.`);
  }
}

function requirePrice(value: string | null, field: string): Decimal {
  if (value === null) {
    throw new InternalServiceError(`Alpaca sent no ${field}, but the order type requires one.`);
  }
  return strictParseDecimal(value, field);
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
