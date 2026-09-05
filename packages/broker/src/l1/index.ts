/**
 * **L1 — an order that says whose it is.**
 *
 * Alpaca's placement API with one field swapped: instead of a raw `client_order_id`, the
 * caller names the virtual account, and the correlation codec turns that into the id.
 * Everything else — unsigned sizes, a `side`, prices as numbers — is the broker's own.
 *
 * `BrokerOrderClient` is the interface L2 also implements, which is what makes L2 a layer
 * you install rather than a step inside this one.
 */
export * from './broker-order-client';
export * from './l1-broker-order-client';
