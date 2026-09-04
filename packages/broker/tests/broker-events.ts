import { MarketBrokerOrderEvent } from '@fleece/shared';

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
    qty: 10,
    filledQty: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}
