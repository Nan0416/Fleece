import { marketHour, requireOccSymbol, type Bar, type OccSymbol } from '@fleece/marketdata';
import { easternClock } from '@fleece/utilities';

import type { BacktestMarketData } from '../../src/backtest/marketdata';
import { BacktestTime } from '../../src/backtest/time';
import {
  atTheMoneyVolatility,
  constantMaturityVolatility,
  ConstantMaturityVolatilitySampler,
  HistoricalConstantMaturityVolatility,
  type ExpirationVolatility,
  type OptionTradeVolatility,
} from '../../src/utils/constant-maturity-volatility';
import type { OptionsAvailabilitiesHelper } from '../../src/utils/options-availabilities';

const DAY_YEARS = 1 / 365;
const MINUTE = 60_000;
const DAY = '2024-03-04';
const HALF_HOURS = ['09:30:00', '10:00:00', '10:30:00', '11:00:00', '11:30:00', '12:00:00', '12:30:00', '13:00:00', '13:30:00', '14:00:00', '14:30:00', '15:00:00', '15:30:00'];

function trade(symbol: string, spotPrice: number, iv: number): OptionTradeVolatility {
  const occSymbol: OccSymbol = requireOccSymbol(symbol, 'build a fixture');
  return { time: 0, spotPrice, optionPrice: 1, iv, occSymbol };
}

function expiration(days: number, iv: number): ExpirationVolatility {
  const put = trade('AAPL260417P00095000', 100, iv);
  const call = trade('AAPL260417C00105000', 100, iv);
  return { expiration: `in ${days} days`, tYears: days * DAY_YEARS, iv, put, call };
}

describe('atTheMoneyVolatility', () => {
  it('interpolates to the money in log-moneyness between the nearest out-of-the-money put and call', () => {
    const put = trade('AAPL260417P00095000', 100, 0.3);
    const call = trade('AAPL260417C00110000', 100, 0.2);
    const atTheMoney = atTheMoneyVolatility([put, call]);

    // ln(0.95) = -0.0513 and ln(1.10) = 0.0953, so the money is 35% of the way from the put to the call.
    const share = -Math.log(0.95) / (Math.log(1.1) - Math.log(0.95));
    expect(atTheMoney?.iv).toBeCloseTo(0.3 + (0.2 - 0.3) * share, 12);
    expect(atTheMoney?.put).toBe(put);
    expect(atTheMoney?.call).toBe(call);
  });

  it('uses only the nearest strike on each side, whatever else traded further out', () => {
    const nearPut = trade('AAPL260417P00098000', 100, 0.25);
    const nearCall = trade('AAPL260417C00102000', 100, 0.25);
    const wings = [trade('AAPL260417P00090000', 100, 0.45), trade('AAPL260417C00109000', 100, 0.4)];

    expect(atTheMoneyVolatility([...wings, nearPut, nearCall])?.iv).toBeCloseTo(0.25, 12);
  });

  it('judges each side against the stock at the minute that contract traded', () => {
    // At 97, a 98 call is out of the money and a 98 put is not.
    const put = trade('AAPL260417P00095000', 97, 0.3);
    const inTheMoneyPut = trade('AAPL260417P00098000', 97, 0.9);
    const call = trade('AAPL260417C00098000', 97, 0.3);

    expect(atTheMoneyVolatility([put, inTheMoneyPut, call])?.put).toBe(put);
  });

  it('has nothing to say without a put and a call', () => {
    expect(atTheMoneyVolatility([trade('AAPL260417P00095000', 100, 0.3)])).toBeUndefined();
    expect(atTheMoneyVolatility([trade('AAPL260417C00105000', 100, 0.3)])).toBeUndefined();
    expect(atTheMoneyVolatility([])).toBeUndefined();
  });
});

describe('constantMaturityVolatility', () => {
  const target = 30 * DAY_YEARS;

  it('interpolates total variance between the expirations either side of the target', () => {
    const near = expiration(20, 0.3);
    const next = expiration(40, 0.2);
    const measured = constantMaturityVolatility([next, expiration(10, 0.9), near, expiration(60, 0.1)], target);

    // Half the weight on each: (0.5 × 0.09 × 20 + 0.5 × 0.04 × 40) / 30.
    expect(measured?.iv).toBeCloseTo(Math.sqrt((0.5 * 0.09 * 20 + 0.5 * 0.04 * 40) / 30), 12);
    expect(measured?.near).toBe(near);
    expect(measured?.next).toBe(next);
  });

  it('takes an expiration exactly at the target as it is', () => {
    const exact = expiration(30, 0.27);
    const measured = constantMaturityVolatility([expiration(20, 0.3), exact], target);
    expect(measured?.iv).toBeCloseTo(0.27, 12);
  });

  it('uses the one side there is rather than extrapolating past it', () => {
    expect(constantMaturityVolatility([expiration(24, 0.3)], target)).toMatchObject({ iv: 0.3, next: undefined });
    expect(constantMaturityVolatility([expiration(36, 0.2)], target)).toMatchObject({ iv: 0.2, near: undefined });
  });

  it('has nothing to say without an expiration', () => {
    expect(constantMaturityVolatility([], target)).toBeUndefined();
  });
});

/**
 * Serves a flat $100 stock every minute of a session, holding back a bar until it would have
 * been published, and no option trades. Keeps what was done to its clock, apart from steps.
 */
class FakeMarketData {
  readonly timeSubscriberId = 'fake-marketdata';
  readonly clock: string[] = [];
  current = 0;

  async init(timestamp: number): Promise<void> {
    this.current = timestamp;
    this.clock.push(`init@${timestamp}`);
  }

  async forward(timestamp: number): Promise<void> {
    this.current = timestamp;
  }

  resetTimestamp(): void {
    this.current = 0;
    this.clock.push('reset');
  }

  async minuteBars(request: { readonly symbol: string; readonly from: number }): Promise<unknown> {
    const session = marketHour(request.from);
    const bars: Bar[] = [];
    for (let t = session?.openAt ?? 0; session !== undefined && t < session.closeAt; t += MINUTE) {
      if (t >= request.from && t + MINUTE + 4_000 < this.current) {
        bars.push({ S: request.symbol, o: 100, h: 100, l: 100, c: 100, v: 1, t });
      }
    }
    return { bars };
  }

  async optionMinuteBars(): Promise<unknown> {
    return { bars: [] };
  }
}

/** Lists no contracts. Its refresh time is set, and a `save` moves it to now, as a real sweep would. */
class FakeAvailabilities implements OptionsAvailabilitiesHelper {
  readonly cachePath = '/nowhere';
  saves = 0;

  constructor(private listedAt: number | undefined = Date.now()) {}

  async save(): Promise<void> {
    this.saves += 1;
    this.listedAt = Date.now();
  }

  async availableOptions(): Promise<ReadonlyArray<OccSymbol>> {
    return [];
  }

  async refreshedAt(): Promise<number | undefined> {
    return this.listedAt;
  }
}

function props(data: FakeMarketData, availabilities: OptionsAvailabilitiesHelper = new FakeAvailabilities()) {
  // The fake implements the slice of market data the sampler reads, which the compiler cannot know.
  return { symbol: 'AAPL', dividendYield: 0, data: data as unknown as BacktestMarketData, availabilities, daysToExpiration: { min: 23, target: 30, max: 37 } };
}

describe('ConstantMaturityVolatilitySampler', () => {
  it('refuses a window whose target is outside what it measures', () => {
    const build = (min: number, target: number, max: number) => () =>
      new ConstantMaturityVolatilitySampler({ ...props(new FakeMarketData()), daysToExpiration: { min, target, max } });

    expect(build(23, 30, 37)).not.toThrow();
    expect(build(31, 30, 37)).toThrow('min ≤ target ≤ max');
    expect(build(23, 40, 37)).toThrow('min ≤ target ≤ max');
    expect(build(-1, 30, 37)).toThrow('min ≤ target ≤ max');
  });

  it('takes a point for every half hour of the session, the last included, labelled by where it starts', async () => {
    const data = new FakeMarketData();
    const sampler = new ConstantMaturityVolatilitySampler(props(data));
    const time = new BacktestTime(easternClock.timestamp(DAY), easternClock.timestamp(DAY, '23:59:59'), 30_000).subscribe(data).subscribe(sampler);

    await time.init();
    while (await time.forward()) {
      // Stepping is the sampling.
    }

    const points = sampler.getIvs();
    expect(points.map((point) => point.time)).toEqual(HALF_HOURS);
    expect(points[0]).toMatchObject({ date: DAY, timestamp: easternClock.timestamp(DAY, '09:30:00'), iv: undefined });
  });

  it('hands back a copy of its points, so a caller cannot edit what was measured', () => {
    const sampler = new ConstantMaturityVolatilitySampler(props(new FakeMarketData()));
    expect(sampler.getIvs()).not.toBe(sampler.getIvs());
  });

  it('refreshes the option availability only when it was not refreshed after the latest completed trading day', async () => {
    const fresh = new FakeAvailabilities(Date.now());
    await new ConstantMaturityVolatilitySampler(props(new FakeMarketData(), fresh)).init();
    expect(fresh.saves).toBe(0);

    const stale = new FakeAvailabilities(easternClock.timestamp('2024-01-02', '20:00:00'));
    await new ConstantMaturityVolatilitySampler(props(new FakeMarketData(), stale)).init();
    expect(stale.saves).toBe(1);
  });
});

describe('HistoricalConstantMaturityVolatility', () => {
  const START = easternClock.timestamp(DAY);

  async function precomputed(data: FakeMarketData = new FakeMarketData()): Promise<HistoricalConstantMaturityVolatility> {
    const history = new HistoricalConstantMaturityVolatility({ ...props(data), fromDate: DAY, toDate: DAY });
    await history.init(START);
    return history;
  }

  it('refuses a backtest that starts outside the dates it samples, rather than reading as no volatility', async () => {
    const history = new HistoricalConstantMaturityVolatility({ ...props(new FakeMarketData()), fromDate: DAY, toDate: DAY });

    await expect(history.init(easternClock.timestamp('2024-03-01', '09:30:00'))).rejects.toThrow('outside the 2024-03-04 to 2024-03-04');
    await expect(history.init(easternClock.timestamp('2024-03-05', '09:30:00'))).rejects.toThrow('Set fromDate and toDate to cover the whole run');
  });

  it("hands out a point only once its chunk has ended and the chunk's last bar is published", async () => {
    const history = await precomputed();

    await history.forward(easternClock.timestamp(DAY, '10:00:04'));
    expect(history.getIvs()).toEqual([]);

    await history.forward(easternClock.timestamp(DAY, '10:00:05'));
    expect(history.getIvs().map((point) => point.time)).toEqual(['09:30:00']);

    await history.forward(easternClock.timestamp(DAY, '20:00:00'));
    expect(history.getIvs().map((point) => point.time)).toEqual(HALF_HOURS);
  });

  it('hands out nothing before the clock first steps', async () => {
    expect((await precomputed()).getIvs()).toEqual([]);
  });

  it("puts market data it shares with the backtest back on the backtest's instant once the range is sampled", async () => {
    const data = new FakeMarketData();
    await precomputed(data);

    expect(data.clock).toEqual([`init@${START}`, 'reset', `init@${START}`]);
    expect(data.current).toBe(START);
  });
});
