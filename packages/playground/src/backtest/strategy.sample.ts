import { BacktestAccountImpl, Trade } from './account';
import { BacktestDriver, BaseStrategy } from './driver';
import { BacktestMarketDataImpl } from './marketdata';
import { dayOfWeek, easternClock, LoggerFactory } from '@fleece/utilities';
import { marketState } from '@fleece/marketdata';
import { marketDataClient, optionsAvailabilitiesHelper } from '../research';
import { BacktestTime } from './time';

const MS_PER_DAY = 3600_000 * 24;
const SYMBOL = 'AAPL';
const logger = LoggerFactory.getLogger('SampleStrategy');

export class SampleStrategy extends BaseStrategy {
  async tick(): Promise<ReadonlyArray<Trade> | undefined> {
    const timestamp = this.timestamp;
    if (marketState(timestamp) === 'open' && easternClock.time(timestamp) === '10:30:30') {
      const stockPrice = await this.printStockPrice(timestamp);
      if (dayOfWeek(easternClock.date(timestamp)) === 'Wednesday' && typeof stockPrice === 'number') {
        await this.printOptionData(timestamp, stockPrice);
      }
    }
    return undefined;
  }

  private async printStockPrice(timestamp: number) {
    let stockPrice: number | undefined;
    const { bars: previousDayCloseBars } = await this.data.dailyBars({ symbol: SYMBOL, from: timestamp - 5 * MS_PER_DAY });
    const { bars: previousMinuteBars } = await this.data.minuteBars({ symbol: SYMBOL, from: timestamp - 90_000 });
    const message = [`Current time ${easternClock.datetime(timestamp)}`];
    if (previousDayCloseBars.length === 0) {
      message.push('missing previous day close bar');
    } else {
      const bar = previousDayCloseBars[previousDayCloseBars.length - 1];
      message.push(`daily ${easternClock.datetime(bar.t)} ${bar.c}`);
    }

    if (previousMinuteBars.length === 0) {
      message.push('missing previous minute close bar');
    } else {
      const bar = previousMinuteBars[previousMinuteBars.length - 1];
      stockPrice = bar.c;
      message.push(`minute ${easternClock.datetime(bar.t)} ${bar.c}`);
    }
    logger.info(message.join(', '));
    return stockPrice;
  }

  private async printOptionData(timestamp: number, stockPrice: number) {
    const date = easternClock.date(timestamp);
    const expirationFrom = easternClock.shiftDate(date, 40);
    const expirationTo = easternClock.shiftDate(date, 45);
    const resp = await this.data.listActiveOptionContracts({
      underlying: SYMBOL,
      type: 'call',
      strikeFrom: stockPrice * 0.9,
      strikeTo: stockPrice * 1.1,
      expirationFrom: expirationFrom,
      expirationTo: expirationTo,
    });

    let contracts = Array.from(resp.contracts);

    let earliestExpirationDate: string | undefined = undefined;
    for (const contract of contracts) {
      if (earliestExpirationDate === undefined) {
        earliestExpirationDate = contract.expiration;
      } else {
        earliestExpirationDate = earliestExpirationDate.localeCompare(contract.expiration) < 0 ? earliestExpirationDate : contract.expiration;
      }
    }

    contracts = contracts.filter((contract) => contract.expiration === earliestExpirationDate);
    contracts.sort((a1, a2) => a2.strike - a1.strike);

    if (contracts.length > 0) {
      const resp = await this.data.optionDailyBars({
        symbol: contracts[0].symbol,
        from: '2021-01-01',
      });
      if (resp.bars.length > 0) {
        const bar = resp.bars[resp.bars.length - 1];
        logger.info(`Stock price ${stockPrice}, option ${contracts[0].symbol} price at ${easternClock.datetime(bar.t)} is ${bar.c}`);
      }
    }
  }
}

async function main(): Promise<void> {
  const time = new BacktestTime(easternClock.timestamp('2025-01-01'), easternClock.timestamp('2026-08-31', '23:59:59'), 30_000);
  const client = marketDataClient();
  const optionsHelper = optionsAvailabilitiesHelper(client);
  const marketData = new BacktestMarketDataImpl(client, optionsHelper);
  const account = new BacktestAccountImpl();

  const driver = new BacktestDriver({
    time: time,
    marketData: marketData,
    account: account,
  });

  driver.addStrategy(new SampleStrategy());

  await driver.run();
}

main().catch((error: unknown) => {
  logger.error(`${String(error)}`);
  process.exitCode = 1;
});
