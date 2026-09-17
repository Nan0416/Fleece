/**
 * Finds strategies among an account's option legs.
 *
 * Alpaca reports one position per contract, not per order, so which legs were opened
 * together is inferred here rather than known.
 */
import type { OptionType } from '@fleece/marketdata';

import type { OptionSnapshotReader } from './option-marks';
import type { OptionLeg, Positions } from './positions';
import { BearCallSpread, BullPutSpread, type CreditSpreadRules, type Strategy } from './strategies';

export interface StrategyDetector {
  /** One instance of the strategy among `positions`, or `undefined` when there is none. Leaves `positions` as it was. */
  detect(positions: Positions): Strategy | undefined;
}

/** `marketData` is handed to each spread found, which reads its own quotes with it. */
export class BearCallSpreadDetector implements StrategyDetector {
  constructor(
    private readonly marketData: OptionSnapshotReader,
    private readonly rules: CreditSpreadRules,
  ) {}

  detect(positions: Positions): Strategy | undefined {
    const legs = findCreditSpread(positions, 'call');
    return legs === undefined ? undefined : new BearCallSpread(legs.shortLeg, legs.longLeg, this.marketData, this.rules);
  }
}

export class BullPutSpreadDetector implements StrategyDetector {
  constructor(
    private readonly marketData: OptionSnapshotReader,
    private readonly rules: CreditSpreadRules,
  ) {}

  detect(positions: Positions): Strategy | undefined {
    const legs = findCreditSpread(positions, 'put');
    return legs === undefined ? undefined : new BullPutSpread(legs.shortLeg, legs.longLeg, this.marketData, this.rules);
  }
}

/**
 * Runs each detector until it finds nothing more, taking what it finds out of `positions`,
 * so no leg is counted in two strategies. What is left in `positions` afterwards is what no
 * detector claimed.
 *
 * Order matters. A detector for a strategy made of others' legs — an iron condor is one of
 * each of these spreads — has to run before theirs, or they take it apart first.
 */
export class ChainedStrategyDetector {
  constructor(readonly detectors: ReadonlyArray<StrategyDetector>) {}

  detect(positions: Positions): Strategy[] {
    const strategies: Strategy[] = [];
    for (const detector of this.detectors) {
      while (true) {
        const strategy = detector.detect(positions);
        if (strategy === undefined) {
          break;
        }
        // One that takes nothing out would be found again on every pass, forever.
        if (strategy.positions.isEmpty) {
          throw new Error(`A detector found ${strategy.describe()} holding no contracts.`);
        }
        positions.removePositions(strategy.positions);
        strategies.push(strategy);
      }
    }
    return strategies;
  }
}

interface CreditSpreadLegs {
  readonly shortLeg: OptionLeg;
  readonly longLeg: OptionLeg;
}

/**
 * The first short, in `Positions.legs` order, that has a long in its series on the
 * protective side — above it for a call, below it for a put — paired with the nearest such
 * long, which makes the narrowest spread. Where several shorts could share the longs the
 * pairing is a guess, since the positions do not say which orders went together.
 *
 * The spread takes the smaller of the two quantities and leaves the rest of the larger leg
 * for the next pass. Adjusted contracts are left alone: one does not deliver 100 shares, so
 * a spread's width is not what it can lose.
 */
function findCreditSpread(positions: Positions, type: OptionType): CreditSpreadLegs | undefined {
  const legs = positions.legs.filter((leg) => leg.contract.type === type && leg.contract.root === leg.contract.underlying);
  for (const shortLeg of legs) {
    if (!shortLeg.quantity.isNegative()) {
      continue;
    }
    const short = shortLeg.contract;
    let nearest: OptionLeg | undefined;
    for (const leg of legs) {
      const long = leg.contract;
      const protective = type === 'call' ? long.strikeMils > short.strikeMils : long.strikeMils < short.strikeMils;
      if (!leg.quantity.isPositive() || long.root !== short.root || long.expiration !== short.expiration || !protective) {
        continue;
      }
      if (nearest === undefined || Math.abs(long.strikeMils - short.strikeMils) < Math.abs(nearest.contract.strikeMils - short.strikeMils)) {
        nearest = leg;
      }
    }
    if (nearest !== undefined) {
      const shortSize = shortLeg.quantity.neg();
      const quantity = shortSize.lt(nearest.quantity) ? shortSize : nearest.quantity;
      return { shortLeg: { ...shortLeg, quantity: quantity.neg() }, longLeg: { ...nearest, quantity } };
    }
  }
  return undefined;
}
