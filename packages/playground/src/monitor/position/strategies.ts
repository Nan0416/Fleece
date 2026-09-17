/**
 * The strategies the position monitor recognises, and the rules that say when to close one.
 */
import type { OptionType } from '@fleece/marketdata';
import { Decimal } from '@fleece/utilities';

import { dollars, percentOf } from './formatting';
import { fetchOptionMarks, type OptionMarks, type OptionQuote, type OptionSnapshotReader } from './option-marks';
import { Positions, type OptionLeg } from './positions';

/** Shares a contract prices. The detectors pair only unadjusted contracts, which is what makes it 100. */
const CONTRACT_MULTIPLIER = Decimal.of(100);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type SignalKind = 'take-profit' | 'stop-loss' | 'days-to-expiration';

export interface Signal {
  readonly kind: SignalKind;
  /** Why the rule fired, against its threshold: `55.6% of the credit made (target 50%)`. */
  readonly reason: string;
}

export interface StrategyEvaluation {
  readonly strategy: Strategy;
  /** Every strategy so far is a credit spread, so every evaluation measures one. */
  readonly metrics: CreditSpreadMetrics;
  readonly signals: ReadonlyArray<Signal>;
  /** A rule that could not be checked, and why. */
  readonly warnings: ReadonlyArray<string>;
}

export interface Strategy {
  /** `bear call spread`. */
  readonly name: string;
  readonly underlying: string;
  /** ISO `YYYY-MM-DD`. */
  readonly expiration: string;
  readonly optionType: OptionType;
  /** In dollars, the short leg's first. */
  readonly strikes: ReadonlyArray<number>;
  /** Contracts in each leg. */
  readonly quantity: Decimal;
  readonly positions: Positions;
  /** `AAPL 2026-10-23 360/375 bear call spread x1`. */
  describe(): string;
  /** Reads the market data it needs itself. `today` is the Eastern calendar date, `YYYY-MM-DD`. */
  evaluate(today: string): Promise<StrategyEvaluation>;
}

export interface CreditSpreadRules {
  /** Take profit once this fraction of the credit is made: `0.5` is half. */
  readonly takeProfitFraction: Decimal;
  /** Stop out once the loss reaches this multiple of the credit. */
  readonly stopLossMultiple: Decimal;
  /** Close with this many calendar days to expiration or fewer. */
  readonly closeAtDaysToExpiration: number;
}

/** Dollars for the whole quantity, not per share. */
export interface CreditSpreadMetrics {
  /** Not positive when the averaged entry prices make the spread a debit. */
  readonly credit: Decimal;
  /** What the spread loses if it expires with both legs in the money. */
  readonly maxLoss: Decimal;
  readonly daysToExpiration: number;
  /** Absent unless both legs are quoted. */
  readonly closeAtMid?: Decimal;
  /** Buying the short back at its ask and selling the long at its bid. */
  readonly closeAtNatural?: Decimal;
  /** Against the close at mid. */
  readonly unrealizedProfit?: Decimal;
  /** Share-equivalent: -25 moves like 25 shares short. Absent unless both legs have a delta. */
  readonly netDelta?: number;
  readonly shortDelta?: number;
}

/**
 * Short one contract and long a further out-of-the-money one in the same series, opened for
 * a credit. The rules are measured against that credit, which comes from Alpaca's averaged
 * entry prices rather than from the order that opened the spread.
 */
abstract class CreditSpread implements Strategy {
  readonly positions: Positions;
  readonly quantity: Decimal;

  protected constructor(
    readonly name: string,
    readonly shortLeg: OptionLeg,
    readonly longLeg: OptionLeg,
    private readonly marketData: OptionSnapshotReader,
    private readonly rules: CreditSpreadRules,
  ) {
    const short = shortLeg.contract;
    const long = longLeg.contract;
    if (short.root !== long.root || short.expiration !== long.expiration || short.type !== long.type) {
      throw new Error(`A ${name} takes two legs in the same series, got ${short.symbol} and ${long.symbol}.`);
    }
    if (!longLeg.quantity.isPositive() || !shortLeg.quantity.neg().eq(longLeg.quantity)) {
      throw new Error(
        `A ${name} is short and long the same number of contracts, got ${shortLeg.quantity.toString()} of ${short.symbol} and ${longLeg.quantity.toString()} of ${long.symbol}.`,
      );
    }
    this.positions = new Positions([shortLeg, longLeg]);
    this.quantity = longLeg.quantity;
  }

  get underlying(): string {
    return this.shortLeg.contract.underlying;
  }

  get expiration(): string {
    return this.shortLeg.contract.expiration;
  }

  get optionType(): OptionType {
    return this.shortLeg.contract.type;
  }

  get strikes(): ReadonlyArray<number> {
    return [this.shortLeg.contract.strike, this.longLeg.contract.strike];
  }

  describe(): string {
    return `${this.underlying} ${this.expiration} ${this.strikes.join('/')} ${this.name} x${this.quantity.toString()}`;
  }

  metrics(marks: OptionMarks, today: string): CreditSpreadMetrics {
    const shares = this.quantity.mul(CONTRACT_MULTIPLIER);
    const creditPerShare = this.shortLeg.averageEntryPrice.sub(this.longLeg.averageEntryPrice);
    const width = Decimal.of(Math.abs(this.shortLeg.contract.strikeMils - this.longLeg.contract.strikeMils)).div(Decimal.of(1000), 3);
    const credit = creditPerShare.mul(shares);
    const short = marks.get(this.shortLeg.contract.symbol);
    const long = marks.get(this.longLeg.contract.symbol);

    const closeAtMid = short?.quote !== undefined && long?.quote !== undefined ? mid(short.quote).sub(mid(long.quote)).mul(shares) : undefined;
    const closeAtNatural = short?.quote !== undefined && long?.quote !== undefined ? short.quote.ask.sub(long.quote.bid).mul(shares) : undefined;
    const netDelta = short?.delta !== undefined && long?.delta !== undefined ? (long.delta - short.delta) * shares.toNumber() : undefined;

    return {
      credit,
      maxLoss: width.sub(creditPerShare).mul(shares),
      daysToExpiration: daysBetween(today, this.expiration),
      closeAtMid,
      closeAtNatural,
      unrealizedProfit: closeAtMid === undefined ? undefined : credit.sub(closeAtMid),
      netDelta,
      shortDelta: short?.delta,
    };
  }

  async evaluate(today: string): Promise<StrategyEvaluation> {
    const marks = await fetchOptionMarks(this.marketData, [this.shortLeg.contract, this.longLeg.contract]);
    return this.assess(marks, today);
  }

  /** `evaluate` without the request, so the rules can be checked against marks given to it. */
  assess(marks: OptionMarks, today: string): StrategyEvaluation {
    const metrics = this.metrics(marks, today);
    const { credit, unrealizedProfit: profit, daysToExpiration } = metrics;
    const signals: Signal[] = [];
    const warnings: string[] = [];

    if (!credit.isPositive()) {
      // Measuring a take-profit against a debit would fire on the first loss, or never.
      warnings.push(
        `The averaged entry prices make this a debit of ${dollars(credit.neg())}, so the profit and loss rules were not checked. A leg was probably also traded outside this spread.`,
      );
    } else if (profit === undefined) {
      const unquoted = [this.shortLeg, this.longLeg].filter((leg) => marks.get(leg.contract.symbol)?.quote === undefined).map((leg) => leg.contract.symbol);
      warnings.push(`No quote for ${unquoted.join(' or ')}, so the profit and loss rules were not checked.`);
    } else {
      if (profit.gte(credit.mul(this.rules.takeProfitFraction))) {
        signals.push({
          kind: 'take-profit',
          reason: `${percentOf(profit, credit)} of the credit made (target ${percentOf(this.rules.takeProfitFraction, Decimal.ONE, 0)})`,
        });
      }
      const loss = profit.neg();
      if (loss.gte(credit.mul(this.rules.stopLossMultiple))) {
        signals.push({
          kind: 'stop-loss',
          reason: `Loss is ${loss.div(credit, 2).toFixed(2)}x the credit (limit ${this.rules.stopLossMultiple.toString()}x)`,
        });
      }
    }

    if (daysToExpiration <= this.rules.closeAtDaysToExpiration) {
      signals.push({
        kind: 'days-to-expiration',
        reason: `${daysToExpiration} days to expiration (close at ${this.rules.closeAtDaysToExpiration})`,
      });
    }

    return { strategy: this, metrics, signals, warnings };
  }
}

/** Short a call and long a higher-strike one: paid for the underlying staying below the short strike. */
export class BearCallSpread extends CreditSpread {
  constructor(shortLeg: OptionLeg, longLeg: OptionLeg, marketData: OptionSnapshotReader, rules: CreditSpreadRules) {
    super('bear call spread', shortLeg, longLeg, marketData, rules);
    if (shortLeg.contract.type !== 'call' || longLeg.contract.strikeMils <= shortLeg.contract.strikeMils) {
      throw new Error(`A bear call spread is long a call above the one it is short, got ${shortLeg.contract.symbol} short and ${longLeg.contract.symbol} long.`);
    }
  }
}

/** Short a put and long a lower-strike one: paid for the underlying staying above the short strike. */
export class BullPutSpread extends CreditSpread {
  constructor(shortLeg: OptionLeg, longLeg: OptionLeg, marketData: OptionSnapshotReader, rules: CreditSpreadRules) {
    super('bull put spread', shortLeg, longLeg, marketData, rules);
    if (shortLeg.contract.type !== 'put' || longLeg.contract.strikeMils >= shortLeg.contract.strikeMils) {
      throw new Error(`A bull put spread is long a put below the one it is short, got ${shortLeg.contract.symbol} short and ${longLeg.contract.symbol} long.`);
    }
  }
}

function mid(quote: OptionQuote): Decimal {
  return quote.bid.add(quote.ask).div(Decimal.of(2), 4);
}

/** Whole calendar days. Both are ISO dates, which `Date.parse` reads as UTC midnight. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / MS_PER_DAY);
}
