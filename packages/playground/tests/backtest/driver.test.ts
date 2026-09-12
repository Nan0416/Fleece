import { Decimal } from '@fleece/utilities';

import type { BacktestAccount, Trade, Transaction } from '../../src/backtest/account';
import { BacktestDriver, type Strategy } from '../../src/backtest/driver';
import type { BacktestMarketData } from '../../src/backtest/marketdata';
import { Time } from '../../src/backtest/time';

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;

function trade(symbol: string, timestamp: number): Trade {
  return { symbol, size: 1, timestamp, price: 10 };
}

/**
 * One log across every subscriber and every strategy, because what this class guarantees
 * is an order — who is told what, and when — rather than a value any one of them returns.
 */
interface Journal {
  readonly log: string[];
  marketData(): BacktestMarketData;
  account(): FakeAccount;
}

interface FakeAccount extends BacktestAccount {
  readonly recorded: ReadonlyArray<Trade>;
}

function journal(): Journal {
  const log: string[] = [];
  // Each double implements the slice the driver touches, which the compiler cannot know;
  // the driver never reads a position and never asks market data a question of its own.
  return {
    log,
    marketData: () =>
      ({
        timeSubscriberId: 'marketdata',
        init: async (timestamp: number) => {
          log.push(`marketdata:init@${timestamp}`);
        },
        forward: async (timestamp: number) => {
          log.push(`marketdata@${timestamp}`);
        },
      }) as unknown as BacktestMarketData,
    account: () => {
      const recorded: Trade[] = [];
      return {
        recorded,
        timeSubscriberId: 'account',
        init: async (timestamp: number) => {
          log.push(`account:init@${timestamp}`);
        },
        forward: async (timestamp: number) => {
          log.push(`account@${timestamp}`);
        },
        record: (item: Trade): Transaction => {
          recorded.push(item);
          log.push(`record:${item.symbol}@${item.timestamp}`);
          return { size: Decimal.of(item.size), price: Decimal.of(item.price), totalCost: Decimal.of(0), time: item.timestamp };
        },
      } as unknown as FakeAccount;
    },
  };
}

/** Records the instant it was handed, and trades whatever `orders` says at that instant. */
function strategy(
  strategyId: string,
  log: string[],
  orders: (timestamp: number) => ReadonlyArray<Trade> | undefined = () => undefined,
): Strategy & { readonly seen: ReadonlyArray<number> } {
  const seen: number[] = [];
  return {
    strategyId,
    seen,
    evaluate: async (timestamp: number) => {
      seen.push(timestamp);
      log.push(`${strategyId}:evaluate@${timestamp}`);
      return orders(timestamp);
    },
  };
}

/** Two steps, so there is a first instant, a middle and an end to tell apart. */
function driver(entries: Journal, endingTimestamp: number = T0 + 2 * MINUTE): { subject: BacktestDriver; account: FakeAccount } {
  const account = entries.account();
  const subject = new BacktestDriver({ time: new Time(T0, endingTimestamp, MINUTE), marketData: entries.marketData(), account });
  return { subject, account };
}

describe('BacktestDriver', () => {
  it('evaluates every strategy at the first instant, before the clock has moved off it', async () => {
    const entries = journal();
    const { subject } = driver(entries);
    subject.addStrategy(strategy('alpha', entries.log));

    await subject.run();

    // The opening evaluation is the one a loop written as "step, then evaluate" loses, and
    // losing it is invisible: the run still reports a number, just never having traded on
    // the instant it was asked to start from.
    expect(entries.log.slice(0, 3)).toEqual([`marketdata:init@${T0}`, `account:init@${T0}`, `alpha:evaluate@${T0}`]);
  });

  it('evaluates once per instant the clock visits, the first one included', async () => {
    const entries = journal();
    const { subject } = driver(entries);
    const alpha = strategy('alpha', entries.log);
    subject.addStrategy(alpha);

    await subject.run();

    expect(alpha.seen).toEqual([T0, T0 + MINUTE, T0 + 2 * MINUTE]);
  });

  it('steps market data before the account on every instant, not only the first', async () => {
    const entries = journal();
    const { subject } = driver(entries);

    await subject.run();

    // The account prices nothing itself, but anything that reads a position against the
    // tape between the two sees a portfolio and a market on different instants.
    expect(entries.log).toEqual([
      `marketdata:init@${T0}`,
      `account:init@${T0}`,
      `marketdata@${T0 + MINUTE}`,
      `account@${T0 + MINUTE}`,
      `marketdata@${T0 + 2 * MINUTE}`,
      `account@${T0 + 2 * MINUTE}`,
    ]);
  });

  it('evaluates a strategy only after both subscribers have reached the instant', async () => {
    const entries = journal();
    const { subject } = driver(entries);
    subject.addStrategy(strategy('alpha', entries.log));

    await subject.run();

    // Evaluating between the two would hand the strategy a market at the new instant and a
    // portfolio still on the old one.
    expect(entries.log.indexOf(`alpha:evaluate@${T0 + MINUTE}`)).toBeGreaterThan(entries.log.indexOf(`account@${T0 + MINUTE}`));
  });

  it('records every trade a strategy hands back, in the order it handed them back', async () => {
    const entries = journal();
    const { subject, account } = driver(entries, T0 + MINUTE);
    subject.addStrategy(strategy('alpha', entries.log, (timestamp) => (timestamp === T0 ? [trade('AMZN', T0), trade('SPY', T0)] : undefined)));

    await subject.run();

    expect(account.recorded).toEqual([trade('AMZN', T0), trade('SPY', T0)]);
  });

  it('records nothing for a strategy that chose not to trade', async () => {
    const entries = journal();
    const { subject, account } = driver(entries);
    subject.addStrategy(strategy('alpha', entries.log));

    await subject.run();

    expect(account.recorded).toEqual([]);
  });

  it('evaluates strategies in the order they were added', async () => {
    const entries = journal();
    const { subject } = driver(entries, T0 + MINUTE);
    subject.addStrategy(strategy('alpha', entries.log));
    subject.addStrategy(strategy('beta', entries.log));

    await subject.run();

    expect(entries.log.filter((entry) => entry.includes('evaluate'))).toEqual([
      `alpha:evaluate@${T0}`,
      `beta:evaluate@${T0}`,
      `alpha:evaluate@${T0 + MINUTE}`,
      `beta:evaluate@${T0 + MINUTE}`,
    ]);
  });

  it('replaces a strategy added again under the same id rather than running it twice', async () => {
    const entries = journal();
    const { subject, account } = driver(entries, T0 + MINUTE);
    subject.addStrategy(strategy('alpha', entries.log, () => [trade('AMZN', T0)]));
    subject.addStrategy(strategy('alpha', entries.log, () => [trade('SPY', T0)]));

    await subject.run();

    // Doubling it would double every order it places, which is a position twice the size
    // the strategy thinks it holds.
    expect(account.recorded.map((item) => item.symbol)).toEqual(['SPY', 'SPY']);
  });

  it('stops evaluating a strategy that was removed', async () => {
    const entries = journal();
    const { subject } = driver(entries, T0 + MINUTE);
    subject.addStrategy(strategy('alpha', entries.log));
    subject.addStrategy(strategy('beta', entries.log));
    subject.removeStrategy('alpha');

    await subject.run();

    expect(entries.log.filter((entry) => entry.includes('evaluate'))).toEqual([`beta:evaluate@${T0}`, `beta:evaluate@${T0 + MINUTE}`]);
  });

  it('subscribes market data and the account itself, so a caller cannot forget to', async () => {
    const entries = journal();
    const time = new Time(T0, T0 + MINUTE, MINUTE);
    new BacktestDriver({ time, marketData: entries.marketData(), account: entries.account() });

    await time.init();

    expect(entries.log).toEqual([`marketdata:init@${T0}`, `account:init@${T0}`]);
  });
});
