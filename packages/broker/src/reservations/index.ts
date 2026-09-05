/**
 * **Not a layer.** The bookkeeping that keeps concurrent strategies from oversubscribing
 * one real broker account: a hold taken before a request goes out, released when it fails
 * or consumed when it fills.
 *
 * It sits beside the layers rather than among them because L3 works with or without it,
 * and because it is where the two things nobody can price today are refused: a short
 * option, whose requirement is margin against an unbounded loss, and a spread, whose
 * requirement is the width rather than the sum of its legs.
 */
export * from './account-broker-tracker';
export * from './account-reservations';
export * from './buying-power';
export * from './symbol-position-tracker';
export * from './trackers';
export * from './utils';
