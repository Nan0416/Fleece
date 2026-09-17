/**
 * Reads an account's option positions, works out which strategies they make, has each check
 * itself against its closing rules, and tells its notifier what it found. It only reads:
 * acting on a signal is left to a person.
 */
import type { AlpacaRestClient } from '@fleece/broker';
import { easternClock, LoggerFactory } from '@fleece/utilities';

import type { Notifier } from './notifier';
import { Positions, type OptionLeg } from './positions';
import { reportLines } from './report-lines';
import type { Strategy, StrategyEvaluation } from './strategies';
import type { ChainedStrategyDetector } from './strategy-detectors';

const logger = LoggerFactory.getLogger('PositionMonitor');

export interface StrategyFailure {
  readonly strategy: Strategy;
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

/** What a run tells its notifier: a report, or why there is none. */
export type PositionMonitorOutcome = CompletedRun | FailedRun;

export interface CompletedRun {
  readonly kind: 'completed';
  readonly report: PositionMonitorReport;
}

/** A run that stopped before it had a report, such as when the positions could not be read. */
export interface FailedRun {
  readonly kind: 'failed';
  /** When the run started, epoch ms. */
  readonly at: number;
  readonly error: unknown;
}

export class PositionMonitor {
  constructor(
    readonly alpacaTradingClient: Pick<AlpacaRestClient, 'listPositions'>,
    readonly strategyDetector: ChainedStrategyDetector,
    readonly notifier: Notifier,
  ) {}

  /**
   * Checks the account, prints the report to stdout and hands the outcome to the notifier.
   * Throws only when the notifier could not deliver it: a failed check is an outcome, not a
   * throw, because a monitor that stopped is as much news as a signal.
   */
  async run(now: number = Date.now()): Promise<PositionMonitorOutcome> {
    const outcome = await this.check(now);
    if (outcome.kind === 'completed') {
      console.log(reportLines(outcome.report).join('\n'));
    }
    await this.notifier.notify(outcome);
    return outcome;
  }

  private async check(now: number): Promise<PositionMonitorOutcome> {
    try {
      const report = await this.report(now);
      for (const failure of report.failures) {
        logger.error(`Could not evaluate ${failure.strategy.describe()}.`, failure.error);
      }
      return { kind: 'completed', report };
    } catch (error) {
      logger.error('The position monitor run failed.', error);
      return { kind: 'failed', at: now, error };
    }
  }

  /** `now` decides only what today is; each strategy reads its quotes as of its own call. */
  private async report(now: number): Promise<PositionMonitorReport> {
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
        failures.push({ strategy, error });
      }
    }

    return { at: now, evaluations, failures, unmatched: positions.legs };
  }
}
