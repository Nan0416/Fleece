import { Decimal, InvalidRequestError } from '@fleece/utilities';
import { Account, Dividend, HistoricalPosition, Profit } from '../../src/account';
import {
  reviveAccount,
  reviveAccounts,
  reviveBrokerOrderRecord,
  reviveBrokerOrderRecords,
  reviveDividend,
  reviveDividends,
  reviveHistoricalPosition,
  reviveHistoricalPositions,
  reviveOrderFillProgress,
  reviveOrderFillProgressList,
  revivePositions,
  reviveProfit,
  reviveProfits,
  reviveTransactions,
} from '../../src/api/wire';
import { OrderFillProgress } from '../../src/order';

const d = (value: string): Decimal => Decimal.of(value);

/** What the service actually does to a response: `res.json(...)`, then a caller parses it. */
function overTheWire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

/**
 * The revivers are pure functions over a JSON payload, and every one of them below was
 * reached only through the client's integration suite — so a machine without PostgreSQL
 * measured them at nothing and a change to one could land unexamined. Nothing here
 * needs a database, which is the point.
 */
describe('reviveAccount', () => {
  const account: Account = {
    accountId: 'MOMENTUM01',
    name: 'Momentum',
    status: 'active',
    accountType: 'paper',
    createdAt: 1_700_000_000_000,
    lastUpdatedAt: 1_700_000_001_000,
  };

  it('rebuilds an account', () => {
    expect(reviveAccount(overTheWire(account))).toEqual(account);
  });

  it('accepts an empty name, which is a name rather than a missing field', () => {
    expect(reviveAccount(overTheWire({ ...account, name: '' })).name).toBe('');
  });

  it.each([
    ['a status it does not know', { status: 'archived' }],
    ['an account type it does not know', { accountType: 'shadow' }],
    ['a timestamp that is not an integer', { createdAt: 'yesterday' }],
    ['a missing id', { accountId: undefined }],
  ])('refuses %s', (_label, overrides) => {
    expect(() => reviveAccount(overTheWire({ ...account, ...overrides }))).toThrow(InvalidRequestError);
  });

  it('names the field that was wrong', () => {
    expect(() => reviveAccount(overTheWire({ ...account, status: 'archived' }))).toThrow(/account\.status/);
  });
});

describe('list revivers', () => {
  const account: Account = { accountId: 'MOMENTUM01', name: 'Momentum', status: 'active', accountType: 'paper', createdAt: 1, lastUpdatedAt: 1 };

  it('rebuilds every entry', () => {
    expect(reviveAccounts(overTheWire([account, { ...account, accountId: 'CARRY00001' }]))).toHaveLength(2);
  });

  it('accepts an empty list', () => {
    expect(reviveAccounts(overTheWire([]))).toEqual([]);
  });

  it('names the index that failed rather than "an item"', () => {
    // Which of two hundred rows was malformed is the only part of this worth reading.
    expect(() => reviveAccounts(overTheWire([account, { ...account, status: 'archived' }]))).toThrow(/accounts\[1\]\.status/);
  });

  it('refuses something that is not a list at all', () => {
    expect(() => reviveAccounts(overTheWire({}))).toThrow(/must be an array/);
  });
});

describe('revivePositions', () => {
  it('rebuilds each position, keeping every digit a double could not hold', () => {
    const position = {
      accountId: 'MOMENTUM01',
      symbol: 'AAPL',
      assetClass: 'equity',
      size: d('17.666666667'),
      totalCost: d('1793.166666700'),
      multiplier: Decimal.ONE,
      avgPrice: d('101.500000000'),
      premium: d('101.500000000'),
      createdAt: 1,
      lastUpdatedAt: 1,
    };
    const [revived] = revivePositions(overTheWire([position]));
    expect(revived.size.toString()).toBe('17.666666667');
    expect(revived.totalCost.toString()).toBe('1793.1666667');
  });
});

describe('reviveHistoricalPosition', () => {
  const position: HistoricalPosition = { accountId: 'MOMENTUM01', symbol: 'AAPL', assetClass: 'equity', size: d('-10'), updatedAt: 1_700_000_000_000 };

  it('keeps a short negative', () => {
    expect(reviveHistoricalPosition(overTheWire(position)).size.toString()).toBe('-10');
  });

  it('rebuilds a list of them', () => {
    expect(reviveHistoricalPositions(overTheWire([position, position]))).toHaveLength(2);
  });

  it('refuses a size sent as a JSON number', () => {
    // A JSON number is a double, so the precision is gone before it arrives.
    expect(() => reviveHistoricalPosition(overTheWire({ ...position, size: 10.5 }))).toThrow(/must be sent as a string/);
  });
});

describe('reviveProfit', () => {
  const profit: Profit = { accountId: 'MOMENTUM01', symbol: 'AAPL', assetClass: 'equity', profit: d('-12.34'), createdAt: 1, lastUpdatedAt: 1 };

  it('keeps a realised loss negative', () => {
    expect(reviveProfit(overTheWire(profit)).profit.toString()).toBe('-12.34');
  });

  it('rebuilds a list of them', () => {
    expect(reviveProfits(overTheWire([profit]))).toHaveLength(1);
  });

  it('refuses an asset class it does not know', () => {
    expect(() => reviveProfit(overTheWire({ ...profit, assetClass: 'future' }))).toThrow(/profit\.assetClass/);
  });
});

describe('reviveTransactions', () => {
  const transaction = {
    referenceId: 'order-1',
    accountId: 'MOMENTUM01',
    symbol: 'AAPL',
    assetClass: 'equity',
    timestamp: 1_700_000_000_000,
    size: d('-10'),
    totalCost: d('-1000'),
    multiplier: Decimal.ONE,
    avgPrice: d('100'),
    premium: d('100'),
    profit: d('0'),
    roi: d('0'),
    cumulativeSize: Decimal.ZERO,
    cumulativeTotalCost: Decimal.ZERO,
    cumulativeProfit: d('0'),
    cumulativeAvgPrice: Decimal.ZERO,
  };

  it('rebuilds each transaction', () => {
    expect(reviveTransactions(overTheWire([transaction]))).toHaveLength(1);
  });

  it('keeps a break-even apart from realising nothing', () => {
    // `profit: "0"` is a close at exactly the cost basis; an absent one is a trade that
    // realised nothing at all. Collapsing them loses the distinction the ledger keeps.
    const [breakEven] = reviveTransactions(overTheWire([transaction]));
    expect(breakEven.profit?.toString()).toBe('0');

    const [nothing] = reviveTransactions(overTheWire([{ ...transaction, profit: undefined, roi: undefined }]));
    expect(nothing.profit).toBeUndefined();
    expect(nothing.roi).toBeUndefined();
  });
});

describe('reviveDividend', () => {
  const dividend: Dividend = {
    accountId: 'MOMENTUM01',
    symbol: 'AAPL',
    exDividendDate: '2024-02-09',
    size: d('100'),
    amountPerShare: d('0.24'),
    declarationDate: '2024-02-01',
    recordDate: '2024-02-12',
    payDate: '2024-02-15',
    status: 'declared',
  };

  it('rebuilds a dividend', () => {
    expect(reviveDividend(overTheWire(dividend))).toEqual(dividend);
  });

  it('rebuilds a list of them', () => {
    expect(reviveDividends(overTheWire([dividend]))).toHaveLength(1);
  });

  it.each(['declared', 'pending', 'recorded', 'paid'])('accepts the %s status', (status) => {
    expect(reviveDividend(overTheWire({ ...dividend, status })).status).toBe(status);
  });

  it('refuses a status it does not know', () => {
    expect(() => reviveDividend(overTheWire({ ...dividend, status: 'reinvested' }))).toThrow(/dividend\.status/);
  });

  it('keeps a short position negative, which is a dividend owed rather than earned', () => {
    expect(reviveDividend(overTheWire({ ...dividend, size: d('-100') })).size.toString()).toBe('-100');
  });
});

describe('reviveOrderFillProgress', () => {
  const progress: OrderFillProgress = {
    referenceId: 'order-1',
    accountId: 'MOMENTUM01',
    symbol: 'AAPL',
    appliedSize: d('-10'),
    appliedTotalCost: d('-1000'),
    createdAt: 1,
    lastUpdatedAt: 1,
  };

  it('rebuilds the counter', () => {
    expect(reviveOrderFillProgress(overTheWire(progress))).toEqual(progress);
  });

  it('rebuilds a list of them', () => {
    expect(reviveOrderFillProgressList(overTheWire([progress, progress]))).toHaveLength(2);
  });

  it('names the field that was wrong', () => {
    expect(() => reviveOrderFillProgress(overTheWire({ ...progress, appliedSize: undefined }))).toThrow(/progress\.appliedSize/);
  });
});

describe('reviveBrokerOrderRecord', () => {
  it('keeps the broker payload verbatim, so an execution can be replayed', () => {
    // Only `id` is ours to check. The rest is whatever the broker sent, and validating
    // it would mean having an opinion about a schema that is not ours.
    const record = { id: 'order-1', event: 'fill', order: { qty: '10', nested: { anything: true } }, timestamp: '2024-03-01T14:30:00Z' };
    expect(reviveBrokerOrderRecord(overTheWire(record))).toEqual(record);
  });

  it('rebuilds a list of them', () => {
    expect(reviveBrokerOrderRecords(overTheWire([{ id: 'a' }, { id: 'b' }]))).toHaveLength(2);
  });

  it('refuses a record with no id, which is the one thing that identifies it', () => {
    expect(() => reviveBrokerOrderRecord(overTheWire({ event: 'fill' }))).toThrow(/record\.id/);
    expect(() => reviveBrokerOrderRecord(overTheWire({ id: '' }))).toThrow(InvalidRequestError);
  });
});
