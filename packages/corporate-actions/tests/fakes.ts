import { Account, HistoricalPosition, Position } from '@fleece/shared';
import { Dividend, ListDividendsInput, ListDividendsOutput, ListStockSplitsInput, ListStockSplitsOutput, MarketDataClient } from '@fleece/marketdata';

export class FakeAccountService {
  constructor(private readonly accounts: ReadonlyArray<Account>) {}
  async listAccounts(): Promise<{ accounts: ReadonlyArray<Account> }> {
    return { accounts: this.accounts };
  }
}

/**
 * Serves position history from a list, honouring the descending paging the processor
 * does — which is the part of the interaction that can go wrong.
 */
export class FakeLedgerService {
  constructor(
    private readonly positions: ReadonlyArray<Position>,
    private readonly history: ReadonlyArray<HistoricalPosition>,
  ) {}

  async listPositions(): Promise<{ positions: ReadonlyArray<Position> }> {
    return { positions: this.positions };
  }

  async listHistoricalPositions(request: { from: number; limit: number; sort: 'asc' | 'desc' }): Promise<{ positions: ReadonlyArray<HistoricalPosition> }> {
    const matching = this.history.filter((entry) => entry.updatedAt <= request.from).sort((left, right) => right.updatedAt - left.updatedAt);
    return { positions: matching.slice(0, request.limit) };
  }
}

export interface RecordedDividend {
  readonly accountId: string;
  readonly symbol: string;
  readonly size: number;
  readonly amountPerShare: number;
  readonly exDividendDate: string;
}

export class FakeDividendService {
  readonly recorded: RecordedDividend[] = [];
  async recordDividend(request: RecordedDividend): Promise<{ dividend: unknown }> {
    this.recorded.push(request);
    return { dividend: request };
  }
}

export class FakeMarketDataClient implements MarketDataClient {
  readonly dividendQueries: ListDividendsInput[] = [];

  constructor(private readonly dividends: ReadonlyArray<Dividend> = []) {}

  async listDividends(input: ListDividendsInput): Promise<ListDividendsOutput> {
    this.dividendQueries.push(input);
    return { dividends: this.dividends.filter((dividend) => dividend.ticker === input.symbol) };
  }

  async listStockSplits(_input: ListStockSplitsInput): Promise<ListStockSplitsOutput> {
    return { splits: [] };
  }
}

export class ThrowingMarketDataClient implements MarketDataClient {
  async listDividends(): Promise<ListDividendsOutput> {
    throw new Error('Polygon is having a day');
  }
  async listStockSplits(): Promise<ListStockSplitsOutput> {
    return { splits: [] };
  }
}

export function account(accountId: string): Account {
  return { accountId, name: accountId, status: 'active', accountType: 'paper', createdAt: 0, lastUpdatedAt: 0 };
}

export function position(accountId: string, symbol: string, size: number): Position {
  return { accountId, symbol, size, avgPrice: 100, createdAt: 0, lastUpdatedAt: 0 };
}

/** A position as of a given Eastern date, at 15:00 Eastern so the date is unambiguous. */
export function historyEntry(accountId: string, symbol: string, date: string, size: number): HistoricalPosition {
  return { accountId, symbol, size, updatedAt: Date.parse(`${date}T19:00:00Z`) };
}

export function dividend(overrides: Partial<Dividend> & { exDividendDate: string }): Dividend {
  return {
    ticker: 'AAPL',
    cashAmount: 0.25,
    currency: 'USD',
    dividendType: 'CD',
    frequency: 4,
    declarationDate: '2026-02-01',
    recordDate: '2026-02-09',
    payDate: '2026-02-13',
    ...overrides,
  };
}
