/**
 * The decisions the sell-put strategy makes, with no market data, clock or account behind
 * them, so each rule can be checked against numbers written by hand.
 */
import type { OccSymbol } from '@fleece/marketdata';
import { Decimal } from '@fleece/utilities';

import type { DaysToExpirationWindow } from '../utils/option-selection';

/** The expiration sold into: the one nearest 45 days out, and nothing outside 40 to 50. */
export const ENTRY_DTE: DaysToExpirationWindow = { target: 45, min: 40, max: 50 };

/**
 * The put sold: nearest 0.20 delta, and nothing outside 0.15 to 0.25. The band is what
 * makes "nearest" safe — on a day the chain has no strike near the target, the nearest one
 * can be a 0.35 delta that is a different trade altogether.
 */
export const ENTRY_DELTA = { target: 0.2, min: 0.15, max: 0.25 } as const;

/** Close once half the credit is kept. */
export const TAKE_PROFIT_FRACTION = Decimal.of('0.5');

/** Close once the loss reaches twice the credit, which is buying back at three times it. */
export const STOP_LOSS_MULTIPLE = Decimal.of(2);

/**
 * Close with 21 days left whatever the price. Past it gamma grows faster than theta, so
 * each remaining dollar of decay is bought with more exposure to a move — and the backtest
 * account cannot assign, so a put held to expiry would settle at a price nothing traded.
 */
export const EXIT_DTE = 21;

export type ExitReason = 'stop-loss' | 'take-profit' | 'dte';

export interface PutCandidate {
  readonly occSymbol: OccSymbol;
  /** Negative, as a put's is. */
  readonly delta: number;
}

export interface ExitCheck {
  /** Per share, what the put was sold for after costs. */
  readonly credit: Decimal;
  /** Per share, what buying it back would cost now, after costs. */
  readonly debit: Decimal;
  readonly daysToExpiration: number;
}

/**
 * The share of `history` strictly below `current`, in percent: 0 is the lowest volatility
 * of the lookback, and 100 is higher than every day in it.
 *
 * A percentile rather than a rank because a rank measures against the range's two ends,
 * so one spike sets the ceiling for a whole lookback: after April 2025 an ordinary high
 * reads as a low rank for a year. A percentile counts days, and one day is one day.
 *
 * `undefined` for no history, which is no statement about where today sits.
 */
export function ivPercentile(history: ReadonlyArray<number>, current: number): number | undefined {
  if (history.length === 0) {
    return undefined;
  }
  return (100 * history.filter((value) => value < current).length) / history.length;
}

/**
 * The candidate whose delta is nearest the target, among those inside the band. Of two
 * equally near, the lower strike: further from the money for the same delta distance.
 */
export function choosePut<T extends PutCandidate>(candidates: ReadonlyArray<T>): T | undefined {
  let chosen: T | undefined;
  for (const candidate of candidates) {
    const size = Math.abs(candidate.delta);
    if (candidate.occSymbol.type !== 'put' || size < ENTRY_DELTA.min || size > ENTRY_DELTA.max) {
      continue;
    }
    if (chosen === undefined) {
      chosen = candidate;
      continue;
    }
    const distance = Math.abs(size - ENTRY_DELTA.target) - Math.abs(Math.abs(chosen.delta) - ENTRY_DELTA.target);
    if (distance < 0 || (distance === 0 && candidate.occSymbol.strikeMils < chosen.occSymbol.strikeMils)) {
      chosen = candidate;
    }
  }
  return chosen;
}

/**
 * Why to close now, or `undefined` to hold. The stop is checked first: a position that has
 * lost twice its credit is closed as a loss even on the day it also reaches 21 days.
 *
 * Both price rules read the debit after costs, which is what closing would actually take.
 */
export function exitReason(check: ExitCheck): ExitReason | undefined {
  const { credit, debit } = check;
  if (debit.sub(credit).gte(credit.mul(STOP_LOSS_MULTIPLE))) {
    return 'stop-loss';
  }
  if (credit.sub(debit).gte(credit.mul(TAKE_PROFIT_FRACTION))) {
    return 'take-profit';
  }
  if (check.daysToExpiration <= EXIT_DTE) {
    return 'dte';
  }
  return undefined;
}
