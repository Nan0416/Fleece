/**
 * Placing orders at a broker, in layers. `README.md` has the table and the reasoning.
 *
 *     l3/           signed decimals, handles, event delivery
 *     l2/           claims the order for its virtual account
 *     l1/           encodes that account, sends
 *     alpaca/       the wire: Alpaca's REST and WebSocket clients, models, correlation
 *     reservations/ holds buying power and shares around a placement — not a layer
 */
export * from './create-alpaca-broker-order-client';
export * from './errors';
export * from './l1';
export * from './l2';
export * from './l3';
export * from './reservations';

/**
 * The wire, for the one consumer that wants it without the layers: the tracking process
 * reads the same Alpaca order feed these place orders through.
 *
 * Named rather than `export * from './alpaca'`, because L1 restates four of Alpaca's
 * order-input types — `CreateLimitOrderInput` and friends — one thing wider each. That
 * shadowing is the layer boundary doing its job, and a star export turns it into an
 * ambiguity error. Anything inside the package reaches the wire through `../alpaca`.
 */
export {
  ALPACA_REST_LIVE_URL,
  ALPACA_REST_PAPER_URL,
  ALPACA_WS_LIVE_URL,
  ALPACA_WS_PAPER_URL,
  AlpacaActiveSynchronization,
  HttpAlpacaRestClient,
  WsAlpacaWsClient,
  convertAlpacaOrderToBrokerOrderEvents,
} from './alpaca';
export type { AlpacaAccountIdentifier, AlpacaCredentials, AlpacaOrder, AlpacaWsClient, OrderEventHandler } from './alpaca';
