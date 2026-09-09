import { InternalServiceError } from '@fleece/utilities';
import { RateLimiter } from '../../src/alpaca/rate-limiter';

/**
 * A controllable clock. The limiter's whole job is about elapsed time, and testing it
 * against a real one would mean either a slow suite or a flaky one.
 */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms: number) => (current += ms) };
}

describe('RateLimiter', () => {
  it('lets calls through up to the cap without waiting', async () => {
    const { now } = clock();
    const limiter = new RateLimiter(3, 60_000, now);
    await limiter.acquire();
    await limiter.acquire();
    await expect(limiter.acquire()).resolves.toBeUndefined();
  });

  it('disables itself entirely for a negative cap', async () => {
    const { now } = clock();
    const limiter = new RateLimiter(-1, 60_000, now);
    for (let i = 0; i < 50; i += 1) {
      await limiter.acquire();
    }
    // Nothing was recorded and nothing waited, which is what "disabled" has to mean.
    await expect(limiter.acquire()).resolves.toBeUndefined();
  });

  it('forgets calls that have aged out of the window', async () => {
    const { now, advance } = clock();
    const limiter = new RateLimiter(2, 1_000, now);
    await limiter.acquire();
    await limiter.acquire();

    // Both calls are now older than the window, so the cap is free again and this
    // resolves without a timer.
    advance(1_001);
    await expect(limiter.acquire()).resolves.toBeUndefined();
  });

  it('delays a call over the cap until the oldest one expires', async () => {
    const { now, advance } = clock();
    const limiter = new RateLimiter(1, 1_000, now);
    await limiter.acquire();

    let settled = false;
    const waiting = limiter.acquire().then(() => {
      settled = true;
    });

    // Still inside the window: the third call must not have been let through.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    advance(1_001);
    await waiting;
    expect(settled).toBe(true);
  });

  it('refuses a cap of zero rather than spinning on a wait that can never end', async () => {
    // A cap of zero admits nothing, so there is no oldest call to wait for. Computing
    // the delay from a missing one gave `NaN`, which `setTimeout` reads as zero — the
    // limiter then re-entered on every tick and pinned the event loop instead of
    // saying the configuration was impossible.
    const { now } = clock();
    const limiter = new RateLimiter(0, 60_000, now);
    await expect(limiter.acquire()).rejects.toThrow(InternalServiceError);
    await expect(limiter.acquire()).rejects.toThrow(/no call can ever be made/);
  });
});
