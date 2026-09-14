import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { parseOccSymbol, type AlpacaMarketDataClient, type Bar, type OccSymbol, type OptionSnapshot } from '@fleece/marketdata';
import { easternClock } from '@fleece/utilities';

import { OptionsQuoteSpreadHelperImpl } from '../../src/utils/options-quote-spread';

const DAY = '2024-03-04';
const CAPTURED_AT = easternClock.timestamp(DAY, '10:30:00');
const SPOT = 100;
/** 18 days out. */
const NEAR = '2024-03-22';
/** 100 days out. */
const FAR = '2024-06-12';

function occ(expiration: string, type: 'C' | 'P', strike: number, root = 'AMZN'): string {
  return `${root}${expiration.slice(2).replaceAll('-', '')}${type}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
}

function contract(symbol: string): OccSymbol {
  const parsed = parseOccSymbol(symbol);
  if (parsed === undefined) {
    throw new Error(`${symbol} is not an OCC symbol`);
  }
  return parsed;
}

/** A quote whose `(ask - bid) / mid` is `relativeSpread`, around a mid of 2. */
function snapshot(symbol: string, relativeSpread: number, quotedAt = easternClock.timestamp(DAY, '10:00:00')): OptionSnapshot {
  return quoted(symbol, 2 - relativeSpread, 2 + relativeSpread, quotedAt);
}

function quoted(symbol: string, bid: number, ask: number, quotedAt = easternClock.timestamp(DAY, '10:00:00')): OptionSnapshot {
  return { S: symbol, f: 'a', contract: contract(symbol), lq: { S: symbol, bp: bid, bs: 1, ap: ask, as: 1, t: quotedAt }, iv: 0.3 };
}

function repeat(count: number, make: (index: number) => OptionSnapshot): OptionSnapshot[] {
  return Array.from({ length: count }, (_, index) => make(index));
}

function spotBar(at: number): Bar {
  return { S: 'AMZN', o: SPOT, h: SPOT, l: SPOT, c: SPOT, v: 1, t: at - 60_000 };
}

class FakeClient {
  pages: ReadonlyArray<ReadonlyArray<OptionSnapshot>> = [[]];
  bars: ReadonlyArray<Bar> | undefined = undefined;
  requests = 0;

  constructor(private readonly clock: () => number) {}

  async minuteBars(): Promise<unknown> {
    this.requests += 1;
    return { bars: this.bars ?? [spotBar(this.clock())] };
  }

  async optionChain(request: { startAfter?: string }): Promise<unknown> {
    this.requests += 1;
    const index = request.startAfter === undefined ? 0 : Number(request.startAfter);
    return { contracts: this.pages[index], resumeFrom: index + 1 < this.pages.length ? String(index + 1) : undefined };
  }
}

interface Setup {
  readonly helper: OptionsQuoteSpreadHelperImpl;
  readonly client: FakeClient;
  readonly file: string;
  setNow(timestamp: number): void;
}

function setup(): Setup {
  const cachePath = mkdtempSync(join(tmpdir(), 'fleece-quote-spread-'));
  let now = CAPTURED_AT;
  const clock = (): number => now;
  const client = new FakeClient(clock);
  // The fake implements the slice of the client this helper touches, which the compiler cannot know.
  const helper = new OptionsQuoteSpreadHelperImpl(cachePath, client as unknown as AlpacaMarketDataClient, clock);
  return {
    helper,
    client,
    file: resolve(cachePath, 'options-quote-spread', 'AMZN.jsonl'),
    setNow: (timestamp) => {
      now = timestamp;
    },
  };
}

function atTheMoneyNear(relativeSpread: number): OptionSnapshot[] {
  return repeat(20, (index) => snapshot(occ(NEAR, index % 2 === 0 ? 'C' : 'P', 98 + index * 0.2), relativeSpread));
}

async function capture(state: Setup, ...pages: ReadonlyArray<OptionSnapshot>[]): Promise<void> {
  state.client.pages = pages;
  await state.helper.save('amzn');
}

const NEAR_CALL = contract(occ(NEAR, 'C', 100));

describe('OptionsQuoteSpreadHelperImpl.save', () => {
  it('appends each capture as one line holding the whole raw chain and the spot bar', async () => {
    const state = setup();
    await capture(state, [snapshot(occ(NEAR, 'C', 100), 0.1)], [snapshot(occ(NEAR, 'P', 100), 0.1)]);
    state.setNow(easternClock.timestamp(DAY, '14:00:00'));
    await capture(state, [snapshot(occ(FAR, 'C', 100), 0.1)]);

    const lines = readFileSync(state.file, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);

    const first: unknown = JSON.parse(lines[0]);
    expect(first).toEqual({
      underlying: 'AMZN',
      capturedAt: CAPTURED_AT,
      underlyingBar: spotBar(CAPTURED_AT),
      contracts: [snapshot(occ(NEAR, 'C', 100), 0.1), snapshot(occ(NEAR, 'P', 100), 0.1)],
    });
    expect(JSON.parse(lines[1])).toMatchObject({ capturedAt: easternClock.timestamp(DAY, '14:00:00'), contracts: [{ S: occ(FAR, 'C', 100) }] });
  });

  it('refuses outside regular hours without asking Alpaca or writing anything', async () => {
    const state = setup();
    state.setNow(easternClock.timestamp(DAY, '20:00:00'));

    await expect(capture(state, atTheMoneyNear(0.1))).rejects.toThrow(/outside regular hours/);
    expect(state.client.requests).toBe(0);
    expect(existsSync(state.file)).toBe(false);
  });

  it('writes nothing when there is no recent underlying bar to take spot from', async () => {
    const state = setup();
    state.client.bars = [];

    await expect(capture(state, atTheMoneyNear(0.1))).rejects.toThrow(/no AMZN minute bar/);
    expect(existsSync(state.file)).toBe(false);
  });

  it('refuses to append after a cut-off last line, which would glue the two together', async () => {
    const state = setup();
    mkdirSync(resolve(state.file, '..'), { recursive: true });
    writeFileSync(state.file, '{"underlying":"AM');

    await expect(capture(state, atTheMoneyNear(0.1))).rejects.toThrow(/cut off mid-write/);
    expect(readFileSync(state.file, 'utf8')).toBe('{"underlying":"AM');
  });
});

describe('OptionsQuoteSpreadHelperImpl.estimateQuote', () => {
  const at = CAPTURED_AT;

  it("lays half the group's median relative spread either side of the reference price", async () => {
    const state = setup();
    await capture(state, atTheMoneyNear(0.1));

    const quote = await state.helper.estimateQuote({ contract: NEAR_CALL, underlyingPrice: SPOT, referencePrice: 5, timestamp: at });
    expect(quote.bid).toBeCloseTo(4.75, 9);
    expect(quote.ask).toBeCloseTo(5.25, 9);
    expect(quote.spread).toBeCloseTo(0.5, 9);
  });

  it('counts quotes from every capture in the file, including one saved after the first estimate', async () => {
    const state = setup();
    await capture(state, atTheMoneyNear(0.1));
    await state.helper.estimateQuote({ contract: NEAR_CALL, underlyingPrice: SPOT, referencePrice: 10, timestamp: at });

    state.setNow(easternClock.timestamp(DAY, '14:00:00'));
    await capture(state, atTheMoneyNear(0.3));

    // 20 at 0.1 and 20 at 0.3.
    const quote = await state.helper.estimateQuote({ contract: NEAR_CALL, underlyingPrice: SPOT, referencePrice: 10, timestamp: at });
    expect(quote.spread).toBeCloseTo(2, 9);
  });

  it.each([
    ['a zero bid', () => quoted(occ(NEAR, 'C', 100), 0, 0.5)],
    ['a crossed quote', () => quoted(occ(NEAR, 'C', 100), 2.5, 1.5)],
    ['a quote left over from the previous session', () => snapshot(occ(NEAR, 'C', 100), 0.9, easternClock.timestamp('2024-03-01', '15:59:00'))],
    ['an adjusted root', () => snapshot(occ(NEAR, 'C', 100, '1AMZN'), 0.9)],
    ['a contract without a quote', () => ({ ...snapshot(occ(NEAR, 'C', 100), 0.9), lq: undefined })],
  ])('leaves out %s', async (_, make) => {
    const state = setup();
    await capture(state, [...atTheMoneyNear(0.1), ...repeat(25, make)]);

    const quote = await state.helper.estimateQuote({ contract: NEAR_CALL, underlyingPrice: SPOT, referencePrice: 10, timestamp: at });
    expect(quote.spread).toBeCloseTo(1, 9);
  });

  it('answers a thin group from its days-to-expiry group, and a thin one of those from every quote', async () => {
    const state = setup();
    await capture(state, [
      ...atTheMoneyNear(0.1),
      ...repeat(5, () => snapshot(occ(NEAR, 'C', 150), 0.5)),
      ...repeat(15, (index) => snapshot(occ(FAR, 'C', 99 + index * 0.1), 0.9)),
    ]);

    const deepOutOfTheMoney = await state.helper.estimateQuote({ contract: contract(occ(NEAR, 'C', 150)), underlyingPrice: SPOT, referencePrice: 10, timestamp: at });
    expect(deepOutOfTheMoney.spread).toBeCloseTo(1, 9);

    // 20 at 0.1, 5 at 0.5, 15 at 0.9: the middle two are 0.1 and 0.5.
    const farDated = await state.helper.estimateQuote({ contract: contract(occ(FAR, 'C', 100)), underlyingPrice: SPOT, referencePrice: 10, timestamp: at });
    expect(farDated.spread).toBeCloseTo(3, 9);
  });

  it('measures moneyness and days to expiry at the backtest instant, not at capture', async () => {
    const state = setup();
    await capture(state, [...atTheMoneyNear(0.1), ...repeat(20, (index) => snapshot(occ(NEAR, 'C', 111 + index * 0.1), 0.5))]);

    // A 100 call with spot at 90 a week later is 11% out of the money and 11 days out.
    const quote = await state.helper.estimateQuote({ contract: NEAR_CALL, underlyingPrice: 90, referencePrice: 10, timestamp: easternClock.timestamp('2024-03-11', '10:30:00') });
    expect(quote.spread).toBeCloseTo(5, 9);
  });

  it('never quotes a spread narrower than one tick', async () => {
    const state = setup();
    await capture(state, atTheMoneyNear(0.001));

    const cheap = await state.helper.estimateQuote({ contract: NEAR_CALL, underlyingPrice: SPOT, referencePrice: 1, timestamp: at });
    expect(cheap.spread).toBeCloseTo(0.01, 9);
    const dear = await state.helper.estimateQuote({ contract: NEAR_CALL, underlyingPrice: SPOT, referencePrice: 10, timestamp: at });
    expect(dear.spread).toBeCloseTo(0.05, 9);
  });

  it('says to capture first when there is no file for the underlying', async () => {
    const state = setup();
    await expect(state.helper.estimateQuote({ contract: NEAR_CALL, underlyingPrice: SPOT, referencePrice: 10, timestamp: at })).rejects.toThrow(/Run save\('AMZN'\)/);
  });

  it.each([
    ['is not JSON', 'not json'],
    ['is JSON in the wrong shape', '{"capturedAt":"10:30","underlyingBar":{"c":100},"contracts":[]}'],
  ])('names a line that %s, and reads the file again once it is fixed', async (_, bad) => {
    const state = setup();
    await capture(state, atTheMoneyNear(0.1));
    const good = readFileSync(state.file, 'utf8');
    appendFileSync(state.file, `${bad}\n`);

    await expect(state.helper.estimateQuote({ contract: NEAR_CALL, underlyingPrice: SPOT, referencePrice: 10, timestamp: at })).rejects.toThrow(/Line 2 of .*AMZN\.jsonl/);

    writeFileSync(state.file, good);
    const quote = await state.helper.estimateQuote({ contract: NEAR_CALL, underlyingPrice: SPOT, referencePrice: 10, timestamp: at });
    expect(quote.spread).toBeCloseTo(1, 9);
  });
});
