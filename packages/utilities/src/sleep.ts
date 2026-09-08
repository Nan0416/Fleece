export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Reconnect delay that grows linearly and is capped, so a service that is briefly
 * down does not get hammered and one that is down for hours is still retried.
 */
export class LinearBackoff {
  private attempt = 0;

  constructor(
    private readonly minimumMs: number = 200,
    private readonly maximumMs: number = 10_000,
    private readonly stepMs: number = 500,
  ) {}

  reset(): void {
    this.attempt = 0;
  }

  nextDelayMs(): number {
    const delay = Math.min(this.minimumMs + this.attempt * this.stepMs, this.maximumMs);
    this.attempt += 1;
    return delay;
  }

  async wait(): Promise<void> {
    await sleep(this.nextDelayMs());
  }
}
