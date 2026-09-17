/**
 * Runs a program as a job mini-cloud can schedule, reporting its lifecycle to the agent that
 * launched it.
 *
 * The agent spawns a job detached, so it never sees the process end: without an exit report,
 * the instance reads as running long after the process is gone. It stops a job by sending
 * SIGINT to the pid the job reported, so without a pid report there is nothing to stop.
 *
 * The same program still runs by hand. With no agent, `TaskReporter.fromEnvironment()` is
 * `undefined`, nothing is reported, and Ctrl-C keeps Node's default of exiting at once.
 */
import { constants } from 'node:os';

import { TaskReporter } from '@mini-cloud/reporter';

import { LoggerFactory } from './logger';

const logger = LoggerFactory.getLogger('JobRunner');

/** The agent stops a job with SIGINT; SIGTERM is what a machine shutting down sends. */
const STOP_SIGNALS: ReadonlyArray<NodeJS.Signals> = ['SIGINT', 'SIGTERM'];

/** What a run reports through. `TaskReporter` is one, and none of its methods throws. */
export type JobReporter = Pick<TaskReporter, 'start' | 'log' | 'reportExit' | 'reportTermination'>;

/**
 * One run's work, resolving to the exit code: anything but 0 marks the instance failed, and a
 * throw is logged and exits 1. `reporter` is there for the job's own event log entries, and is
 * `undefined` outside mini-cloud.
 */
export type Job = (reporter: JobReporter | undefined) => Promise<number>;

/** What a run needs of `process`. */
export interface JobProcess {
  onSignal(signal: NodeJS.Signals, listener: () => Promise<void>): void;
  /** Sets the code the process ends with once nothing is left to run. */
  setExitCode(code: number): void;
  /** Ends the process now. */
  exit(code: number): void;
}

/** This process. */
export const nodeProcess: JobProcess = {
  onSignal: (signal, listener) => {
    process.on(signal, () => void listener());
  },
  setExitCode: (code) => {
    process.exitCode = code;
  },
  exit: (code) => process.exit(code),
};

/** Runs `job` in this process, reporting to the agent that launched it, if one did. Never rejects. */
export function runJob(job: Job): Promise<void> {
  return new JobRunner(TaskReporter.fromEnvironment(), nodeProcess).run(job);
}

export class JobRunner {
  /**
   * Taken by whichever comes first, finishing or being stopped, so an instance is never
   * reported as both.
   */
  private ending = false;

  constructor(
    private readonly reporter: JobReporter | undefined,
    private readonly host: JobProcess,
  ) {}

  async run(job: Job): Promise<void> {
    if (this.reporter !== undefined) {
      const reporter = this.reporter;
      for (const signal of STOP_SIGNALS) {
        this.host.onSignal(signal, () => this.stop(reporter, signal));
      }
    }

    await this.reporter?.start();
    const code = await job(this.reporter).catch(async (error: unknown) => {
      logger.error('The job failed.', error);
      // The stack is in the log; the console's event log wants the one line.
      await this.reporter?.log('error', { message: error instanceof Error ? error.message : String(error) });
      return 1;
    });
    if (this.ending) {
      return;
    }
    this.ending = true;
    logger.info(`The job finished with exit code ${code}.`);
    await this.reporter?.reportExit(code);
    this.host.setExitCode(code);
  }

  private async stop(reporter: JobReporter, signal: NodeJS.Signals): Promise<void> {
    // Also true while the exit is being reported, which exiting here would cut off.
    if (this.ending) {
      return;
    }
    this.ending = true;
    logger.warn(`Received ${signal}; reporting the termination and exiting.`);
    await reporter.reportTermination();
    // A listener replaces Node's own exit on the signal, so the exit is this one's to make.
    this.host.exit(128 + constants.signals[signal]);
  }
}
