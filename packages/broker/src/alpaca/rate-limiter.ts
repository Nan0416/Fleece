import { InternalServiceError, LoggerFactory, sleep } from '@fleece/utilities';

const logger = LoggerFactory.getLogger('AlpacaRateLimiter');

/**
 * Keeps calls to Alpaca under their published rate cap by delaying rather than
 * failing.
 *
 * Alpaca returns 429 when the cap is exceeded, and a 429 on an order placement is
 * indistinguishable at the call site from a rejection — so the safer move is to wait
 * for a slot. A burst of strategies all deciding to trade on the same tick is the
 * normal case, not an exceptional one.
 */
export class RateLimiter {
  private readonly callTimes: number[] = [];

  /**
   * @param maxCalls calls permitted per window; negative disables limiting entirely
   * @param windowMs the window, one minute by default — Alpaca's own unit
   */
  constructor(
    private readonly maxCalls: number,
    private readonly windowMs: number = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async acquire(): Promise<void> {
    if (this.maxCalls < 0) {
      return;
    }

    this.forget();
    if (this.callTimes.length < this.maxCalls) {
      this.callTimes.push(this.now());
      return;
    }

    // Wait for the oldest call to age out of the window, plus a small margin so the
    // retry does not land on the same millisecond it expires.
    //
    // A cap of zero admits nothing, so there is no oldest call to wait for and no
    // delay that would ever produce one. Waiting on `undefined` computed a `NaN` delay,
    // which `setTimeout` reads as zero — turning "permit nothing" into a recursion that
    // re-entered on every tick and pinned the event loop instead of refusing the call.
    const oldest = this.callTimes[0];
    if (oldest === undefined) {
      throw new InternalServiceError(`The Alpaca rate limiter is configured to permit ${this.maxCalls} calls per ${this.windowMs}ms, so no call can ever be made.`);
    }
    const waitMs = oldest - (this.now() - this.windowMs) + 100;
    logger.debug(`Alpaca rate limit reached (${this.maxCalls} per ${this.windowMs}ms); waiting ${waitMs}ms.`);
    await sleep(Math.max(waitMs, 1));
    await this.acquire();
  }

  /** Calls older than the window no longer count against the cap. */
  private forget(): void {
    const cutoff = this.now() - this.windowMs;
    while (this.callTimes.length > 0 && this.callTimes[0] <= cutoff) {
      this.callTimes.shift();
    }
  }
}
