import { Bar, impliedVolatility, marketState, type OccSymbol } from '@fleece/marketdata';
import { easternClock, LoggerFactory, mapWithConcurrency } from '@fleece/utilities';

import { BacktestAccountImpl, } from '../backtest/account';
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
    const referenceTime = this.timestamp - 90_000; // 90 seconds
    if (marketState(referenceTime) !== 'open') {
      return undefined;
    }

    const time = easternClock.time(referenceTime);
    if (!GRID_TIME.test(time)) {
        return undefined;
    }

    const date = easternClock.date(this.timestamp);
    const segmentStartTime = referenceTime - 30 * MINUTE;
    const {bars: minuteBars } = await this.data.minuteBars({symbol: this.symbol, from: segmentStartTime, to: referenceTime});
    if (minuteBars.length === 0) {
        return undefined;
    }

    const timestampToStockBar: Map<number, Bar> = new Map();
    minuteBars.forEach(bar => timestampToStockBar.set(bar.t, bar));

    const spotPrice = minuteBars[0].c;
    const occSymbols = await this.availabilities.availableOptions(this.symbol, segmentStartTime);
    
    const outOfMoneyCallOptions = occSymbols.filter(symbol => symbol.type === 'call' && symbol.strike > spotPrice && symbol.strike < spotPrice * 1.1 && daysToExpiration(date, symbol.expiration) <= 30 && symbol.root === symbol.underlying);
    const outOfMoneyPutOptions = occSymbols.filter(symbol => symbol.type === 'put' && symbol.strike < spotPrice && symbol.strike > spotPrice * 0.9 && daysToExpiration(date, symbol.expiration) <= 30 && symbol.root === symbol.underlying);
    const optionOccSymbols = outOfMoneyCallOptions.concat(outOfMoneyPutOptions);
    
    const referenceOptions: SpotPriceWithOptionPrice[] = [];
    await mapWithConcurrency(optionOccSymbols, 20, async (occSymbol) => {
        const { bars } = await this.data.optionMinuteBars({ symbol: occSymbol.symbol, from: segmentStartTime, to: referenceTime });
        for (const optionBar of bars) {
            const stockBar = timestampToStockBar.get(optionBar.t);
            if (stockBar) {
                const tYears = (easternClock.timestamp(occSymbol.expiration, EXPIRY_TIME) - (optionBar.t + MINUTE)) / MS_PER_YEAR;
                if (tYears <= 0 || stockBar.c <= 0 || optionBar.c <= 0) {
                    throw new Error('todo')
                }
                const iv = impliedVolatility(optionBar.c, { spot: stockBar.c, strike: occSymbol.strike, tYears, type: occSymbol.type, rate: RISK_FREE_RATE, dividendYield: this.dividendYield });
                if (iv === undefined) {
                    logger.warn('todo')
                    continue;
                }
                referenceOptions.push({time: stockBar.t, spotPrice: stockBar.c, optionPrice: optionBar.c, occSymbol: occSymbol, iv: iv});
                return
            }
        }
    });


    if (referenceOptions.length === 0) {
        this.points.push({date: date, time: easternClock.time(segmentStartTime), averageIv: undefined});
    } else {
        const averageIv = referenceOptions.map(ref => ref.iv).reduce((a, b) => a + b, 0) / referenceOptions.length;
        this.points.push({date: date, time: easternClock.time(segmentStartTime), averageIv: averageIv});
    }

    const point = this.points.at(-1);
    console.log(`${point?.date} ${point?.time}, iv ${point?.averageIv}`)

    

    return undefined;
  }
}


const SYMBOL = 'FXY';

const DIVIDEND_YIELD = 0.00;
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
