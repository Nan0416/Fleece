/**
 * The strategies the position monitor recognises, and the rules that say when to close one.
 */
import { Decimal } from '@fleece/utilities';

import { fetchOptionMarks, type OptionMarks, type OptionQuote, type OptionSnapshotReader } from './option-marks';
import { Positions, type OptionLeg } from './positions';

/** Shares a contract prices. The detectors pair only unadjusted contracts, which is what makes it 100. */
const CONTRACT_MULTIPLIER = Decimal.of(100);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type SignalKind = 'take-profit' | 'stop-loss' | 'days-to-expiration';

export interface Signal {
  readonly kind: SignalKind;
  /** The strategy it is about, as `Strategy.describe` names it. */
  readonly strategy: string;
  readonly message: string;
}

export interface StrategyEvaluation {
  readonly strategy: Strategy;
  /** Where the strategy stands, on one line. */
  readonly summary: string;
  readonly signals: ReadonlyArray<Signal>;
  /** A rule that could not be checked, and why. */
  readonly warnings: ReadonlyArray<string>;
}

export interface Strategy {
  readonly positions: Positions;
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
  /** Contracts in each leg. */
  readonly quantity: Decimal;

  protected constructor(
    private readonly name: string,
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

  describe(): string {
    const { underlying, expiration } = this.shortLeg.contract;
    return `${underlying} ${expiration} ${this.shortLeg.contract.strike}/${this.longLeg.contract.strike} ${this.name} x${this.quantity.toString()}`;
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
      daysToExpiration: daysBetween(today, this.shortLeg.contract.expiration),
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
    const { credit, unrealizedProfit: profit, closeAtMid, closeAtNatural, daysToExpiration } = metrics;
    const strategy = this.describe();
    const signals: Signal[] = [];
    const warnings: string[] = [];
    const closing = closeAtMid !== undefined && closeAtNatural !== undefined ? ` Closing costs ${dollars(closeAtMid)} at mid, ${dollars(closeAtNatural)} at the natural.` : '';

    if (!credit.isPositive()) {
      // Measuring a take-profit against a debit would fire on the first loss, or never.
      warnings.push(
        `The averaged entry prices make this a debit of ${dollars(credit.neg())}, so the profit and loss rules were not checked. A leg was probably also traded outside this spread.`,
      );
    } else if (profit === undefined) {
      const unquoted = [this.shortLeg, this.longLeg].filter((leg) => marks.get(leg.contract.symbol)?.quote === undefined).map((leg) => leg.contract.symbol);
      warnings.push(`No quote for ${unquoted.join(' or ')}, so the profit and loss rules were not checked.`);
    } else {
      const target = credit.mul(this.rules.takeProfitFraction);
      if (profit.gte(target)) {
        signals.push({
          kind: 'take-profit',
          strategy,
          message: `Up ${dollars(profit)}, ${percentOf(profit, credit)} of the ${dollars(credit)} credit (target ${this.rules.takeProfitFraction.mul(Decimal.of(100)).toString()}%).${closing}`,
        });
      }
      const loss = profit.neg();
      if (loss.gte(credit.mul(this.rules.stopLossMultiple))) {
        signals.push({
          kind: 'stop-loss',
          strategy,
          message: `Down ${dollars(loss)}, ${loss.div(credit, 2).toFixed(2)}x the ${dollars(credit)} credit (limit ${this.rules.stopLossMultiple.toString()}x).${closing}`,
        });
      }
    }

    if (daysToExpiration <= this.rules.closeAtDaysToExpiration) {
      const standing = profit === undefined ? '' : ` P&L ${signedDollars(profit)} on a ${dollars(credit)} credit.`;
      signals.push({
        kind: 'days-to-expiration',
        strategy,
        message: `${daysToExpiration} days to expiration, at or inside the ${this.rules.closeAtDaysToExpiration} to close at.${standing}${closing}`,
      });
    }

    return { strategy: this, summary: summarize(strategy, metrics), signals, warnings };
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

function summarize(strategy: string, metrics: CreditSpreadMetrics): string {
  const { credit, unrealizedProfit, closeAtMid, closeAtNatural, maxLoss, netDelta, shortDelta, daysToExpiration } = metrics;
  const parts = [`credit ${dollars(credit)}`];
  if (unrealizedProfit !== undefined) {
    parts.push(credit.isPositive() ? `P&L ${signedDollars(unrealizedProfit)} (${percentOf(unrealizedProfit, credit)} of credit)` : `P&L ${signedDollars(unrealizedProfit)}`);
  }
  if (closeAtMid !== undefined && closeAtNatural !== undefined) {
    parts.push(`close ${dollars(closeAtMid)} mid / ${dollars(closeAtNatural)} natural`);
  }
  parts.push(`max loss ${dollars(maxLoss)}`);
  if (netDelta !== undefined) {
    parts.push(`net delta ${netDelta.toFixed(1)}`);
  }
  if (shortDelta !== undefined) {
    parts.push(`short delta ${shortDelta.toFixed(2)}`);
  }
  parts.push(`${daysToExpiration} DTE`);
  return `${strategy}: ${parts.join(', ')}`;
}

function mid(quote: OptionQuote): Decimal {
  return quote.bid.add(quote.ask).div(Decimal.of(2), 4);
}

/** Whole calendar days. Both are ISO dates, which `Date.parse` reads as UTC midnight. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / MS_PER_DAY);
}

/** Rounded before the sign is read, so a loss of a tenth of a cent prints as `$0.00` rather than `-$0.00`. */
function dollars(value: Decimal): string {
  const cents = value.round(2);
  return cents.signum() < 0 ? `-$${cents.neg().toFixed(2)}` : `$${cents.toFixed(2)}`;
}

function signedDollars(value: Decimal): string {
  return value.round(2).signum() > 0 ? `+${dollars(value)}` : dollars(value);
}

function percentOf(part: Decimal, whole: Decimal): string {
  return `${part.mul(Decimal.of(100)).div(whole, 1).toFixed(1)}%`;
}
