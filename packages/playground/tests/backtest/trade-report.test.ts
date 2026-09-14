import { easternClock } from '@fleece/utilities';

import { BacktestAccountImpl, type Trade } from '../../src/backtest/account';
import { TradeReport } from '../../src/backtest/trade-report';

const PUT = 'AAPL250417P00210000';
const OTHER_PUT = 'AAPL250516P00200000';
const T0 = easternClock.timestamp('2025-03-03', '11:00:00');
const T1 = easternClock.timestamp('2025-03-20', '14:32:00');

function trade(symbol: string, size: number, price: string, timestamp: number): Trade {
  return { symbol, size, price, timestamp };
}

describe('TradeReport', () => {
  it('prices a short put round trip with the multiplier and nets out both commissions', () => {
    const report = new TradeReport();
    report.opened({ trade: trade(PUT, -1, '2.95', T0), commission: '0.65', capital: 21_000 });
    const trip = report.closed({ trade: trade(PUT, 1, '1.40', T1), commission: '0.65', reason: 'take-profit' });

    expect(trip.grossPL.toString()).toBe('155');
    expect(trip.netPL.toString()).toBe('153.7');
    expect(report.openTrades()).toEqual([]);
  });

  it('agrees to the cent with what the account books for the same fills', async () => {
    const account = new BacktestAccountImpl();
    const report = new TradeReport();
    await account.init(T0 - 1);

    await account.forward(T0);
    const open = trade(PUT, -2, '3.17', T0);
    account.record(open);
    report.opened({ trade: open, commission: '1.30', capital: 42_000 });

    await account.forward(T1);
    const close = trade(PUT, 2, '6.83', T1);
    account.record(close);
    report.closed({ trade: close, commission: '1.30', reason: 'stop-loss' });

    expect(report.summary().grossPL.toNumber()).toBe(account.realizedPLs()[0].realizedPL);
  });

  it('summarises wins, losses, averages and exits across round trips', () => {
    const report = new TradeReport();
    report.opened({ trade: trade(PUT, -1, '3.00', T0), commission: '0.65', capital: 21_000 });
    report.closed({ trade: trade(PUT, 1, '1.50', T1), commission: '0.65', reason: 'take-profit' });
    report.opened({ trade: trade(OTHER_PUT, -1, '2.00', T1), commission: '0.65', capital: 19_000 });
    report.closed({ trade: trade(OTHER_PUT, 1, '6.00', T1 + 60_000), commission: '0.65', reason: 'stop-loss' });

    const summary = report.summary();
    expect(summary.roundTrips).toBe(2);
    expect(summary.wins).toBe(1);
    expect(summary.losses).toBe(1);
    expect(summary.averageWin?.toString()).toBe('148.7');
    expect(summary.averageLoss?.toString()).toBe('-401.3');
    expect(summary.commissions.toString()).toBe('2.6');
    expect(summary.netPL.toString()).toBe('-252.6');
    expect(summary.averageCapital?.toString()).toBe('20000');
    expect(summary.returnOnAverageCapital?.toString()).toBe('-1.263');
    expect([...summary.byReason]).toEqual([
      ['take-profit', 1],
      ['stop-loss', 1],
    ]);
  });

  it('counts a trade that made less than its commissions as a loss', () => {
    const report = new TradeReport();
    report.opened({ trade: trade(PUT, -1, '1.00', T0), commission: '0.65', capital: 21_000 });
    report.closed({ trade: trade(PUT, 1, '0.99', T1), commission: '0.65', reason: 'dte' });

    expect(report.summary().losses).toBe(1);
    expect(report.summary().wins).toBe(0);
  });

  it('keeps a trade still open out of the totals, and says it is open', () => {
    const report = new TradeReport();
    report.opened({ trade: trade(PUT, -1, '2.95', T0), commission: '0.65', capital: 21_000, notes: { ivPct: '64' } });

    expect(report.summary().roundTrips).toBe(0);
    expect(report.summary().netPL.isZero()).toBe(true);
    expect(report.render().join('\n')).toContain(`Still open at the end of the run (1)`);
    expect(report.render().join('\n')).toContain(`${PUT}  -1 @ 2.95  ivPct 64`);
  });

  it('refuses to pair anything but one open and one close that flattens it', () => {
    const report = new TradeReport();
    expect(() => report.closed({ trade: trade(PUT, 1, '1.00', T1), commission: 0, reason: 'dte' })).toThrow('never opened');

    report.opened({ trade: trade(PUT, -2, '2.95', T0), commission: 0, capital: 42_000 });
    expect(() => report.opened({ trade: trade(PUT, -1, '2.95', T0), commission: 0, capital: 21_000 })).toThrow('already open');
    expect(() => report.closed({ trade: trade(PUT, 1, '1.00', T1), commission: 0, reason: 'dte' })).toThrow('flattens the whole position');
  });

  it('prints one line per round trip with its reason and notes', () => {
    const report = new TradeReport();
    report.opened({ trade: trade(PUT, -1, '2.95', T0), commission: '0.65', capital: 21_000, notes: { delta: '-0.201', ivPct: '64' } });
    report.closed({ trade: trade(PUT, 1, '1.40', T1), commission: '0.65', reason: 'take-profit' });

    const line = report.render()[1];
    expect(line).toContain('2025-03-03 11:00 -> 2025-03-20 14:32');
    expect(line).toContain('-1 @ 2.95 -> 1.40');
    expect(line).toContain('net   +153.70');
    expect(line).toContain('roc  +0.73%');
    expect(line).toContain('take-profit');
    expect(line).toContain('delta -0.201  ivPct 64');
  });
});
