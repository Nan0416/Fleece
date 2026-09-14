import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { marketHour, type AlpacaMarketDataClient, type Bar } from '@fleece/marketdata';
import { easternClock } from '@fleece/utilities';

import { OptionsAvailabilitiesHelperImpl } from '../../src/utils/options-availabilities';

const CALL = 'AMZN260116C00200000';
const PUT = 'AMZN260116P00150000';
const UNTABLED = 'AMZN290119C00200000'; // expires past the market-hours table
const QUIET = 'AMZN260320C00300000'; // listed, never printed
const NO_MINUTES = 'AMZN260320P00100000'; // a daily bar with no minute bars behind it
const ADJUSTED = '1AMZN260116C00200000';

const DAY_ONE = '2024-03-04';
const DAY_TWO = '2024-03-05';
/** After both trading days and well before either expiration, so nothing settles by expiry. */
const NOW = easternClock.timestamp('2024-06-03', '12:00:00');

function bar(symbol: string, at: number): Bar {
  return { S: symbol, o: 1, h: 1, l: 1, c: 1, v: 1, t: at };
}

function minuteOf(date: string, time: string): number {
  return easternClock.timestamp(date, time);
}

interface Recorded {
  readonly timespan: string;
  readonly symbols: ReadonlyArray<string>;
  readonly from: string;
}

/**
 * Serves a fixed chain and tape, and keeps every bars request it was given so a test can
 * say how the sweep was shaped as well as what it concluded.
 */
class FakeClient {
  readonly requests: Recorded[] = [];
  listings = 0;
  /** The `expirationTo` of every listing request, in order. */
  readonly listedThrough: Array<string | undefined> = [];
  inFlight = 0;
  maxInFlight = 0;
  /** Symbols or dates whose request should throw, so a failing batch can be aimed. */
  failOn: ReadonlyArray<string> = [];

  constructor(
    private readonly daily: ReadonlyMap<string, string>,
    private readonly minutes: ReadonlyMap<string, number>,
  ) {}

  async listOptionContracts(request: { status?: string; startAfter?: string; expirationTo?: string }): Promise<unknown> {
    this.listings += 1;
    this.listedThrough.push(request.expirationTo);
    if (request.status === 'inactive') {
      return { contracts: [{ S: QUIET }, { S: NO_MINUTES }, { S: UNTABLED }] };
    }
    // Paged, so the resumeFrom loop is exercised rather than assumed.
    if (request.startAfter === undefined) {
      return { contracts: [{ S: CALL }, { S: ADJUSTED }], resumeFrom: CALL };
    }
    return { contracts: [{ S: PUT }] };
  }

  async optionBarsBySymbol(request: { symbols: ReadonlyArray<string>; timespan: string; from: string }): Promise<unknown> {
    this.requests.push({ timespan: request.timespan, symbols: request.symbols, from: request.from });
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    // A turn of the event loop, so overlapping requests actually overlap.
    await new Promise((resolve) => setImmediate(resolve));
    this.inFlight -= 1;

    if (this.failOn.includes(request.from) || request.symbols.some((symbol) => this.failOn.includes(symbol))) {
      throw new Error(`Alpaca returned 429 for /v1beta1/options/bars.`);
    }
    const bars = new Map<string, ReadonlyArray<Bar>>();

    for (const symbol of request.symbols) {
      if (request.timespan === 'day') {
        const date = this.daily.get(symbol);
        if (date !== undefined) {
          bars.set(symbol, [bar(symbol, easternClock.timestamp(date, '09:30:00'))]);
        }
      } else {
        const at = this.minutes.get(symbol);
        if (at !== undefined && easternClock.date(at) === request.from) {
          bars.set(symbol, [bar(symbol, at)]);
        }
      }
    }
    return { bars };
  }
}

function helper(client: FakeClient): { helper: OptionsAvailabilitiesHelperImpl; cachePath: string } {
  const cachePath = mkdtempSync(join(tmpdir(), 'fleece-availability-'));
  // The fake implements the slice of the client this helper touches, which the compiler
  // cannot know; the production rule is about data crossing a trust boundary.
  return { helper: new OptionsAvailabilitiesHelperImpl(cachePath, client as unknown as AlpacaMarketDataClient, () => NOW), cachePath };
}

/**
 * Where the helper keeps an underlying's file under a cache root. The folder is created, so
 * a test can plant a file there before any sweep has made it.
 */
function cacheFile(cachePath: string, ticker: string): string {
  const folder = resolve(cachePath, 'options-availabilities');
  mkdirSync(folder, { recursive: true });
  return resolve(folder, `${ticker}.json`);
}

/** Enough distinct debut days that the minute pass has several requests to run at once. */
function busy(days: number): { client: FakeClient; symbols: string[] } {
  const daily = new Map<string, string>();
  const minutes = new Map<string, number>();
  const symbols: string[] = [];
  for (let index = 0; index < days; index += 1) {
    const symbol = `AMZN260116C0${String(100000 + index * 1000).padStart(7, '0')}`;
    const date = marketHourByOffset(index);
    symbols.push(symbol);
    daily.set(symbol, date);
    minutes.set(symbol, easternClock.timestamp(date, '10:00:00'));
  }
  const client = new FakeClient(daily, minutes);
  client.listOptionContracts = async (request: { status?: string; startAfter?: string }) => {
    client.listings += 1;
    return request.status === 'active' ? { contracts: symbols.map((symbol) => ({ S: symbol })) } : { contracts: [] };
  };
  return { client, symbols };
}

/** Consecutive trading days from a known one, so every date has a session behind it. */
function marketHourByOffset(offset: number): string {
  let date = '2024-03-04';
  for (let step = 0; step < offset; step += 1) {
    do {
      date = easternClock.shiftDate(date, 1);
    } while (marketHour(date) === undefined);
  }
  return date;
}

function fake(): FakeClient {
  return new FakeClient(
    new Map([
      [CALL, DAY_ONE],
      [PUT, DAY_TWO],
      [NO_MINUTES, DAY_ONE],
    ]),
    new Map([
      [CALL, minuteOf(DAY_ONE, '10:14:00')],
      [PUT, minuteOf(DAY_TWO, '11:02:00')],
    ]),
  );
}

describe('OptionsAvailabilitiesHelperImpl', () => {
  describe('save', () => {
    it('writes into an options-availabilities folder under the cache path, leaving the root to other caches', async () => {
      const client = fake();
      const { helper: subject, cachePath } = helper(client);

      await subject.save('AMZN');

      expect(readdirSync(cachePath)).toEqual(['options-availabilities']);
      expect(readdirSync(resolve(cachePath, 'options-availabilities'))).toEqual(['AMZN.json']);
    });

    it('lists every page out to three years ahead, since Alpaca stops at the next weekend without an end', async () => {
      const client = fake();
      const { helper: subject } = helper(client);

      await subject.save('AMZN');

      // Two pages of active contracts and one of inactive, all asked out to 2027-06-03.
      expect(client.listedThrough).toEqual(['2027-06-03', '2027-06-03', '2027-06-03']);
    });

    it('asks for inactive contracts too, since anything already expired is inactive today', async () => {
      const client = fake();
      const { helper: subject, cachePath } = helper(client);

      await subject.save('AMZN');

      const written = JSON.parse(readFileSync(cacheFile(cachePath, 'AMZN'), 'utf8'));
      expect(written.availabilities.map((entry: { symbol: string }) => entry.symbol)).toEqual([CALL, PUT, QUIET, NO_MINUTES, UNTABLED].sort());
    });

    it('leaves out an adjusted contract, which does not deliver 100 shares', async () => {
      const client = fake();
      const { helper: subject, cachePath } = helper(client);

      await subject.save('AMZN');

      const written = JSON.parse(readFileSync(cacheFile(cachePath, 'AMZN'), 'utf8'));
      expect(written.availabilities.map((entry: { symbol: string }) => entry.symbol)).not.toContain(ADJUSTED);
    });

    it('sweeps the whole chain in one daily request rather than one per contract', async () => {
      const client = fake();
      const { helper: subject } = helper(client);

      await subject.save('AMZN');

      const daily = client.requests.filter((request) => request.timespan === 'day');
      expect(daily).toHaveLength(1);
      expect(daily[0].symbols).toHaveLength(5);
      // Reaching back before any option history, so a backfill is picked up without an edit.
      expect(daily[0].from < '2024-02-01').toBe(true);
    });

    it('sweeps minutes once per day the contracts first printed on, not once per contract', async () => {
      const client = fake();
      const { helper: subject } = helper(client);

      await subject.save('AMZN');

      const minutes = client.requests.filter((request) => request.timespan === 'minute');
      // CALL and NO_MINUTES share DAY_ONE; PUT is alone on DAY_TWO. Three contracts, two calls.
      expect(minutes).toHaveLength(2);
      expect(minutes[0].symbols.slice().sort()).toEqual([CALL, NO_MINUTES].sort());
      expect(minutes[1].symbols).toEqual([PUT]);
    });

    it('dates a contract with a daily bar but no minute bars from that session close, not its open', async () => {
      const client = fake();
      const { helper: subject, cachePath } = helper(client);

      await subject.save('AMZN');

      const written = JSON.parse(readFileSync(cacheFile(cachePath, 'AMZN'), 'utf8'));
      const entry = written.availabilities.find((each: { symbol: string }) => each.symbol === NO_MINUTES);
      // Late rather than early: an open would invent a minute the contract was not known to trade in.
      expect(entry.firstTradingMinuteTimestamp).toBe(marketHour(DAY_ONE)?.closeAt);
    });

    it('records a contract that never printed, with no first trading minute', async () => {
      const client = fake();
      const { helper: subject, cachePath } = helper(client);

      await subject.save('AMZN');

      const written = JSON.parse(readFileSync(cacheFile(cachePath, 'AMZN'), 'utf8'));
      const entry = written.availabilities.find((each: { symbol: string }) => each.symbol === QUIET);
      expect(entry.firstTradingMinuteTimestamp).toBeUndefined();
      expect(entry.expirationTimestamp).toBe(marketHour('2026-03-20')?.closeAt);
    });

    it('expires a contract at the regular close on its expiration day', async () => {
      const client = fake();
      const { helper: subject, cachePath } = helper(client);

      await subject.save('AMZN');

      const written = JSON.parse(readFileSync(cacheFile(cachePath, 'AMZN'), 'utf8'));
      const entry = written.availabilities.find((each: { symbol: string }) => each.symbol === CALL);
      expect(entry.expirationTimestamp).toBe(marketHour('2026-01-16')?.closeAt);
    });

    it('re-sweeps only the contracts whose answer can still change', async () => {
      const client = fake();
      const { helper: subject } = helper(client);

      await subject.save('AMZN');
      const firstPass = client.requests.length;
      client.requests.length = 0;

      await subject.save('AMZN');

      // CALL, PUT and NO_MINUTES have printed, so they are settled for good. QUIET has not
      // and does not expire until 2026, so it is the only one asked about again.
      expect(firstPass).toBe(3);
      // Neither printed and neither has expired, so these two are all that can still change.
      const daily = client.requests.filter((request) => request.timespan === 'day');
      expect(daily).toHaveLength(1);
      expect([...daily[0].symbols].sort()).toEqual([QUIET, UNTABLED].sort());
    });
  });

  describe('an empty listing', () => {
    it('refuses to overwrite a swept chain, rather than recording an underlying with no options', async () => {
      const client = fake();
      const { helper: subject, cachePath } = helper(client);
      await subject.save('AMZN');
      const before = readFileSync(cacheFile(cachePath, 'AMZN'), 'utf8');

      // An empty page — a transient upstream fault normalised into one, or a listing
      // Alpaca has aged out. Neither is an underlying that stopped having options.
      client.listOptionContracts = async () => ({ contracts: [] });

      await expect(subject.save('AMZN')).rejects.toThrow(/Refusing to overwrite a swept chain with an empty one/);
      expect(readFileSync(cacheFile(cachePath, 'AMZN'), 'utf8')).toBe(before);
    });

    it('still writes one when there was nothing there to lose', async () => {
      const client = fake();
      client.listOptionContracts = async () => ({ contracts: [] });
      const { helper: subject, cachePath } = helper(client);

      await subject.save('AMZN');

      const written = JSON.parse(readFileSync(cacheFile(cachePath, 'AMZN'), 'utf8'));
      expect(written.availabilities).toEqual([]);
    });
  });

  describe('availableOptions', () => {
    it('leaves out a contract before its first print and includes it from that minute on', async () => {
      const client = fake();
      const { helper: subject } = helper(client);
      await subject.save('AMZN');

      const firstPrint = minuteOf(DAY_ONE, '10:14:00');
      const before = await subject.availableOptions('AMZN', firstPrint - 60_000);
      const at = await subject.availableOptions('AMZN', firstPrint);

      expect(before.map((contract) => contract.symbol)).not.toContain(CALL);
      expect(at.map((contract) => contract.symbol)).toContain(CALL);
    });

    it('leaves out a contract once its expiration close has passed', async () => {
      const client = fake();
      const { helper: subject } = helper(client);
      await subject.save('AMZN');

      const expiry = marketHour('2026-01-16')?.closeAt ?? 0;
      expect((await subject.availableOptions('AMZN', expiry)).map((contract) => contract.symbol)).toContain(CALL);
      expect((await subject.availableOptions('AMZN', expiry + 1)).map((contract) => contract.symbol)).not.toContain(CALL);
    });

    it('never offers a contract that has no price, at any instant', async () => {
      const client = fake();
      const { helper: subject } = helper(client);
      await subject.save('AMZN');

      for (const at of [minuteOf(DAY_ONE, '09:30:00'), minuteOf(DAY_TWO, '15:00:00'), marketHour('2026-01-16')?.closeAt ?? 0]) {
        expect((await subject.availableOptions('AMZN', at)).map((contract) => contract.symbol)).not.toContain(QUIET);
      }
    });

    it('hands back the parsed contract, so a caller has the strike and expiry without reparsing', async () => {
      const client = fake();
      const { helper: subject } = helper(client);
      await subject.save('AMZN');

      const found = (await subject.availableOptions('AMZN', minuteOf(DAY_TWO, '12:00:00'))).find((contract) => contract.symbol === PUT);

      expect(found?.strike).toBe(150);
      expect(found?.type).toBe('put');
      expect(found?.expiration).toBe('2026-01-16');
    });

    it('reads the file once however many minutes ask', async () => {
      const client = fake();
      const { helper: subject } = helper(client);
      await subject.save('AMZN');

      const parse = jest.spyOn(JSON, 'parse');
      for (let minute = 0; minute < 50; minute += 1) {
        await subject.availableOptions('AMZN', minuteOf(DAY_TWO, '12:00:00') + minute * 60_000);
      }

      expect(parse).toHaveBeenCalledTimes(1);
      parse.mockRestore();
    });

    it('sweeps the chain itself the first time it is asked about an underlying with no cache', async () => {
      const client = fake();
      const { helper: subject, cachePath } = helper(client);

      const found = await subject.availableOptions('AMZN', minuteOf(DAY_TWO, '12:00:00'));

      expect(client.listings).toBeGreaterThan(0);
      expect(found.map((contract) => contract.symbol)).toContain(PUT);
      expect(readFileSync(cacheFile(cachePath, 'AMZN'), 'utf8')).toContain(PUT);
    });

    it('does not sweep again once the cache is there', async () => {
      const client = fake();
      const { helper: subject } = helper(client);
      await subject.availableOptions('AMZN', minuteOf(DAY_TWO, '12:00:00'));
      const afterFirst = client.listings;

      await subject.availableOptions('AMZN', minuteOf(DAY_TWO, '12:01:00'));
      await subject.availableOptions('AMZN', minuteOf(DAY_TWO, '12:02:00'));

      expect(client.listings).toBe(afterFirst);
    });

    it('sweeps once when several callers ask before the first sweep has finished', async () => {
      const client = fake();
      const { helper: subject } = helper(client);

      await Promise.all([
        subject.availableOptions('AMZN', minuteOf(DAY_TWO, '12:00:00')),
        subject.availableOptions('AMZN', minuteOf(DAY_TWO, '12:01:00')),
        subject.availableOptions('AMZN', minuteOf(DAY_TWO, '12:02:00')),
      ]);

      const daily = client.requests.filter((request) => request.timespan === 'day');
      expect(daily).toHaveLength(1);
    });

    it('refuses a cache file it cannot read rather than sweeping over an answer it owes', async () => {
      const client = fake();
      const { helper: subject, cachePath } = helper(client);
      writeFileSync(cacheFile(cachePath, 'AMZN'), '{ not json');

      await expect(subject.availableOptions('AMZN', NOW)).rejects.toThrow(/is not a readable availability cache/);
      // A corrupt file is a question to answer, not a reason to spend a sweep.
      expect(client.listings).toBe(0);
    });

    it('asks again after a failed load rather than answering every later minute from it', async () => {
      const client = fake();
      const { helper: subject, cachePath } = helper(client);
      writeFileSync(cacheFile(cachePath, 'AMZN'), '{ not json');
      await expect(subject.availableOptions('AMZN', NOW)).rejects.toThrow();

      await subject.save('AMZN');

      expect((await subject.availableOptions('AMZN', minuteOf(DAY_TWO, '12:00:00'))).map((contract) => contract.symbol)).toContain(PUT);
    });
  });

  describe('a cache that cannot be read', () => {
    it('is swept from scratch by save, which is about to replace it anyway', async () => {
      const client = fake();
      const { helper: subject, cachePath } = helper(client);
      writeFileSync(cacheFile(cachePath, 'AMZN'), 'not json at all');

      await subject.save('AMZN');

      const written = JSON.parse(readFileSync(cacheFile(cachePath, 'AMZN'), 'utf8'));
      expect(written.availabilities).toHaveLength(5);
    });

    it('is told apart from a file that cannot be opened at all', async () => {
      const client = fake();
      const { helper: subject, cachePath } = helper(client);
      // A directory where the cache file belongs: readFileSync fails, but not with ENOENT,
      // so it must not be mistaken for a sweep that has not happened.
      mkdirSync(cacheFile(cachePath, 'AMZN'));

      await expect(subject.availableOptions('AMZN', NOW)).rejects.toThrow(/Could not read/);
      expect(client.listings).toBe(0);
    });

    it('is re-read after a failed load rather than answering from the failure', async () => {
      const first = helper(fake());
      await first.helper.save('AMZN');
      const good = readFileSync(cacheFile(first.cachePath, 'AMZN'), 'utf8');

      const subject = new OptionsAvailabilitiesHelperImpl(first.cachePath, fake() as unknown as AlpacaMarketDataClient, () => NOW);
      writeFileSync(cacheFile(first.cachePath, 'AMZN'), '{ not json');
      await expect(subject.availableOptions('AMZN', NOW)).rejects.toThrow();

      // Repaired on disk, with nothing telling the helper so. A rejection kept in the memo
      // would answer every later minute of the run from a file that is now fine.
      writeFileSync(cacheFile(first.cachePath, 'AMZN'), good);

      expect((await subject.availableOptions('AMZN', minuteOf(DAY_TWO, '12:00:00'))).map((contract) => contract.symbol)).toContain(PUT);
    });

    it('is told apart from a cache that was never written', async () => {
      const client = fake();
      const { helper: subject, cachePath } = helper(client);

      // Never written: swept without complaint.
      await subject.save('AMZN');
      // Written and unreadable: named, with what to do about it.
      writeFileSync(cacheFile(cachePath, 'TSLA'), '{"underlying":"TSLA"}');
      await expect(subject.availableOptions('TSLA', NOW)).rejects.toThrow(/Delete it to sweep TSLA again from scratch/);
    });
  });

  describe('concurrency', () => {
    it('runs several sweep requests at once rather than one after another', async () => {
      const { client } = busy(20);
      const { helper: subject } = helper(client);

      await subject.save('AMZN');

      expect(client.requests.filter((request) => request.timespan === 'minute')).toHaveLength(20);
      expect(client.maxInFlight).toBeGreaterThan(1);
    });

    it('never runs more than the concurrency it was given', async () => {
      const { client } = busy(30);
      const cachePath = mkdtempSync(join(tmpdir(), 'fleece-availability-'));
      const subject = new OptionsAvailabilitiesHelperImpl(cachePath, client as unknown as AlpacaMarketDataClient, () => NOW, 4);

      await subject.save('AMZN');

      expect(client.maxInFlight).toBe(4);
    });
  });

  describe('a failed request', () => {
    it('fails the whole save, and writes nothing', async () => {
      const { client } = busy(5);
      const { helper: subject, cachePath } = helper(client);
      client.failOn = [marketHourByOffset(2)]; // the third day's minute request

      await expect(subject.save('AMZN')).rejects.toThrow(/429/);

      // The four days that did answer are not written either: a file holds only answers.
      expect(() => readFileSync(cacheFile(cachePath, 'AMZN'), 'utf8')).toThrow();
    });

    it('leaves the previous file as it was when a rerun fails', async () => {
      const client = fake();
      const { helper: subject, cachePath } = helper(client);
      await subject.save('AMZN');
      const before = readFileSync(cacheFile(cachePath, 'AMZN'), 'utf8');

      client.failOn = [QUIET]; // one of the two contracts a rerun asks about again

      await expect(subject.save('AMZN')).rejects.toThrow(/429/);
      expect(readFileSync(cacheFile(cachePath, 'AMZN'), 'utf8')).toBe(before);
    });

    it('asks about the whole chain again on the run after a failed first sweep', async () => {
      const { client, symbols } = busy(5);
      const { helper: subject } = helper(client);
      client.failOn = [marketHourByOffset(2)];
      await expect(subject.save('AMZN')).rejects.toThrow();

      client.failOn = [];
      client.requests.length = 0;
      await subject.save('AMZN');

      const daily = client.requests.filter((request) => request.timespan === 'day');
      expect(daily).toHaveLength(1);
      expect([...daily[0].symbols].sort()).toEqual([...symbols].sort());
    });
  });

  describe('a contract that has not printed', () => {
    const CONTRACT = 'AMZN240419C00100000';
    const EXPIRY = marketHour('2024-04-19')?.closeAt ?? 0;

    /** One inactive contract, a tape that can gain a print between runs, and a clock the test moves. */
    function single(): { client: FakeClient; daily: Map<string, string>; minutes: Map<string, number>; subject: OptionsAvailabilitiesHelperImpl; at: (now: number) => void } {
      const daily = new Map<string, string>();
      const minutes = new Map<string, number>();
      const client = new FakeClient(daily, minutes);
      client.listOptionContracts = async (request: { status?: string }) => {
        client.listings += 1;
        return request.status === 'inactive' ? { contracts: [{ S: CONTRACT }] } : { contracts: [] };
      };
      let now = NOW;
      const cachePath = mkdtempSync(join(tmpdir(), 'fleece-availability-'));
      const subject = new OptionsAvailabilitiesHelperImpl(cachePath, client as unknown as AlpacaMarketDataClient, () => now);
      return { client, daily, minutes, subject, at: (next) => (now = next) };
    }

    function askedAbout(client: FakeClient): boolean {
      return client.requests.some((request) => request.timespan === 'day' && request.symbols.includes(CONTRACT));
    }

    it('is settled once a sweep made after its expiry found no print, and not asked about again', async () => {
      const { client, subject, at } = single();
      at(EXPIRY + 1);
      await subject.save('AMZN');

      client.requests.length = 0;
      at(NOW);
      await subject.save('AMZN');

      expect(askedAbout(client)).toBe(false);
    });

    it('is asked about again when the sweep that found no print ran before it expired', async () => {
      const { client, subject, at } = single();
      at(easternClock.timestamp('2024-04-10', '12:00:00'));
      await subject.save('AMZN');

      client.requests.length = 0;
      at(NOW);
      await subject.save('AMZN');
      expect(askedAbout(client)).toBe(true);

      // That second sweep ran after the expiry, so its "no print" is final.
      client.requests.length = 0;
      at(NOW + 60_000);
      await subject.save('AMZN');
      expect(askedAbout(client)).toBe(false);
    });

    it('picks up a first print made after a sweep that ran before its expiry', async () => {
      const { daily, minutes, subject, at } = single();
      at(easternClock.timestamp('2024-04-10', '12:00:00'));
      await subject.save('AMZN');

      // It first trades on the 15th, after that sweep and before the 19th's expiry.
      daily.set(CONTRACT, '2024-04-15');
      minutes.set(CONTRACT, minuteOf('2024-04-15', '10:00:00'));
      at(NOW);
      await subject.save('AMZN');

      // Settling on the first sweep's answer would have dropped it from every backtest.
      expect((await subject.availableOptions('AMZN', minuteOf('2024-04-16', '12:00:00'))).map((contract) => contract.symbol)).toEqual([CONTRACT]);
    });

    it('throws, naming the contract, when its first print is on a day with no session and no minute bars', async () => {
      const { daily, subject, at } = single();
      // Alpaca has served a daily bar on a Saturday: AMZN250620P00150000 on 2024-06-01.
      daily.set(CONTRACT, '2024-04-13');
      at(NOW);

      await expect(subject.save('AMZN')).rejects.toThrow(`${CONTRACT} printed on 2024-04-13, which has no market session and no minute bars`);
    });
  });

  describe('an expiry the market-hours table does not cover', () => {
    it('is recorded at the regular close rather than dropped out of the file entirely', async () => {
      const client = fake();
      const { helper: subject, cachePath } = helper(client);

      await subject.save('AMZN');

      const written = JSON.parse(readFileSync(cacheFile(cachePath, 'AMZN'), 'utf8'));
      const entry = written.availabilities.find((each: { symbol: string }) => each.symbol === UNTABLED);
      expect(entry.expirationTimestamp).toBe(easternClock.timestamp('2029-01-19', '16:00:00'));
    });
  });
});
