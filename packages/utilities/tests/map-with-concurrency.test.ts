import { mapWithConcurrency } from '../src/map-with-concurrency';

/** Lets pending promise callbacks run, so whatever a released slot starts has started. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Work that finishes only when the test says so, and records what is running. Timers would
 * make "which item took the free slot" a race; this makes it a sequence.
 */
function gated<T>(): { work: (item: T) => Promise<void>; started: T[]; running: Set<T>; release: (item: T, error?: Error) => void } {
  const started: T[] = [];
  const running = new Set<T>();
  const gates = new Map<T, { resolve: () => void; reject: (error: Error) => void }>();
  return {
    started,
    running,
    work: (item) =>
      new Promise<void>((resolve, reject) => {
        started.push(item);
        running.add(item);
        gates.set(item, { resolve, reject });
      }),
    release: (item, error) => {
      running.delete(item);
      const gate = gates.get(item);
      if (error === undefined) {
        gate?.resolve();
      } else {
        gate?.reject(error);
      }
    },
  };
}

describe('mapWithConcurrency', () => {
  it('runs the work once for every item', async () => {
    const seen: number[] = [];

    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
      seen.push(item);
    });

    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('starts as many items as it is allowed at once, and no more', async () => {
    const { work, started, release } = gated<string>();

    const done = mapWithConcurrency(['a', 'b', 'c', 'd'], 3, work);
    await settle();

    expect(started).toEqual(['a', 'b', 'c']);

    for (const item of ['a', 'b', 'c', 'd']) {
      release(item);
      await settle();
    }
    await done;
    expect(started).toEqual(['a', 'b', 'c', 'd']);
  });

  it('never has more than the concurrency running, whichever slot frees first', async () => {
    const items = Array.from({ length: 12 }, (_, index) => index);
    const { work, running, release } = gated<number>();
    let most = 0;

    const done = mapWithConcurrency(items, 4, async (item) => {
      const finished = work(item);
      most = Math.max(most, running.size);
      await finished;
    });
    await settle();

    // Out of order, so a slot freeing in the middle of the pool is covered and not just the first.
    for (const item of [2, 0, 3, 1, 7, 5, 4, 6, 11, 8, 10, 9]) {
      release(item);
      await settle();
    }
    await done;

    expect(most).toBe(4);
  });

  it('hands a freed slot to the next item at once, rather than waiting on the slowest of a group', async () => {
    const { work, started, release } = gated<string>();

    const done = mapWithConcurrency(['slow', 'fast-1', 'fast-2', 'fast-3'], 2, work);
    await settle();
    expect(started).toEqual(['slow', 'fast-1']);

    release('fast-1');
    await settle();
    expect(started).toEqual(['slow', 'fast-1', 'fast-2']);

    release('fast-2');
    await settle();
    // Two groups of two would still be waiting on `slow` before starting `fast-2` at all.
    expect(started).toEqual(['slow', 'fast-1', 'fast-2', 'fast-3']);

    release('fast-3');
    release('slow');
    await done;
  });

  it('starts items in the order they were given', async () => {
    const { work, started, release } = gated<number>();

    const done = mapWithConcurrency([5, 3, 9, 1], 1, work);
    for (const item of [5, 3, 9, 1]) {
      await settle();
      release(item);
    }
    await done;

    expect(started).toEqual([5, 3, 9, 1]);
  });

  it('runs every item at once when there are fewer items than slots', async () => {
    const { work, started, release } = gated<string>();

    const done = mapWithConcurrency(['a', 'b'], 10, work);
    await settle();

    expect(started).toEqual(['a', 'b']);
    release('a');
    release('b');
    await done;
  });

  it('resolves without calling the work when there are no items', async () => {
    const work = jest.fn(async () => {});

    await mapWithConcurrency([], 3, work);

    expect(work).not.toHaveBeenCalled();
  });

  it('rejects with the error the work threw', async () => {
    const failure = new Error('Alpaca returned 429 for /v1beta1/options/bars.');

    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) {
          throw failure;
        }
      }),
    ).rejects.toBe(failure);
  });

  it('rejects at the first failure without waiting for the work still running', async () => {
    const { work, release } = gated<string>();

    const done = mapWithConcurrency(['slow', 'failing'], 2, work);
    await settle();
    release('failing', new Error('boom'));

    await expect(done).rejects.toThrow('boom');
    release('slow');
  });

  it('refuses a concurrency that is not a whole number of at least 1, rather than doing none of the work', async () => {
    const work = jest.fn(async () => {});

    await expect(mapWithConcurrency([1, 2], 0, work)).rejects.toThrow(/at least 1, got 0/);
    await expect(mapWithConcurrency([1, 2], -1, work)).rejects.toThrow(/at least 1/);
    await expect(mapWithConcurrency([1, 2], 1.5, work)).rejects.toThrow(/at least 1/);
    await expect(mapWithConcurrency([1, 2], Number.NaN, work)).rejects.toThrow(/at least 1/);
    expect(work).not.toHaveBeenCalled();
  });
});
