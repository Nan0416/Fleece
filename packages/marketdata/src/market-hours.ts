import { easternClock } from '@fleece/shared';

import type { MarketSession } from './equity-data-models';

import rawMarketHours from './market-hours-data.json';

/**
 * A stored session, which is a calendar session plus where it sits in the table — so
 * whatever refreshes the file produces exactly what the file holds.
 */
export interface MarketHour extends MarketSession {
  readonly index: number;
}

export type MarketState = 'closed' | 'pre_market' | 'open' | 'after_market';

export interface MarketHoursCoverage {
  readonly from: string;
  readonly to: string;
}

const marketHours: ReadonlyArray<MarketHour> = rawMarketHours.map((datum, index) => ({ ...datum, index }));

const byDate = new Map<string, MarketHour>(marketHours.map((hour) => [hour.date, hour]));

/**
 * The table is a fixed list of sessions, not a rule, so every date outside it reads as
 * closed rather than as an error. Check this before trusting a `closed` on a recent date.
 */
export const marketHoursCoverage: MarketHoursCoverage = {
  from: marketHours[0].date,
  to: marketHours[marketHours.length - 1].date,
};

interface EasternDay {
  readonly date: string;
  readonly from: number;
  readonly to: number;
}

// Callers walk a series of bars or trades in order, so consecutive lookups land on the
// same day and skip the conversion.
let cachedDay: EasternDay | undefined = undefined;

function easternDateOf(timestamp: number): string {
  if (cachedDay !== undefined && timestamp >= cachedDay.from && timestamp < cachedDay.to) {
    return cachedDay.date;
  }
  const date = easternClock.date(timestamp);
  cachedDay = {
    date,
    from: easternClock.timestamp(date, '00:00:00'),
    to: easternClock.timestamp(date, '23:59:59') + 1000,
  };
  return date;
}

export function marketState(timestamp: number = Date.now()): MarketState {
  const hour = byDate.get(easternDateOf(timestamp));
  if (hour === undefined || timestamp < hour.preMarketOpenAt) {
    return 'closed';
  }
  if (timestamp < hour.openAt) {
    return 'pre_market';
  }
  if (timestamp < hour.closeAt) {
    return 'open';
  }
  if (timestamp < hour.afterMarketCloseAt) {
    return 'after_market';
  }
  return 'closed';
}

export function isTradingDay(date: string): boolean {
  return byDate.has(date);
}

export function marketHour(dateOrTimestamp: string | number = Date.now()): MarketHour | undefined {
  return byDate.get(typeof dateOrTimestamp === 'string' ? dateOrTimestamp : easternDateOf(dateOrTimestamp));
}

/** The `index` on a `MarketHour`, so a caller can step to the previous or next session. */
export function marketHourByIndex(index: number): MarketHour | undefined {
  return index >= 0 && index < marketHours.length ? marketHours[index] : undefined;
}
