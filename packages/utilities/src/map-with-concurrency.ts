/**
 * Runs `work` over `items`, at most `concurrency` at a time, starting each item as soon as
 * a slot frees and in the order the items are given.
 *
 * A pool rather than `Promise.all` over fixed groups: when the pieces of work differ by an
 * order of magnitude in size, a group spends most of its time waiting on its slowest member
 * while the other slots sit idle.
 *
 * The first `work` to reject rejects the whole call, with that error. Nothing is cancelled:
 * work already running carries on, and the other slots keep taking items until the list
 * runs out.
 */
export async function mapWithConcurrency<T>(items: ReadonlyArray<T>, concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  // Zero workers would resolve at once having done none of the work.
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`concurrency must be a whole number of at least 1, got ${concurrency}.`);
  }
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await work(item);
    }
  });
  await Promise.all(workers);
}
