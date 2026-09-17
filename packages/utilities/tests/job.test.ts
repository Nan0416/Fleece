import { JobRunner, nodeProcess, runJob, type JobProcess, type JobReporter } from '../src/job';

/**
 * A mini-cloud agent spawns a job detached and never sees it end, so what the job reports is
 * all it knows: a missing exit leaves the instance running forever, and a job reported both
 * exited and terminated is one whose end the console cannot tell.
 */

/** Stores every report in order. `exitGate`, when set, holds `reportExit` open, as a slow agent would. */
class FakeReporter implements JobReporter {
  readonly reports: string[] = [];
  exitGate?: Promise<void>;

  async start(): Promise<void> {
    this.reports.push('start');
  }

  async log(level: string, payload: unknown): Promise<void> {
    this.reports.push(`log ${level} ${JSON.stringify(payload)}`);
  }

  async reportExit(code: number = 0): Promise<void> {
    this.reports.push(`exit ${code}`);
    await this.exitGate;
  }

  async reportTermination(): Promise<void> {
    this.reports.push('termination');
  }
}

class FakeProcess implements JobProcess {
  readonly listeners = new Map<NodeJS.Signals, () => Promise<void>>();
  readonly exits: number[] = [];
  exitCode?: number;

  onSignal(signal: NodeJS.Signals, listener: () => Promise<void>): void {
    this.listeners.set(signal, listener);
  }

  setExitCode(code: number): void {
    this.exitCode = code;
  }

  exit(code: number): void {
    this.exits.push(code);
  }

  /** Delivers `signal` as the OS would, resolving once its listener has finished. */
  async send(signal: NodeJS.Signals): Promise<void> {
    const listener = this.listeners.get(signal);
    if (listener === undefined) {
      throw new Error(`Nothing listens for ${signal}.`);
    }
    await listener();
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Lets every pending promise callback run. */
function settled(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('JobRunner', () => {
  let reporter: FakeReporter;
  let host: FakeProcess;
  let runner: JobRunner;

  beforeEach(() => {
    reporter = new FakeReporter();
    host = new FakeProcess();
    runner = new JobRunner(reporter, host);
  });

  it('reports the pid before the job runs, and its exit code after', async () => {
    await runner.run(async () => {
      reporter.reports.push('job');
      return 0;
    });

    expect(reporter.reports).toEqual(['start', 'job', 'exit 0']);
    expect(host.exitCode).toBe(0);
  });

  it('hands the job the reporter, so it can add to its own event log', async () => {
    await runner.run(async (given) => {
      await given?.log('success', { message: 'Captured 3 of 3 chains.' });
      return 0;
    });

    expect(reporter.reports).toEqual(['start', 'log success {"message":"Captured 3 of 3 chains."}', 'exit 0']);
  });

  it('passes a non-zero exit code through, which marks the instance failed', async () => {
    await runner.run(async () => 2);

    expect(reporter.reports).toEqual(['start', 'exit 2']);
    expect(host.exitCode).toBe(2);
  });

  it('records a job that throws by its message alone, exits 1, and does not reject', async () => {
    await expect(runner.run(async () => Promise.reject(new Error('positions 503')))).resolves.toBeUndefined();

    expect(reporter.reports).toEqual(['start', 'log error {"message":"positions 503"}', 'exit 1']);
    expect(host.exitCode).toBe(1);
  });

  it('records a thrown value that is not an Error by its string', async () => {
    await runner.run(async () => Promise.reject('no quote'));

    expect(reporter.reports).toEqual(['start', 'log error {"message":"no quote"}', 'exit 1']);
  });

  it('on SIGINT, reports the termination instead of an exit and exits 130 without waiting for the job', async () => {
    const job = deferred<number>();
    const run = runner.run(() => job.promise);

    await host.send('SIGINT');

    expect(reporter.reports).toEqual(['start', 'termination']);
    expect(host.exits).toEqual([130]);

    // A real process is gone by now. Should the job still finish, it reports nothing more.
    job.resolve(0);
    await run;
    expect(reporter.reports).toEqual(['start', 'termination']);
    expect(host.exitCode).toBeUndefined();
  });

  it('exits 143 on SIGTERM', async () => {
    const job = deferred<number>();
    const run = runner.run(() => job.promise);

    await host.send('SIGTERM');
    job.resolve(0);
    await run;

    expect(reporter.reports).toEqual(['start', 'termination']);
    expect(host.exits).toEqual([143]);
  });

  it('reports one termination however many stop signals arrive', async () => {
    const job = deferred<number>();
    const run = runner.run(() => job.promise);

    await Promise.all([host.send('SIGINT'), host.send('SIGTERM'), host.send('SIGINT')]);
    job.resolve(0);
    await run;

    expect(reporter.reports).toEqual(['start', 'termination']);
    expect(host.exits).toEqual([130]);
  });

  it('ignores a stop signal that arrives while the exit is being reported, since exiting would cut the report off', async () => {
    const agent = deferred<void>();
    reporter.exitGate = agent.promise;
    const run = runner.run(async () => 0);
    await settled();
    expect(reporter.reports).toEqual(['start', 'exit 0']);

    await host.send('SIGINT');
    agent.resolve();
    await run;

    expect(reporter.reports).toEqual(['start', 'exit 0']);
    expect(host.exits).toEqual([]);
    expect(host.exitCode).toBe(0);
  });

  describe('outside mini-cloud', () => {
    it('gives the job no reporter and leaves the signals to Node, but still sets the exit code', async () => {
      const given: Array<JobReporter | undefined> = [];

      await new JobRunner(undefined, host).run(async (reporter) => {
        given.push(reporter);
        return 4;
      });

      expect(given).toEqual([undefined]);
      expect(host.listeners.size).toBe(0);
      expect(host.exitCode).toBe(4);
    });

    it('exits 1 when the job throws', async () => {
      await new JobRunner(undefined, host).run(async () => Promise.reject(new Error('positions 503')));

      expect(host.exitCode).toBe(1);
    });
  });
});

describe('runJob', () => {
  const saved = { instanceId: process.env.MINI_CLOUD_INSTANCE_ID, exitCode: process.exitCode };

  beforeEach(() => {
    delete process.env.MINI_CLOUD_INSTANCE_ID;
  });

  afterEach(() => {
    if (saved.instanceId === undefined) {
      delete process.env.MINI_CLOUD_INSTANCE_ID;
    } else {
      process.env.MINI_CLOUD_INSTANCE_ID = saved.instanceId;
    }
    process.exitCode = saved.exitCode;
  });

  it('runs the job with no reporter when mini-cloud did not launch the process', async () => {
    const given: Array<JobReporter | undefined> = [];

    await runJob(async (reporter) => {
      given.push(reporter);
      return 0;
    });

    expect(given).toEqual([undefined]);
  });
});

describe('nodeProcess', () => {
  const savedExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = savedExitCode;
    jest.restoreAllMocks();
  });

  it('sets the exit code this process ends with, rather than ending it', () => {
    nodeProcess.setExitCode(3);

    expect(process.exitCode).toBe(3);
  });

  it('ends this process with the code given', () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    nodeProcess.exit(130);

    expect(exit).toHaveBeenCalledWith(130);
  });

  it('calls the listener when this process receives the signal', async () => {
    const before = process.listeners('SIGUSR2');
    const received = deferred<void>();
    try {
      nodeProcess.onSignal('SIGUSR2', async () => received.resolve());
      process.emit('SIGUSR2', 'SIGUSR2');
      await received.promise;
    } finally {
      process
        .listeners('SIGUSR2')
        .filter((listener) => !before.includes(listener))
        .forEach((listener) => process.removeListener('SIGUSR2', listener));
    }
  });
});
