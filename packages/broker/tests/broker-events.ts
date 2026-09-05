import { Decimal, MarketBrokerOrderEvent } from '@fleece/shared';

/** A broker order event, market-shaped; the trackers never branch on order type. */
export function brokerEvent(overrides: Partial<MarketBrokerOrderEvent> = {}): MarketBrokerOrderEvent {
  return {
    orderType: 'market',
    broker: 'alpaca',
    brokerAccountId: 'PAPER001',
    live: false,
    id: 'order-1',
    status: 'new',
    symbol: 'AAPL',
    assetClass: 'equity',
    timeInForce: 'day',
    orderClass: 'regular',
    side: 'buy',
    extendedHours: false,
    limitPrice: undefined,
    stopPrice: undefined,
    qty: Decimal.of(10),
    filledQty: Decimal.ZERO,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

/** Two contracts of a spread's short leg, as the converter emits one. */
export function optionEvent(overrides: Partial<MarketBrokerOrderEvent> = {}): MarketBrokerOrderEvent {
  return brokerEvent({ symbol: 'AMZN261016C00280000', assetClass: 'option', qty: Decimal.of(2), ...overrides });
}
