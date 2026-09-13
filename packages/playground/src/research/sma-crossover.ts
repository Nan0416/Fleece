import { marketState } from '@fleece/marketdata';
import { easternClock } from '@fleece/utilities';
import { nanoid } from 'nanoid';

import type { BacktestPortfolio, Trade } from '../backtest/account';
import type { Strategy } from '../backtest/driver';
import type { MarketData } from '../backtest/marketdata';

/**
 * The instant of each session the signal is read at, Eastern.
 *
 * It has to be a time the clock actually lands on: a run stepping in minutes visits
 * 12:00:00 once a session, and one stepping in anything that does not divide the minute
 * never visits it at all and the strategy silently never trades.
 */
const EVALUATION_TIME = '12:00:00';

/**
 * Calendar days to ask for to be sure of `sessions` trading days: five sessions a week
 * plus a week of slack for holidays. Asking by date is the only way to ask — the bars
 * endpoint takes a window, not a count — and coming up short is indistinguishable from a
 * symbol that stopped trading.
 *
 * Exported because the run has to load at least this much history before its first
 * instant: `new BacktestMarketDataImpl(..., smaLookbackDays(10) * MS_PER_DAY)`.
 */
export function smaLookbackDays(sessions: number): number {
  return Math.ceil((sessions * 7) / 5) + 7;
}

function mean(values: ReadonlyArray<number>): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Two moving averages of daily closes, one share traded per session on which side is on top.
 *
 * At `EVALUATION_TIME` of every open session, for each symbol: buy one share if the quick
 * average is above the slow one, sell one otherwise. Not on the crossing — on the state,
 * every session, so a run that stays crossed keeps adding and the position turns over
 * enough to exercise the account's FIFO lots and its flip through zero. Nothing bounds the
 * size, so a long downtrend ends up short; `BacktestAccountImpl` assumes infinite margin
 * and will let it.
 *
 * The signal reads daily bars and the trade takes the last minute close, which is what
 * makes this worth running: the averages are of sessions that have *finished* — at noon
 * today's daily bar has not, and `BacktestMarketDataView` withholds it — while the fill is
 * at a price from a minute ago. A strategy that priced itself off the same daily close it
 * signalled on would be trading on a number it could not have had.
 *
 *     const strategy = new SmaCrossoverTrader(['AAPL'], 10, 5, marketData, account);
 *     driver.addStrategy(strategy);
 */
export class SmaCrossoverTrader implements Strategy {
  readonly strategyId: string;

  constructor(
    readonly symbols: ReadonlyArray<string>,
    readonly slowSmaLength: number,
    readonly quickSmaLength: number,
    readonly data: MarketData,
    readonly portfolio: BacktestPortfolio,
  ) {
    if (!Number.isInteger(slowSmaLength) || slowSmaLength < 1 || !Number.isInteger(quickSmaLength) || quickSmaLength < 1) {
      throw new Error(`SMA lengths must be whole numbers of sessions, got quick ${quickSmaLength} and slow ${slowSmaLength}.`);
    }
    // Equal lengths are the same average twice, which is never above itself, so the
    // strategy would sell one share a session forever and read as a working short.
    if (quickSmaLength >= slowSmaLength) {
      throw new Error(`The quick SMA must be shorter than the slow one, got quick ${quickSmaLength} and slow ${slowSmaLength}.`);
    }
    this.strategyId = 'strategy' + nanoid();
  }

  async evaluate(timestamp: number): Promise<ReadonlyArray<Trade> | undefined> {
    if (!this.shouldEvaluate(timestamp)) {
      return undefined;
    }
    const trades: Trade[] = [];
    for (const symbol of this.symbols) {
      const trade = await this.trade(symbol, timestamp);
      if (trade !== undefined) {
        trades.push(trade);
      }
    }
    return trades;
  }

  private shouldEvaluate(timestamp: number): boolean {
    return marketState(timestamp) === 'open' && easternClock.time(timestamp) === EVALUATION_TIME;
  }

  private async trade(symbol: string, timestamp: number): Promise<Trade | undefined> {
    const price = await this.lastPrice(symbol, timestamp);
    // A symbol that has not printed this session has no price to trade at, which is a
    // fact about the tape rather than a misconfiguration: skip it and look again tomorrow.
    if (price === undefined) {
      return undefined;
    }
    const closes = await this.dailyCloses(symbol, timestamp);
    const quick = mean(closes.slice(-this.quickSmaLength));
    const slow = mean(closes.slice(-this.slowSmaLength));
    return { symbol, size: quick > slow ? 1 : -1, timestamp, price };
  }

  /**
   * The closes of the last `slowSmaLength` finished sessions, split-adjusted so a split
   * inside the window does not read as an overnight collapse and cross the averages.
   */
  private async dailyCloses(symbol: string, timestamp: number): Promise<ReadonlyArray<number>> {
    const today = easternClock.date(timestamp);
    const { bars } = await this.data.dailyBars({
      symbol,
      from: easternClock.shiftDate(today, -smaLookbackDays(this.slowSmaLength)),
      adjustForSplit: true,
    });
    // Averaging four closes as though they were ten is a number that looks like a signal.
    if (bars.length < this.slowSmaLength) {
      throw new Error(
        `${symbol} has only ${bars.length} finished daily bars before ${today}, and the slow SMA is ${this.slowSmaLength}. Widen the run's historyBufferMs to at least smaLookbackDays(${this.slowSmaLength}) days.`,
      );
    }
    return bars.map((bar) => bar.c);
  }

  /**
   * The close of the last finished minute, unadjusted — this is the price being paid now,
   * not a price restated into some later share count. The daily closes above are adjusted
   * because they are only ever compared with each other.
   */
  private async lastPrice(symbol: string, timestamp: number): Promise<number | undefined> {
    const { bars } = await this.data.minuteBars({ symbol, from: easternClock.date(timestamp) });
    return bars.length === 0 ? undefined : bars[bars.length - 1].c;
  }
}
