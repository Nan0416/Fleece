import { Decimal, easternClock, LEDGER_SCALE, sumDecimals } from '@fleece/utilities';

import type { Transaction, TransactionRecorder } from './account';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const PERCENT = Decimal.of(100);

export interface OpenTrade {
  readonly symbol: string;
  /** What is held now, signed: negative for a short. */
  readonly size: Decimal;
  /** Per share, the opening fills' prices averaged by size, before commission. */
  readonly entryPrice: Decimal;
  /** When the first opening fill booked. */
  readonly entryTime: number;
  /** The opening fills' capital, added up. */
  readonly capital: Decimal;
  /** The first opening fill's. */
  readonly notes: Readonly<Record<string, string>>;
}

/** A position from the fill that opened it to the fill that left it flat. */
export interface RoundTrip {
  readonly symbol: string;
  /** Everything opened over the trip, signed like the opening fills. */
  readonly size: Decimal;
  /** Per share, the opening fills' prices averaged by size, before commission. */
  readonly entryPrice: Decimal;
  readonly entryTime: number;
  /** Per share, the closing fills' prices averaged by size, before commission. */
  readonly exitPrice: Decimal;
  /** When the fill that left the position flat booked. */
  readonly exitTime: number;
  /** The fill that left the position flat's. */
  readonly reason: string;
  readonly capital: Decimal;
  readonly notes: Readonly<Record<string, string>>;
  /** Every fill's commission over the trip. */
  readonly commission: Decimal;
  /** What the account realized over the trip, which is already net of every commission. */
  readonly netPL: Decimal;
  /** `netPL` with the commissions added back. */
  readonly grossPL: Decimal;
}

export interface TradeReportSummary {
  readonly roundTrips: number;
  /** Net of commission, so a trade that made less than it paid to place is a loss. */
  readonly wins: number;
  readonly losses: number;
  readonly grossPL: Decimal;
  readonly commissions: Decimal;
  readonly netPL: Decimal;
  /** Absent rather than zero when there was no win to average. */
  readonly averageWin?: Decimal;
  readonly averageLoss?: Decimal;
  readonly averageCapital?: Decimal;
  /** Net P&L over the average capital a trade tied up, in percent. */
  readonly returnOnAverageCapital?: Decimal;
  readonly byReason: ReadonlyMap<string, number>;
}

/** A position still open, as its fills so far add up. */
interface Accumulating {
  readonly symbol: string;
  readonly entryTime: number;
  readonly notes: Readonly<Record<string, string>>;
  readonly held: Decimal;
  readonly opened: Decimal;
  /** Size times price over the opening fills, so dividing by `opened` is their average price. */
  readonly openedNotional: Decimal;
  readonly closed: Decimal;
  readonly closedNotional: Decimal;
  readonly capital: Decimal;
  readonly commission: Decimal;
  readonly realized: Decimal;
}

function average(values: ReadonlyArray<Decimal>): Decimal | undefined {
  return values.length === 0 ? undefined : sumDecimals(values).div(Decimal.of(values.length), LEDGER_SCALE);
}

function minute(timestamp: number): string {
  return `${easternClock.date(timestamp)} ${easternClock.time(timestamp).slice(0, 5)}`;
}

function signed(value: Decimal, scale: number): string {
  return `${value.isNegative() ? '' : '+'}${value.toFixed(scale)}`;
}

/**
 * The round trips an account's transactions make, and what they add up to. It is the account's
 * recorder, so it hears of every fill as the account books it:
 *
 *     const report = new TradeReport();
 *     const account = new BacktestAccountImpl(report, 10_000);
 *     account.record({ symbol: 'AAPL250417P00210000', size: -1, price: '2.95', timestamp: t0 }, { kind: 'open', commission: '0.65', capital: 21_000 });
 *     account.record({ symbol: 'AAPL250417P00210000', size: 1, price: '1.40', timestamp: t1 }, { kind: 'close', commission: '0.65', reason: 'take-profit' });
 *     report.summary().netPL.toString(); // '153.7' — 295 in, 140 out, 1.30 to the broker
 *
 * A round trip runs from flat to flat, however many fills add to it or take it down on the
 * way. Its P&L is what the account realized rather than anything priced here, so the two
 * cannot disagree; what the report adds is the reason a trip ended and what the strategy
 * noted when it began.
 */
export class TradeReport implements TransactionRecorder {
  private readonly open = new Map<string, Accumulating>();
  private readonly closedTrips: RoundTrip[] = [];

  record(transaction: Transaction): void {
    const { symbol, size, price, commission, context } = transaction;
    const trip = this.open.get(symbol);

    if (context.kind === 'open') {
      const base: Accumulating = trip ?? {
        symbol,
        entryTime: transaction.time,
        notes: context.notes ?? {},
        held: Decimal.ZERO,
        opened: Decimal.ZERO,
        openedNotional: Decimal.ZERO,
        closed: Decimal.ZERO,
        closedNotional: Decimal.ZERO,
        capital: Decimal.ZERO,
        commission: Decimal.ZERO,
        realized: Decimal.ZERO,
      };
      this.open.set(symbol, {
        ...base,
        held: base.held.add(size),
        opened: base.opened.add(size),
        openedNotional: base.openedNotional.add(size.mul(price)),
        capital: base.capital.add(Decimal.of(context.capital)),
        commission: base.commission.add(commission),
      });
      return;
    }

    if (trip === undefined) {
      throw new Error(`${symbol} was closed but never opened in this report. Give the report every transaction the account books, from its first.`);
    }
    if (transaction.realizedPL === undefined) {
      throw new Error(`A close of ${symbol} at ${minute(transaction.time)} realized nothing, which the account never books. The report cannot add up its P&L.`);
    }
    const next: Accumulating = {
      ...trip,
      held: trip.held.add(size),
      closed: trip.closed.add(size),
      closedNotional: trip.closedNotional.add(size.mul(price)),
      commission: trip.commission.add(commission),
      realized: trip.realized.add(transaction.realizedPL),
    };
    if (!next.held.isZero()) {
      this.open.set(symbol, next);
      return;
    }

    this.open.delete(symbol);
    this.closedTrips.push({
      symbol,
      size: next.opened,
      entryPrice: next.openedNotional.div(next.opened, LEDGER_SCALE),
      entryTime: next.entryTime,
      exitPrice: next.closedNotional.div(next.closed, LEDGER_SCALE),
      exitTime: transaction.time,
      reason: context.reason,
      capital: next.capital,
      notes: next.notes,
      commission: next.commission,
      netPL: next.realized,
      grossPL: next.realized.add(next.commission),
    });
  }

  roundTrips(): ReadonlyArray<RoundTrip> {
    return [...this.closedTrips];
  }

  openTrades(): ReadonlyArray<OpenTrade> {
    return [...this.open.values()].map((trip) => ({
      symbol: trip.symbol,
      size: trip.held,
      entryPrice: trip.openedNotional.div(trip.opened, LEDGER_SCALE),
      entryTime: trip.entryTime,
      capital: trip.capital,
      notes: trip.notes,
    }));
  }

  summary(): TradeReportSummary {
    const trips = this.closedTrips;
    const winning = trips.filter((trip) => trip.netPL.isPositive());
    const losing = trips.filter((trip) => trip.netPL.isNegative());
    const netPL = sumDecimals(trips.map((trip) => trip.netPL));
    const averageCapital = average(trips.map((trip) => trip.capital));

    const byReason = new Map<string, number>();
    for (const trip of trips) {
      byReason.set(trip.reason, (byReason.get(trip.reason) ?? 0) + 1);
    }

    return {
      roundTrips: trips.length,
      wins: winning.length,
      losses: losing.length,
      grossPL: sumDecimals(trips.map((trip) => trip.grossPL)),
      commissions: sumDecimals(trips.map((trip) => trip.commission)),
      netPL,
      averageWin: average(winning.map((trip) => trip.netPL)),
      averageLoss: average(losing.map((trip) => trip.netPL)),
      averageCapital,
      returnOnAverageCapital: averageCapital === undefined || averageCapital.isZero() ? undefined : netPL.mul(PERCENT).div(averageCapital, 4),
      byReason,
    };
  }

  /** One line per round trip, then whatever is still open, then the totals. */
  render(): ReadonlyArray<string> {
    const lines: string[] = [];

    lines.push(`Round trips (${this.closedTrips.length}):`);
    for (const trip of this.closedTrips) {
      const days = ((trip.exitTime - trip.entryTime) / MS_PER_DAY).toFixed(1);
      const roc = trip.capital.isZero() ? 'n/a' : `${signed(trip.netPL.mul(PERCENT).div(trip.capital, 4), 2)}%`;
      const columns = [
        `${minute(trip.entryTime)} -> ${minute(trip.exitTime)}`,
        trip.symbol,
        `${trip.size.toString()} @ ${trip.entryPrice.toFixed(2)} -> ${trip.exitPrice.toFixed(2)}`,
        `net ${signed(trip.netPL, 2).padStart(9)}`,
        `roc ${roc.padStart(7)}`,
        `${days.padStart(5)}d`,
        trip.reason.padEnd(11),
        ...Object.entries(trip.notes).map(([key, value]) => `${key} ${value}`),
      ];
      lines.push(`  ${columns.join('  ')}`);
    }

    const open = this.openTrades();
    if (open.length > 0) {
      lines.push(`Still open at the end of the run (${open.length}), left out of the totals:`);
      for (const trade of open) {
        const notes = Object.entries(trade.notes).map(([key, value]) => `${key} ${value}`);
        lines.push(`  ${[minute(trade.entryTime), trade.symbol, `${trade.size.toString()} @ ${trade.entryPrice.toFixed(2)}`, ...notes].join('  ')}`);
      }
    }

    const summary = this.summary();
    const winRate = summary.roundTrips === 0 ? 'n/a' : `${((summary.wins / summary.roundTrips) * 100).toFixed(1)}%`;
    lines.push('Summary:');
    lines.push(`  round trips ${summary.roundTrips}, wins ${summary.wins}, losses ${summary.losses}, win rate ${winRate}`);
    lines.push(
      `  average win ${summary.averageWin === undefined ? 'n/a' : signed(summary.averageWin, 2)}, average loss ${summary.averageLoss === undefined ? 'n/a' : signed(summary.averageLoss, 2)}`,
    );
    lines.push(`  gross ${signed(summary.grossPL, 2)}, commissions ${summary.commissions.toFixed(2)}, net ${signed(summary.netPL, 2)}`);
    if (summary.averageCapital !== undefined && summary.returnOnAverageCapital !== undefined) {
      lines.push(`  average capital ${summary.averageCapital.toFixed(2)}, net return on it ${signed(summary.returnOnAverageCapital, 2)}%`);
    }
    lines.push(`  exits: ${[...summary.byReason].map(([reason, count]) => `${reason} ${count}`).join(', ') || 'none'}`);
    return lines;
  }
}
