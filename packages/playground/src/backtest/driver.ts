import { nanoid } from 'nanoid';
import type { BacktestAccount, BacktestPortfolio, Trade } from './account';
import type { BacktestMarketData, MarketData } from './marketdata';
import type { Time } from './time';

export interface Strategy {
  readonly strategyId: string;
  readonly data: MarketData;
  readonly portfolio: BacktestPortfolio;
  evaluate(timestamp: number): Promise<ReadonlyArray<Trade> | undefined>;
}

export abstract class BaseStrategy implements Strategy {
  readonly strategyId: string;
  private _data?: MarketData;
  private _portfolio?: BacktestPortfolio;

  /** Generated unless given; `addStrategy` replaces a strategy added again under the same id. */
  constructor(strategyId: string = 'strategy' + nanoid()) {
    this.strategyId = strategyId;
  }

  bindMarketData(data: MarketData): void {
    this._data = data;
  }

  bindPortfolio(portfolio: BacktestPortfolio): void {
    this._portfolio = portfolio;
  }

  get data(): MarketData {
    if (this._data === undefined) {
      throw new Error(`Strategy ${this.strategyId} has no market data yet. Add it to a BacktestDriver with addStrategy before it evaluates.`);
    }
    return this._data;
  }

  get portfolio(): BacktestPortfolio {
    if (this._portfolio === undefined) {
      throw new Error(`Strategy ${this.strategyId} has no portfolio yet. Add it to a BacktestDriver with addStrategy before it evaluates.`);
    }
    return this._portfolio;
  }

  abstract evaluate(timestamp: number): Promise<ReadonlyArray<Trade> | undefined>;
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

  addStrategy(strategy: BaseStrategy): void {
    this.removeStrategy(strategy.strategyId);
    this.strategies.push(strategy);
    strategy.bindMarketData(this.marketData);
    strategy.bindPortfolio(this.account);
  }

  removeStrategy(strategyId: string): void {
    this.strategies = this.strategies.filter((item) => item.strategyId !== strategyId);
  }

  async run(): Promise<void> {
    await this.time.init();

    while (await this.time.forward()) {
      await this.runStrategies();
    }
  }

  private async runStrategies(): Promise<void> {
    for (let i = 0; i < this.strategies.length; i++) {
      const strategy = this.strategies[i];
      const trades = (await strategy.evaluate(this.time.timestamp)) ?? [];
      for (let j = 0; j < trades.length; j++) {
        this.account.record(trades[j]);
      }
    }
  }
}
