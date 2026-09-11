export interface TimeSubscriber {
  readonly timeSubscriberId: string;
  forward(timestamp: number): Promise<void>;
}

/**
 * The backtest clock. `forward` steps it one `timeFidelity` on and then tells each
 * subscriber, in subscription order and one at a time, so a run replays identically
 * rather than depending on which promise happens to settle first.
 *
 *     const clock = new Time(t0, 60_000); // one-minute steps
 *     clock.subscribe(account);
 *     await clock.forward();
 *     clock.timestamp(); // t0 + 60_000, and the account has already been told
 *
 * A subscriber that throws stops the run with the clock already advanced. That is
 * deliberate: a backtest that carries on past a bad number reports a plausible one.
 */
export class Time {
  private _timestamp: number;
  private subscribers: TimeSubscriber[];

  constructor(
    readonly beginningTimestamp: number,
    readonly timeFidelity: number,
  ) {
    // A fidelity that does not advance the clock makes `forward` a no-op, so a driver
    // looping until an end time never reaches it. A fractional one accumulates float
    // error across a long run, which puts the clock off the minute boundaries the bars
    // are on.
    if (!Number.isInteger(timeFidelity) || timeFidelity <= 0) {
      throw new Error(`timeFidelity must be a positive whole number of milliseconds, got ${timeFidelity}. One minute is 60_000.`);
    }
    this._timestamp = beginningTimestamp;
    this.subscribers = [];
  }

  timestamp(): number {
    return this._timestamp;
  }

  async forward(): Promise<void> {
    this._timestamp += this.timeFidelity;

    for (const subscriber of this.subscribers) {
      await subscriber.forward(this._timestamp);
    }
  }

  /** Subscribing again under the same id replaces the earlier registration rather than doubling it. */
  subscribe(subscriber: TimeSubscriber): void {
    this.subscribers = this.subscribers.filter((sub) => sub.timeSubscriberId !== subscriber.timeSubscriberId);
    this.subscribers.push(subscriber);
  }
}
