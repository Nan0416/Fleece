import { Decimal, easternClock, LEDGER_SCALE, sumDecimals, type DecimalInput } from '@fleece/utilities';

import { contractMultiplier, type Trade } from './account';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const PERCENT = Decimal.of(100);

export interface OpeningFill {
  readonly trade: Trade;
  /** Dollars paid for the fill, on top of what its price moved. */
  readonly commission: DecimalInput;
  /** Dollars the position ties up, which its return is measured against: strike × 100 for a cash-secured put. */
  readonly capital: DecimalInput;
  /** Whatever the strategy wants printed on the trade's line, in the order given. */
  readonly notes?: Readonly<Record<string, string>>;
}

export interface ClosingFill {
  readonly trade: Trade;
  readonly commission: DecimalInput;
  /** Why the strategy closed, as it should read in the report. */
  readonly reason: string;
}

export interface OpenTrade {
  readonly symbol: string;
  readonly size: Decimal;
  readonly entryPrice: Decimal;
  readonly entryTime: number;
  readonly entryCommission: Decimal;
  readonly capital: Decimal;
  readonly notes: Readonly<Record<string, string>>;
}

export interface RoundTrip extends OpenTrade {
  readonly exitPrice: Decimal;
  readonly exitTime: number;
  readonly exitCommission: Decimal;
  readonly reason: string;
  /** What the two fills moved before commission, which is what the account books as realized. */
  readonly grossPL: Decimal;
  readonly netPL: Decimal;
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
 * The round trips a strategy made, told to it fill by fill, and what they add up to.
 *
 *     const report = new TradeReport();
 *     report.opened({ trade: { symbol: 'AAPL250417P00210000', size: -1, price: '2.95', timestamp: t0 }, commission: '0.65', capital: 21_000 });
 *     report.closed({ trade: { symbol: 'AAPL250417P00210000', size: 1, price: '1.40', timestamp: t1 }, commission: '0.65', reason: 'take-profit' });
 *     report.summary().netPL.toString(); // '153.7' — 295 in, 140 out, 1.30 to the broker
 *
 * Kept apart from the account on purpose. The account knows fills and nothing about why
 * they happened; a report wants the reason a trade closed and what the strategy saw when
 * it opened, and those belong to the strategy.
 *
 * One round trip per symbol at a time, opened by one fill and closed in full by one fill.
 * Anything else throws rather than being paired up some plausible way, because a report
 * that guesses which entry an exit belongs to prints a P&L no account ever booked.
 */
export class TradeReport {
  private readonly open = new Map<string, OpenTrade>();
  private readonly closedTrips: RoundTrip[] = [];

  opened(fill: OpeningFill): void {
    const { trade } = fill;
    const size = Decimal.of(trade.size);
    if (size.isZero()) {
      throw new Error(`An opening fill for ${trade.symbol} has no size. Report a trade that moved something.`);
    }
    if (this.open.has(trade.symbol)) {
      throw new Error(`${trade.symbol} is already open in this report. Close it before opening it again; adding to a position is not something it pairs.`);
    }
    this.open.set(trade.symbol, {
      symbol: trade.symbol,
      size,
      entryPrice: Decimal.of(trade.price),
      entryTime: trade.timestamp,
      entryCommission: Decimal.of(fill.commission),
      capital: Decimal.of(fill.capital),
      notes: fill.notes ?? {},
    });
  }

  closed(fill: ClosingFill): RoundTrip {
    const { trade } = fill;
    const entry = this.open.get(trade.symbol);
    if (entry === undefined) {
      throw new Error(`${trade.symbol} was closed but never opened in this report. Report the opening fill first.`);
    }
    const size = Decimal.of(trade.size);
    if (!size.add(entry.size).isZero()) {
      throw new Error(`${trade.symbol} is open ${entry.size.toString()} and was closed ${size.toString()}. This report only pairs a close that flattens the whole position.`);
    }

    const multiplier = contractMultiplier(trade.symbol);
    const exitPrice = Decimal.of(trade.price);
    const exitCommission = Decimal.of(fill.commission);
    // The dollars each fill moved, negated so money in is positive: the same expression the
    // account uses, so the two agree to the cent rather than approximately.
    const grossPL = entry.size.mul(entry.entryPrice).mul(multiplier).add(size.mul(exitPrice).mul(multiplier)).neg();
    const roundTrip: RoundTrip = {
      ...entry,
      exitPrice,
      exitTime: trade.timestamp,
      exitCommission,
      reason: fill.reason,
      grossPL,
      netPL: grossPL.sub(entry.entryCommission).sub(exitCommission),
    };

    this.open.delete(trade.symbol);
    this.closedTrips.push(roundTrip);
    return roundTrip;
  }

  roundTrips(): ReadonlyArray<RoundTrip> {
    return [...this.closedTrips];
  }

  openTrades(): ReadonlyArray<OpenTrade> {
    return [...this.open.values()];
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
      commissions: sumDecimals(trips.map((trip) => trip.entryCommission.add(trip.exitCommission))),
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

    if (this.open.size > 0) {
      lines.push(`Still open at the end of the run (${this.open.size}), left out of the totals:`);
      for (const trade of this.open.values()) {
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
