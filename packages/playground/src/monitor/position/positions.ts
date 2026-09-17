/**
 * An account's option positions, as a pool that detected strategies are taken out of.
 */
import type { AlpacaPosition } from '@fleece/broker';
import { parseOccSymbol, type OccSymbol } from '@fleece/marketdata';
import { Decimal, InternalServiceError } from '@fleece/utilities';

export interface OptionLeg {
  readonly contract: OccSymbol;
  /** Contracts, signed: negative for a short. */
  readonly quantity: Decimal;
  /**
   * Premium per share, as Alpaca averages it over every fill in the contract. A contract
   * also traded outside the spread it now sits in moves this, and nothing here can tell.
   */
  readonly averageEntryPrice: Decimal;
}

export class Positions {
  private readonly legsBySymbol = new Map<string, OptionLeg>();

  constructor(legs: ReadonlyArray<OptionLeg>) {
    for (const leg of legs) {
      if (this.legsBySymbol.has(leg.contract.symbol)) {
        throw new Error(`${leg.contract.symbol} is in the positions twice. Merge the two legs before building a pool from them.`);
      }
      if (!leg.quantity.isZero()) {
        this.legsBySymbol.set(leg.contract.symbol, leg);
      }
    }
  }

  /** Options only: stock is not part of any strategy detected here. */
  static fromAlpacaPositions(positions: ReadonlyArray<AlpacaPosition>): Positions {
    const legs: OptionLeg[] = [];
    for (const position of positions) {
      if (position.asset_class !== 'us_option') {
        continue;
      }
      const contract = parseOccSymbol(position.symbol);
      if (contract === undefined) {
        throw new InternalServiceError(`Alpaca reported an option position in ${position.symbol}, which is not an OCC contract symbol.`);
      }
      legs.push({
        contract,
        quantity: Decimal.parse(position.qty, `${position.symbol}'s quantity`),
        averageEntryPrice: Decimal.parse(position.avg_entry_price, `${position.symbol}'s average entry price`),
      });
    }
    return new Positions(legs);
  }

  /**
   * Ordered by underlying, expiration, type and strike. Detection is greedy, so without a
   * fixed order the same account could pair its legs differently from one run to the next.
   */
  get legs(): ReadonlyArray<OptionLeg> {
    return [...this.legsBySymbol.values()].sort((a, b) => compareContracts(a.contract, b.contract));
  }

  get isEmpty(): boolean {
    return this.legsBySymbol.size === 0;
  }

  /** Takes each of `positions`' legs out of this pool, by quantity: a short 3 less a short 2 leaves a short 1. */
  removePositions(positions: Positions): void {
    for (const leg of positions.legs) {
      const symbol = leg.contract.symbol;
      const held = this.legsBySymbol.get(symbol);
      if (held === undefined || held.quantity.signum() !== leg.quantity.signum() || leg.quantity.abs().gt(held.quantity.abs())) {
        throw new Error(`Cannot take ${leg.quantity.toString()} of ${symbol} out of a pool holding ${held?.quantity.toString() ?? 'none'}.`);
      }
      const remaining = held.quantity.sub(leg.quantity);
      if (remaining.isZero()) {
        this.legsBySymbol.delete(symbol);
      } else {
        this.legsBySymbol.set(symbol, { ...held, quantity: remaining });
      }
    }
  }
}

function compareContracts(a: OccSymbol, b: OccSymbol): number {
  return (
    compareStrings(a.underlying, b.underlying) ||
    compareStrings(a.expiration, b.expiration) ||
    compareStrings(a.type, b.type) ||
    a.strikeMils - b.strikeMils ||
    compareStrings(a.symbol, b.symbol)
  );
}

function compareStrings(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}
