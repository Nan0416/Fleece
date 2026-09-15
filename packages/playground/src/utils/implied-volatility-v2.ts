import { Bar, impliedVolatility, marketHour, type OccSymbol } from '@fleece/marketdata';
import { easternClock, LoggerFactory, mapWithConcurrency } from '@fleece/utilities';

import { BacktestAccountImpl } from '../backtest/account';
import { BacktestDriver, BaseStrategy, type StrategyTrade } from '../backtest/driver';
import { BacktestMarketDataImpl } from '../backtest/marketdata';
import { BacktestTime } from '../backtest/time';
import { TradeReport } from '../backtest/trade-report';
import { marketDataClient, optionsAvailabilitiesHelper } from '../client';
import { daysToExpiration } from '../utils/option-selection';
import { OptionsAvailabilitiesHelper } from './options-availabilities';

const logger = LoggerFactory.getLogger('SellPut');

const RUN_FROM = '2025-01-01';
const RUN_TO = '2026-08-31';
const EXPIRY_TIME = '16:00:00';
const RISK_FREE_RATE = 0.043;
const MINUTE = 60_000;
const MS_PER_YEAR = 365 * 24 * 60 * MINUTE;

/** Alpaca's rate limit is what the other sweeps stay under at 10, and the client does not retry a 429. */
const FETCH_CONCURRENCY = 10;

/** Within 10% of the stock on the far side of the money: above it for a call, below it for a put. */
function outOfTheMoney(occSymbol: OccSymbol, spotPrice: number): boolean {
  return occSymbol.type === 'call' ? occSymbol.strike > spotPrice && occSymbol.strike < spotPrice * 1.1 : occSymbol.strike < spotPrice && occSymbol.strike > spotPrice * 0.9;
}

/**
 * When a contract stops trading: its expiration date's close, which is 13:00 on a half day,
 * and 16:00 for a date outside the market-hours table.
 */
function expirationClose(expiration: string): number {
  return marketHour(expiration)?.closeAt ?? easternClock.timestamp(expiration, EXPIRY_TIME);
}

interface SpotPriceWithOptionPrice {
  readonly time: number;
  readonly spotPrice: number;
  readonly optionPrice: number;
  readonly iv: number;
  readonly occSymbol: OccSymbol;
}

export interface ImpliedVolatilityHistoryV2Props {
  /** The stock whose puts are sold. */
  readonly symbol: string;
  readonly dividendYield: number;
  readonly availabilities: OptionsAvailabilitiesHelper;
}

export interface ImpliedVolatilityPoint {
  readonly date: string;
  readonly time: string;
  readonly averageIv?: number;
}

export interface ImpliedVolatilityHistoryResponse {
  /** Ascending by date. A session whose sample was not measured, or does not solve, is absent. */
  readonly points: ReadonlyArray<ImpliedVolatilityPoint>;
}

const GRID_TIME = /^\d{2}:(00|30):00$/;

export class ImpliedVolatilityHistoryV2 extends BaseStrategy {
  private readonly symbol: string;
  private readonly dividendYield: number;
  private readonly availabilities: OptionsAvailabilitiesHelper;
  private readonly points: ImpliedVolatilityPoint[];

  constructor(props: ImpliedVolatilityHistoryV2Props) {
    const symbol = props.symbol.trim().toUpperCase();
    super(`implied-volatility-history-${symbol}`);
    this.symbol = symbol;
    this.dividendYield = props.dividendYield;
    this.availabilities = props.availabilities;
    this.points = [];
  }

  async init(): Promise<void> {
    // await this.availabilities.save(this.symbol);
  }

  async tick(): Promise<ReadonlyArray<StrategyTrade> | undefined> {
    // The end of the chunk. The clock steps every 30 s, so the chunk ending 10:00 is taken at
    // 10:01:30, once its 09:59 bar has been published.
    const referenceTime = this.timestamp - 90_000; // 90 seconds
    const time = easternClock.time(referenceTime);
    if (!GRID_TIME.test(time)) {
      return undefined;
    }

    // By the session's hours rather than the market state at the chunk's end, which reads the
    // close itself as closed and so skipped the last half hour of every session.
    const segmentStartTime = referenceTime - 30 * MINUTE;
    const session = marketHour(segmentStartTime);
    if (session === undefined || segmentStartTime < session.openAt || referenceTime > session.closeAt) {
      return undefined;
    }

    const date = easternClock.date(referenceTime);
    // Fetched without `to`, which is compared with a bar's end plus its publishing delay and so
    // dropped the chunk's last minute. The clock already holds back what is not published yet,
    // and the chunk is its bars from its start up to, not including, its end.
    const { bars: sessionBars } = await this.data.minuteBars({ symbol: this.symbol, from: segmentStartTime });
    const minuteBars = sessionBars.filter((bar) => bar.t >= segmentStartTime && bar.t < referenceTime);
    if (minuteBars.length === 0) {
      return undefined;
    }

    const timestampToStockBar: Map<number, Bar> = new Map();
    minuteBars.forEach((bar) => timestampToStockBar.set(bar.t, bar));

    // Wide enough for the stock's price at every minute of the chunk: whether a contract is out
    // of the money is decided against the minute it traded, not the chunk's first.
    const lowestSpotPrice = Math.min(...minuteBars.map((bar) => bar.c));
    const highestSpotPrice = Math.max(...minuteBars.map((bar) => bar.c));
    // Listed as of the chunk's last minute, so a contract that first trades part way through is in.
    const occSymbols = await this.availabilities.availableOptions(this.symbol, referenceTime - MINUTE);
    const optionOccSymbols = occSymbols.filter(
      (symbol) =>
        daysToExpiration(date, symbol.expiration) <= 30 && symbol.root === symbol.underlying && symbol.strike > lowestSpotPrice * 0.9 && symbol.strike < highestSpotPrice * 1.1,
    );

    const referenceOptions: SpotPriceWithOptionPrice[] = [];
    await mapWithConcurrency(optionOccSymbols, FETCH_CONCURRENCY, async (occSymbol) => {
      const { bars } = await this.data.optionMinuteBars({ symbol: occSymbol.symbol, from: segmentStartTime });
      // The earliest trade in the chunk that has a stock bar at its minute and is out of the
      // money against it. One that cannot be priced is passed over for the next rather than
      // stopping the run.
      for (const optionBar of bars) {
        const stockBar = timestampToStockBar.get(optionBar.t);
        if (stockBar === undefined || !outOfTheMoney(occSymbol, stockBar.c)) {
          continue;
        }
        const tYears = (expirationClose(occSymbol.expiration) - (optionBar.t + MINUTE)) / MS_PER_YEAR;
        if (tYears <= 0 || stockBar.c <= 0 || optionBar.c <= 0) {
          continue;
        }
        const iv = impliedVolatility(optionBar.c, {
          spot: stockBar.c,
          strike: occSymbol.strike,
          tYears,
          type: occSymbol.type,
          rate: RISK_FREE_RATE,
          dividendYield: this.dividendYield,
        });
        if (iv === undefined) {
          logger.warn(
            `${occSymbol.symbol} closed at ${optionBar.c} in the ${easternClock.date(optionBar.t)} ${easternClock.time(optionBar.t)} bar, which has no implied volatility against ${this.symbol} at ${stockBar.c} with ${(tYears * 365).toFixed(2)} days left: outside the no-arbitrage band, as a leg of a multi-leg trade often is. Trying its next trade in the chunk.`,
          );
          continue;
        }
        referenceOptions.push({ time: stockBar.t, spotPrice: stockBar.c, optionPrice: optionBar.c, occSymbol: occSymbol, iv: iv });
        return;
      }
    });

    if (referenceOptions.length === 0) {
      this.points.push({ date: date, time: easternClock.time(segmentStartTime), averageIv: undefined });
    } else {
      const averageIv = referenceOptions.map((ref) => ref.iv).reduce((a, b) => a + b, 0) / referenceOptions.length;
      this.points.push({ date: date, time: easternClock.time(segmentStartTime), averageIv: averageIv });
    }

    const point = this.points.at(-1);
    console.log(`${point?.date} ${point?.time}, iv ${point?.averageIv}`);

    return undefined;
  }
}

const SYMBOL = 'FXY';

const DIVIDEND_YIELD = 0.0;
async function main(): Promise<void> {
  const time = new BacktestTime(easternClock.timestamp(RUN_FROM), easternClock.timestamp(RUN_TO, '23:59:59'), 30_000);
  const client = marketDataClient();
  const availabilities = optionsAvailabilitiesHelper(client);
  const marketData = new BacktestMarketDataImpl(client, availabilities);
  const report = new TradeReport();
  const account = new BacktestAccountImpl(report);

  const driver = new BacktestDriver({ time, marketData, account });
  driver.addStrategy(new ImpliedVolatilityHistoryV2({ symbol: SYMBOL, dividendYield: DIVIDEND_YIELD, availabilities: availabilities }));
  await driver.run();

  for (const line of report.render()) {
    logger.info(line);
  }
}

main().catch((error: unknown) => {
  logger.error(`${String(error)}`);
  process.exitCode = 1;
});
