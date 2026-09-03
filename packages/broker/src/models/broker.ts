import { LimitOrderRequest, MarketOrderRequest, OtoRequest } from './requests';
import { OrderObj, OtoOrderObj } from './order-obj';
import { BrokerTracker } from './trackers';

export interface Asset {
  readonly symbol: string;
  readonly tradable: boolean;
  readonly marginable: boolean;
  readonly shortable: boolean;
  readonly lastUpdatedAt: number;
}

/**
 * Places orders at one broker account, and owns the bookkeeping that makes doing so
 * safely possible.
 *
 * Three responsibilities beyond "send the order": reserve the buying power or shares
 * before the request goes out, hand every event back to whoever placed the order, and
 * tell the ledger which virtual account and group the resulting broker orders belong
 * to.
 *
 * The legacy `Broker` interface also declared `oco` and `otoco` overloads. Neither was
 * ever implemented — `AlpacaBroker` had methods for `market`, `limit` and `oto` only —
 * so they are not declared here. An interface whose implementation throws is worse than
 * one that does not offer the method.
 */
export interface Broker {
  readonly brokerAccountId: string;
  readonly live: boolean;
  readonly source: string;

  readonly tracker: BrokerTracker;

  init(): Promise<void>;
  terminate(): Promise<void>;

  asset(symbol: string): Promise<Asset | undefined>;

  order(request: MarketOrderRequest): Promise<OrderObj>;
  order(request: LimitOrderRequest): Promise<OrderObj>;
  order(request: OtoRequest): Promise<OtoOrderObj>;
}
