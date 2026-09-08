import { easternClock } from '@fleece/shared';

import type { StockSplit } from './data-models';

/**
 * Restating a price in today's shares.
 *
 * Bars carry this on the request — both providers adjust their own aggregates — but
 * trades and quotes do not: Polygon's v3 endpoints have no adjustment parameter, and
 * Alpaca's reject one outright. So a caller asking for adjusted prints is asking this
 * code to do the arithmetic, and both clients have to do it the same way or the same
 * request answers differently depending on which provider served it.
 */
export interface SplitRatio {
  readonly ratio: number;
  /** The instant the split took effect; prices before it need restating. */
  readonly before: number;
}

export function splitRatios(splits: ReadonlyArray<StockSplit>): ReadonlyArray<SplitRatio> {
  return splits.map((split) => ({
    // A one-for-four split makes a share worth a quarter of what it was, so a price from
    // before it is multiplied by from/to to be comparable with prices after.
    ratio: split.splitFrom / split.splitTo,
    before: easternClock.timestamp(split.executionDate, '00:00:00'),
  }));
}

export function adjustPrice(price: number, timestamp: number, ratios: ReadonlyArray<SplitRatio>): number {
  return ratios.reduce((adjusted, split) => (timestamp < split.before ? adjusted * split.ratio : adjusted), price);
}
