import type { BacktestAccount, BacktestPortfolio, Trade } from './account';
import type { BacktestMarketData, BacktestMarketDataView } from './marketdata';
import type { Time } from './time';

export interface Strategy {
  readonly strategyId: string;
  evaluate(timestamp: number, data: BacktestMarketDataView, portfolio: BacktestPortfolio): Promise<ReadonlyArray<Trade> | undefined>;
}

export interface BacktestDriverProps {
  readonly time: Time;
  readonly marketData: BacktestMarketData;
  readonly account: BacktestAccount;
}

export class BacktestDriver {
  private readonly time: Time;
  private readonly marketData: BacktestMarketData;
  private readonly account: BacktestAccount;

  private strategies: Strategy[];

  constructor(props: BacktestDriverProps) {
    this.time = props.time;
    this.marketData = props.marketData;
    this.account = props.account;
    this.strategies = [];
    this.time.subscribe(this.marketData); // market data before account
    this.time.subscribe(this.account);
  }

  addStrategy(strategy: Strategy): void {
    this.removeStrategy(strategy.strategyId);
    this.strategies.push(strategy);
  }

  removeStrategy(strategyId: string): void {
    this.strategies = this.strategies.filter((item) => item.strategyId !== strategyId);
  }

  async run(): Promise<void> {
    await this.time.init();
    await this.runStrategies();

    while (await this.time.forward()) {
      await this.runStrategies();
    }
  }

  private async runStrategies(): Promise<void> {
    for (let i = 0; i < this.strategies.length; i++) {
      const strategy = this.strategies[i];
      const trades = (await strategy.evaluate(this.time.timestamp, this.marketData, this.account)) ?? [];
      for (let j = 0; j < trades.length; j++) {
        this.account.record(trades[j]);
      }
    }
  }
}
