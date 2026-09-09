import { LinearBackoff, sleep } from '../src/sleep';

describe('sleep', () => {
  it('resolves after the delay', async () => {
    const started = Date.now();
    await sleep(20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  it('resolves rather than hanging on a zero delay', async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
  });
});

describe('LinearBackoff', () => {
  it('starts at the minimum and grows by the step', () => {
    const backoff = new LinearBackoff(200, 10_000, 500);
    expect(backoff.nextDelayMs()).toBe(200);
    expect(backoff.nextDelayMs()).toBe(700);
    expect(backoff.nextDelayMs()).toBe(1200);
  });

  it('caps, so a service down for hours is still retried rather than never', () => {
    const backoff = new LinearBackoff(200, 1_000, 500);
    expect(backoff.nextDelayMs()).toBe(200);
    expect(backoff.nextDelayMs()).toBe(700);
    expect(backoff.nextDelayMs()).toBe(1_000);
    expect(backoff.nextDelayMs()).toBe(1_000);
  });

  it('returns to the minimum once a connection succeeds', () => {
    const backoff = new LinearBackoff(200, 10_000, 500);
    backoff.nextDelayMs();
    backoff.nextDelayMs();
    backoff.reset();
    expect(backoff.nextDelayMs()).toBe(200);
  });

  it('defaults to the reconnect shape the websocket clients expect', () => {
    const backoff = new LinearBackoff();
    expect(backoff.nextDelayMs()).toBe(200);
    expect(backoff.nextDelayMs()).toBe(700);
  });

  it('waits for the delay it just reported', async () => {
    const backoff = new LinearBackoff(20, 100, 10);
    const started = Date.now();
    await backoff.wait();
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    // The wait consumed an attempt, so the next delay has advanced.
    expect(backoff.nextDelayMs()).toBe(30);
  });
});
