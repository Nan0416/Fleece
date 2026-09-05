/**
 * **L2 — a claim that the order belongs to that account.**
 *
 * Wraps L1 and, after a successful placement, tells the tracking service which virtual
 * account every id the placement produced belongs to. Same interface as L1, so a process
 * with no tracking service simply does not install this layer — see
 * `createAlpacaBrokerOrderClient`.
 */
export * from './l2-broker-order-client';
