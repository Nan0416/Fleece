import { Decimal, easternClock, type DecimalInput } from '@fleece/utilities';

import { BacktestAccountImpl } from '../../src/backtest/account';
import { TradeReport } from '../../src/backtest/trade-report';

const PUT = 'AAPL250417P00210000';
const OTHER_PUT = 'AAPL250516P00200000';
const DAY = '2025-03-03';

/** An account that reports to a fresh report, and trades at whatever instant it is told. */
class Booked {
  readonly report = new TradeReport();
  readonly account = new BacktestAccountImpl(this.report, 100_000);
  private now = easternClock.timestamp(DAY, '09:00:00');

  constructor() {
    void this.account.init(this.now);
  }

  async open(at: number, symbol: string, size: number, price: DecimalInput, capital: DecimalInput, notes?: Record<string, string>): Promise<void> {
    await this.step(at);
    this.account.record({ symbol, size, price, timestamp: at }, { kind: 'open', commission: '0.65', capital, notes });
  }

  async close(at: number, symbol: string, size: number, price: DecimalInput, reason: string): Promise<void> {
    await this.step(at);
    this.account.record({ symbol, size, price, timestamp: at }, { kind: 'close', commission: '0.65', reason });
  }

  private async step(at: number): Promise<void> {
    if (at > this.now) {
      await this.account.forward(at);
      this.now = at;
    }
  }
}

function at(date: string, time: string): number {
  return easternClock.timestamp(date, time);
}

describe('TradeReport', () => {
  it("takes a round trip's P&L from what the account realized, net of both commissions", async () => {
    const booked = new Booked();
    await booked.open(at(DAY, '11:00:00'), PUT, -1, '2.95', 21_000);
    await booked.close(at('2025-03-20', '14:32:00'), PUT, 1, '1.40', 'take-profit');

    const [trip] = booked.report.roundTrips();
    expect(trip).toMatchObject({ symbol: PUT, reason: 'take-profit', entryTime: at(DAY, '11:00:00'), exitTime: at('2025-03-20', '14:32:00') });
    expect(trip.size.toString()).toBe('-1');
    expect(trip.entryPrice.toString()).toBe('2.95');
    expect(trip.exitPrice.toString()).toBe('1.4');
    expect(trip.commission.toString()).toBe('1.3');
    expect(trip.netPL.toString()).toBe('153.7');
    expect(trip.grossPL.toString()).toBe('155');
    expect(booked.account.realizedPLs()).toEqual([{ symbol: PUT, realizedPL: 153.7 }]);
    expect(booked.report.openTrades()).toEqual([]);
  });

  it('runs a round trip from flat to flat across adds and partial closes, at the average prices', async () => {
    const booked = new Booked();
    await booked.open(at(DAY, '11:00:00'), PUT, -1, '3.00', 21_000, { ivPct: '64' });
    await booked.open(at(DAY, '12:00:00'), PUT, -1, '2.00', 21_000, { ivPct: '70' });
    await booked.close(at(DAY, '13:00:00'), PUT, 1, '1.00', 'partial');

    const [open] = booked.report.openTrades();
    expect(open.size.toString()).toBe('-1');
    expect(open.entryPrice.toString()).toBe('2.5');
    expect(booked.report.roundTrips()).toEqual([]);

    await booked.close(at(DAY, '14:00:00'), PUT, 1, '1.50', 'take-profit');

    const [trip] = booked.report.roundTrips();
    expect(trip).toMatchObject({ reason: 'take-profit', entryTime: at(DAY, '11:00:00'), exitTime: at(DAY, '14:00:00'), notes: { ivPct: '64' } });
    expect(trip.size.toString()).toBe('-2');
    expect(trip.entryPrice.toString()).toBe('2.5');
    expect(trip.exitPrice.toString()).toBe('1.25');
    expect(trip.capital.toString()).toBe('42000');
    expect(trip.commission.toString()).toBe('2.6');
    expect(trip.netPL.toString()).toBe('247.4'); // 300 + 200 in, 100 + 150 out, 2.60 to the broker
  });

  it('summarises wins, losses, averages and exits across round trips', async () => {
    const booked = new Booked();
    await booked.open(at(DAY, '10:00:00'), PUT, -1, '3.00', 21_000);
    await booked.close(at(DAY, '11:00:00'), PUT, 1, '1.50', 'take-profit');
    await booked.open(at(DAY, '12:00:00'), OTHER_PUT, -1, '2.00', 19_000);
    await booked.close(at(DAY, '13:00:00'), OTHER_PUT, 1, '6.00', 'stop-loss');

    const summary = booked.report.summary();
    expect(summary.roundTrips).toBe(2);
    expect(summary.wins).toBe(1);
    expect(summary.losses).toBe(1);
    expect(summary.averageWin?.toString()).toBe('148.7');
    expect(summary.averageLoss?.toString()).toBe('-401.3');
    expect(summary.commissions.toString()).toBe('2.6');
    expect(summary.grossPL.toString()).toBe('-250');
    expect(summary.netPL.toString()).toBe('-252.6');
    expect(summary.averageCapital?.toString()).toBe('20000');
    expect(summary.returnOnAverageCapital?.toString()).toBe('-1.263');
    expect([...summary.byReason]).toEqual([
      ['take-profit', 1],
      ['stop-loss', 1],
    ]);
  });

  it('counts a trade that made less than its commissions as a loss', async () => {
    const booked = new Booked();
    await booked.open(at(DAY, '10:00:00'), PUT, -1, '1.00', 21_000);
    await booked.close(at(DAY, '11:00:00'), PUT, 1, '0.99', 'dte');

    expect(booked.report.summary().losses).toBe(1);
    expect(booked.report.summary().wins).toBe(0);
  });

  it('keeps a trade still open out of the totals, and says it is open', async () => {
    const booked = new Booked();
    await booked.open(at(DAY, '11:00:00'), PUT, -1, '2.95', 21_000, { ivPct: '64' });

    expect(booked.report.summary().roundTrips).toBe(0);
    expect(booked.report.summary().netPL.isZero()).toBe(true);
    expect(booked.report.render().join('\n')).toContain('Still open at the end of the run (1)');
    expect(booked.report.render().join('\n')).toContain(`${PUT}  -1 @ 2.95  ivPct 64`);
  });

  it('refuses a close it never saw opened, rather than inventing the entry', () => {
    const report = new TradeReport();
    const time = at(DAY, '11:00:00');
    expect(() =>
      report.record({
        symbol: PUT,
        size: Decimal.of(1),
        price: Decimal.of('1.40'),
        commission: Decimal.of('0.65'),
        totalCost: Decimal.of('140.65'),
        time,
        realizedPL: Decimal.of('153.7'),
        context: { kind: 'close', commission: '0.65', reason: 'take-profit' },
      }),
    ).toThrow('never opened');
  });

  it('prints one line per round trip with its reason and notes', async () => {
    const booked = new Booked();
    await booked.open(at(DAY, '11:00:00'), PUT, -1, '2.95', 21_000, { delta: '-0.201', ivPct: '64' });
    await booked.close(at('2025-03-20', '14:32:00'), PUT, 1, '1.40', 'take-profit');

    const line = booked.report.render()[1];
    expect(line).toContain('2025-03-03 11:00 -> 2025-03-20 14:32');
    expect(line).toContain('-1 @ 2.95 -> 1.40');
    expect(line).toContain('net   +153.70');
    expect(line).toContain('roc  +0.73%');
    expect(line).toContain('take-profit');
    expect(line).toContain('delta -0.201  ivPct 64');
  });
});
