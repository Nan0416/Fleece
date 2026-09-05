import { Decimal, LEDGER_SCALE } from './decimal';

/**
 * Quantities the ledger reports but does not store.
 *
 * The ledger accounts in **total cost**: a position is a size and the dollars paid for
 * it, and a transaction is a size and the dollars it moved. Nothing stores a unit
 * price, because storing one means dividing on the write path and then doing
 * arithmetic on the rounded result — which is how a cost basis drifts.
 *
 * Everything here is therefore a read-time projection. Division happens on the way out,
 * where a rounded answer is shown and never fed back in.
 */

/**
 * Cost basis per unit: what a caller means by "average price".
 *
 * Zero for a flat position, which is a statement about a position that holds nothing
 * rather than a price of nothing. Always positive for a real holding — a short of 10 at
 * 50 is a size of -10 against a total cost of -500, and the two signs cancel.
 *
 * For an option this is the cost per **contract**, because that is what the size counts.
 * `derivePremium` is the per-share figure the broker quotes.
 */
export function deriveUnitCost(totalCost: Decimal, size: Decimal): Decimal {
  if (size.isZero()) {
    return Decimal.ZERO;
  }
  return totalCost.div(size, LEDGER_SCALE);
}

/**
 * The premium a broker would quote, recovered from what was stored.
 *
 * An option contract is a claim on `multiplier` shares and its premium is quoted per
 * share, so a contract filled at 3.85 moved $385. The ledger stores the $385 — that is
 * what makes a virtual account holding both stock and options total its realised profit
 * without anything having to remember which rows are which. This turns it back.
 *
 * For equities and crypto the multiplier is 1 and this is `deriveUnitCost`.
 */
export function derivePremium(totalCost: Decimal, size: Decimal, multiplier: Decimal): Decimal {
  if (size.isZero() || multiplier.isZero()) {
    return Decimal.ZERO;
  }
  return totalCost.div(size.mul(multiplier), LEDGER_SCALE);
}

/**
 * Return on a single transaction, in basis points.
 *
 * Derived rather than stored: it is a function of two columns already on the row, and a
 * stored copy could only ever disagree with them.
 *
 * Undefined when the transaction realised nothing, and also when the notional is zero —
 * a zero-cost transaction should never reach here, but dividing by it would produce a
 * value every later read has to cope with.
 */
export function deriveRoi(profit: Decimal | undefined, totalCost: Decimal): Decimal | undefined {
  if (profit === undefined) {
    return undefined;
  }
  const notional = totalCost.abs();
  if (notional.isZero()) {
    return undefined;
  }
  return profit.mul(Decimal.of(10000)).div(notional, 2);
}
