import { MultiLegOrderObj, OtoOrderObj, SingleOrderObj } from './order-obj';
import { LimitOrderRequest, MarketOrderRequest, MultiLegOrderRequest, OtoRequest } from './requests';
import { BrokerTracker } from './trackers';

export interface Asset {
  readonly symbol: string;
  readonly tradable: boolean;
  readonly marginable: boolean;
  readonly shortable: boolean;
  readonly lastUpdatedAt: number;
}

/**
 * **L3**: places orders at one broker account and hands back a live handle on each.
 *
 * Three responsibilities beyond "send the order": hold the buying power or shares before
 * the request goes out, deliver every event back to whoever placed it, and keep the
 * broker's own view of the account current as fills arrive.
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

  /** Undefined when nothing is held against placements. See `AccountReservations`. */
  readonly tracker: BrokerTracker | undefined;

  init(): Promise<void>;
  terminate(): Promise<void>;

  asset(symbol: string): Promise<Asset | undefined>;

  order(request: MarketOrderRequest): Promise<SingleOrderObj>;
  order(request: LimitOrderRequest): Promise<SingleOrderObj>;
  order(request: OtoRequest): Promise<OtoOrderObj>;
  order(request: MultiLegOrderRequest): Promise<MultiLegOrderObj>;
}
