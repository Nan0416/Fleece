import { Time, type TimeSubscriber } from '../../src/backtest/time';

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
/** Far enough out that a test hits the end only when it means to. */
const END = T0 + 1_000 * MINUTE;

interface Recorder {
  /** `id@timestamp` per call, across every listener it made, in the order they were told. */
  readonly log: string[];
  listener(id: string): TimeSubscriber;
}

function recorder(): Recorder {
  const log: string[] = [];
  return {
    log,
    listener: (id: string) => ({
      timeSubscriberId: id,
      init: async (timestamp: number) => {
        log.push(`${id}:init@${timestamp}`);
      },
      forward: async (timestamp: number) => {
        log.push(`${id}@${timestamp}`);
      },
    }),
  };
}

describe('Time', () => {
  it('starts on the beginning timestamp and advances one fidelity per step', async () => {
    const clock = new Time(T0, END, MINUTE);
    expect(clock.timestamp).toBe(T0);

    await clock.forward();
    expect(clock.timestamp).toBe(T0 + MINUTE);

    await clock.forward();
    await clock.forward();
    expect(clock.timestamp).toBe(T0 + 3 * MINUTE);
  });

  it('refuses a fidelity that would stall or rewind the clock', () => {
    expect(() => new Time(T0, END, 0)).toThrow(/positive whole number/);
    expect(() => new Time(T0, END, -MINUTE)).toThrow(/positive whole number/);
    // A fractional one drifts the clock off the minute boundaries the bars sit on.
    expect(() => new Time(T0, END, 0.5)).toThrow(/positive whole number/);
  });

  it('advances with nothing subscribed', async () => {
    const clock = new Time(T0, END, MINUTE);

    await clock.forward();

    expect(clock.timestamp).toBe(T0 + MINUTE);
  });

  it('tells every subscriber the instant it moved to, in the order they subscribed', async () => {
    const clock = new Time(T0, END, MINUTE);
    const { log, listener } = recorder();

    clock.subscribe(listener('first'));
    clock.subscribe(listener('second'));
    await clock.forward();

    // The instant being moved to, never the one being left.
    expect(log).toEqual([`first@${T0 + MINUTE}`, `second@${T0 + MINUTE}`]);
  });

  it('replaces a subscriber that subscribes again rather than telling it twice', async () => {
    const clock = new Time(T0, END, MINUTE);
    let calls = 0;
    const subscriber: TimeSubscriber = {
      timeSubscriberId: 'the-one',
      init: async () => {},
      forward: async () => {
        calls += 1;
      },
    };

    clock.subscribe(subscriber);
    clock.subscribe(subscriber);
    await clock.forward();

    expect(calls).toBe(1);
  });

  it('moves a subscriber that subscribes again to the back of the order', async () => {
    const clock = new Time(T0, END, MINUTE);
    const { log, listener } = recorder();
    const first = listener('first');

    clock.subscribe(first);
    clock.subscribe(listener('second'));
    clock.subscribe(first);
    await clock.forward();

    expect(log).toEqual([`second@${T0 + MINUTE}`, `first@${T0 + MINUTE}`]);
  });

  it('dedupes on the id rather than on the object, so a rebuilt subscriber replaces the old one', async () => {
    const clock = new Time(T0, END, MINUTE);
    const { log, listener } = recorder();

    clock.subscribe(listener('same-id'));
    clock.subscribe(listener('same-id'));
    await clock.forward();

    expect(log).toEqual([`same-id@${T0 + MINUTE}`]);
  });

  it('tells a subscriber nothing about the steps taken before it subscribed', async () => {
    const clock = new Time(T0, END, MINUTE);
    const { log, listener } = recorder();

    await clock.forward();
    await clock.forward();
    clock.subscribe(listener('late'));
    await clock.forward();

    expect(log).toEqual([`late@${T0 + 3 * MINUTE}`]);
  });

  it('stops the run when a subscriber throws, and tells no one after it', async () => {
    const clock = new Time(T0, END, MINUTE);
    const { log, listener } = recorder();

    clock.subscribe(listener('before'));
    clock.subscribe({
      timeSubscriberId: 'broken',
      init: async () => {},
      forward: async () => {
        throw new Error('no mark for AAPL');
      },
    });
    clock.subscribe(listener('after'));

    await expect(clock.forward()).rejects.toThrow('no mark for AAPL');

    expect(log).toEqual([`before@${T0 + MINUTE}`]);
    // The clock is already on the instant that failed, which is why a run does not
    // resume from here: stepping again would hand `before` an instant it has seen and
    // skip `after` past one it never did.
    expect(clock.timestamp).toBe(T0 + MINUTE);
  });

  it('refuses an ending timestamp that is not after the beginning', () => {
    expect(() => new Time(T0, T0, MINUTE)).toThrow(/no steps/);
    expect(() => new Time(T0, T0 - MINUTE, MINUTE)).toThrow(/no steps/);
  });

  it('stops rather than stepping past the ending timestamp', async () => {
    const clock = new Time(T0, T0 + 3 * MINUTE, MINUTE);

    expect(await clock.forward()).toBe(true);
    expect(await clock.forward()).toBe(true);
    expect(await clock.forward()).toBe(true);
    expect(await clock.forward()).toBe(false);
    expect(clock.timestamp).toBe(T0 + 3 * MINUTE);
  });

  it('leaves the clock where it is once the run is over, however often it is asked', async () => {
    const clock = new Time(T0, T0 + MINUTE, MINUTE);
    const { log, listener } = recorder();
    clock.subscribe(listener('only'));

    await clock.forward();
    expect(await clock.forward()).toBe(false);
    expect(await clock.forward()).toBe(false);

    expect(clock.timestamp).toBe(T0 + MINUTE);
    expect(log).toEqual([`only@${T0 + MINUTE}`]); // told once, not once per refused step
  });

  it('steps a whole run to the end without overshooting an uneven fidelity', async () => {
    // 10 minutes of room and 3-minute steps: three steps land on 9, and a fourth would
    // pass the end.
    const clock = new Time(T0, T0 + 10 * MINUTE, 3 * MINUTE);
    let steps = 0;
    while (await clock.forward()) {
      steps += 1;
    }

    expect(steps).toBe(3);
    expect(clock.timestamp).toBe(T0 + 9 * MINUTE);
  });

  it('tells every subscriber where the run begins, before any step is taken', async () => {
    const clock = new Time(T0, END, MINUTE);
    const { log, listener } = recorder();

    clock.subscribe(listener('first'));
    clock.subscribe(listener('second'));
    await clock.init();

    expect(log).toEqual([`first:init@${T0}`, `second:init@${T0}`]);
    expect(clock.timestamp).toBe(T0); // init reports the beginning, it does not move it
  });
});
