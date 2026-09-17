/**
 * Reads an account's option positions, works out which strategies they make, and has each
 * check itself against its closing rules. It only reads: acting on a signal is left to a
 * person.
 */
import type { AlpacaRestClient } from '@fleece/broker';
import { easternClock } from '@fleece/utilities';

import { Positions, type OptionLeg } from './positions';
import type { StrategyEvaluation } from './strategies';
import type { ChainedStrategyDetector } from './strategy-detectors';

export interface StrategyFailure {
  /** As `Strategy.describe` names it. */
  readonly strategy: string;
  readonly error: unknown;
}

export interface PositionMonitorReport {
  /** When the run started, epoch ms. */
  readonly at: number;
  readonly evaluations: ReadonlyArray<StrategyEvaluation>;
  /** Strategies that could not evaluate themselves, usually for want of a quote request. */
  readonly failures: ReadonlyArray<StrategyFailure>;
  /** Option legs no detector claimed: a naked short, a lone long, an adjusted contract. */
  readonly unmatched: ReadonlyArray<OptionLeg>;
}

export class PositionMonitor {
  constructor(
    readonly alpacaTradingClient: Pick<AlpacaRestClient, 'listPositions'>,
    readonly strategyDetector: ChainedStrategyDetector,
  ) {}

  /** `now` decides only what today is; each strategy reads its quotes as of its own call. */
  async run(now: number = Date.now()): Promise<PositionMonitorReport> {
    const { positions: alpacaPositions } = await this.alpacaTradingClient.listPositions();
    const positions = Positions.fromAlpacaPositions(alpacaPositions);
    // Takes each strategy's legs out of `positions`, which leaves the unmatched ones.
    const strategies = this.strategyDetector.detect(positions);
    const today = easternClock.date(now);

    const evaluations: StrategyEvaluation[] = [];
    const failures: StrategyFailure[] = [];
    for (const strategy of strategies) {
      // One spread's failed request must not keep the others' signals from being reported.
      try {
        evaluations.push(await strategy.evaluate(today));
      } catch (error) {
        failures.push({ strategy: strategy.describe(), error });
      }
    }

    return { at: now, evaluations, failures, unmatched: positions.legs };
  }
}
