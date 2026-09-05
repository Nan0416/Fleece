import { Decimal, LEDGER_SCALE } from './decimal';

/**
 * Average-cost position accounting. This is the arithmetic the whole ledger rests on,
 * and it is deliberately a pure function with no store, no clock and no logger, so it
 * can be tested exhaustively without a database.
 *
 * **It accounts in total cost, never in a unit price.** A position is a signed size and
 * the signed dollars behind it; a transaction is the same. That single change removes
 * division from every path but one:
 *
 * | Operation | Arithmetic |
 * | --- | --- |
 * | Opening or adding | `size + size`, `cost + cost` — exact |
 * | Closing out entirely | the whole basis is removed — exact, no division |
 * | Reducing part of a position | one division, residue conserved |
 * | A position flipping through zero | one division, residue conserved |
 *
 * **The conservation rule.** Where a division is unavoidable, one side is rounded and
 * the other is derived from it with a subtraction — never a second division. So the two
 * halves always add back to exactly what was there before, and no cost is created or
 * destroyed by rounding.
 *
 * That is what makes this hold *exactly*, per account and symbol, rather than
 * approximately:
 *
 *     position.totalCost == sum(transaction.totalCost) + sum(transaction.profit)
 *
 * Every transaction moves the basis by exactly `totalCost + profit`. An opening trade
 * adds what it cost and realises nothing; a reduction retires a basis of
 * `-totalCost - profit`, which is the same expression with the signs it already has. So
 * a position is the running sum of its own log, and nothing rounds its way out of it.
 *
 * **Why not lots.** Apportioning one shared basis across a partial sale is inherently a
 * ratio, so average cost cannot be division-free. FIFO lot accounting can be — each lot
 * keeps its own exact cost and a sale consumes lots whole, splitting at most one — but
 * it is a different accounting method with different reported profit, and it needs a
 * lot table. Recorded here so the choice reads as a choice.
 */

export interface ReconciliationInput {
  /** Current position. Negative is short, 0 is flat. */
  readonly positionSize: Decimal;
  /** Dollars behind the current position. Signed the same way as `positionSize`. */
  readonly positionTotalCost: Decimal;
  /** The transaction being applied. Negative is a sell. */
  readonly transactionSize: Decimal;
  /** Dollars the transaction moved. Signed the same way as `transactionSize`. */
  readonly transactionTotalCost: Decimal;
}

export interface ReconciliationResult {
  /** Realised profit, present only when the transaction reduced an existing position. */
  readonly transactionProfit?: Decimal;
  readonly positionSize: Decimal;
  readonly positionTotalCost: Decimal;
  readonly buyingPowerDelta: Decimal;
}

function hasDifferentSign(a: Decimal, b: Decimal): boolean {
  return a.signum() * b.signum() < 0;
}

function addProfit(first?: Decimal, second?: Decimal): Decimal | undefined {
  if (first !== undefined && second !== undefined) {
    return first.add(second);
  }
  return first ?? second;
}

/**
 * Applies one transaction to one position.
 *
 * A transaction that carries a position through zero — selling 15 while long 10 — is two
 * economically different events glued together: closing the 10 realises profit against
 * the old cost basis, and the remaining 5 opens a short at the transaction price.
 * Averaging across the flip would produce a cost basis that is neither. So the flip is
 * split into two applications and the profits are summed.
 *
 * Splitting it means apportioning the transaction's dollars across the two halves,
 * which is the second of the two divisions in this file. The closing half is rounded and
 * the opening half is what is left over, so the two always add back to exactly the
 * transaction's own total cost.
 */
export function reconcilePosition(input: ReconciliationInput): ReconciliationResult {
  const newPositionSize = input.positionSize.add(input.transactionSize);

  if (!hasDifferentSign(newPositionSize, input.positionSize)) {
    return applyWithoutFlip(input);
  }

  // The part of the transaction that closes the existing position, and the dollars
  // belonging to it.
  const closingSize = input.positionSize.neg();
  const closingTotalCost = input.transactionTotalCost.mul(closingSize).div(input.transactionSize, LEDGER_SCALE);

  const closing = applyWithoutFlip({
    positionSize: input.positionSize,
    positionTotalCost: input.positionTotalCost,
    transactionSize: closingSize,
    transactionTotalCost: closingTotalCost,
  });

  const opening = applyWithoutFlip({
    positionSize: closing.positionSize,
    positionTotalCost: closing.positionTotalCost,
    transactionSize: newPositionSize,
    // Subtraction, not a second division: whatever rounding the closing half took, the
    // opening half absorbs, and the two still sum to the transaction's own total.
    transactionTotalCost: input.transactionTotalCost.sub(closingTotalCost),
  });

  return {
    positionSize: opening.positionSize,
    positionTotalCost: opening.positionTotalCost,
    transactionProfit: addProfit(closing.transactionProfit, opening.transactionProfit),
    buyingPowerDelta: closing.buyingPowerDelta.add(opening.buyingPowerDelta),
  };
}

/**
 * The single-direction case: the transaction may take the position to zero but never
 * through it. `reconcilePosition` guarantees that by splitting a flip before it gets
 * here.
 */
function applyWithoutFlip(input: ReconciliationInput): ReconciliationResult {
  // Zero has no sign, so a transaction against a flat position is never a reduction.
  const reducedPosition = hasDifferentSign(input.transactionSize, input.positionSize);
  const newPositionSize = input.positionSize.add(input.transactionSize);

  let newPositionTotalCost: Decimal;
  let transactionProfit: Decimal | undefined;

  if (!reducedPosition) {
    // Opening or adding. Pure addition — exact at any size, any price, any number of
    // fills. This is the path almost every transaction takes.
    newPositionTotalCost = input.positionTotalCost.add(input.transactionTotalCost);
  } else {
    // Reducing. The basis of what was sold has to come out, and that share of a pooled
    // cost is the one genuinely unavoidable division in the ledger.
    //
    // Closing out entirely is special-cased rather than left to the general formula,
    // and not as an optimisation: `cost x size / size` would round a value that is
    // exactly known, so a position closed in full could leave a residue of basis behind
    // with nothing holding it. Taking the whole basis is exact by construction.
    const costRemoved = newPositionSize.isZero() ? input.positionTotalCost : input.positionTotalCost.mul(input.transactionSize.neg()).div(input.positionSize, LEDGER_SCALE);

    // Subtraction, not a second division. Whatever the rounding above gave up lands
    // here, so the basis that remains plus the basis removed is exactly the basis there
    // was. Reducing leaves the cost of what remains untouched, which is what makes this
    // average cost rather than FIFO.
    newPositionTotalCost = input.positionTotalCost.sub(costRemoved);

    // Proceeds less the basis they retired. The transaction's total cost is signed
    // opposite to the position being reduced, so negating it turns a sale into the
    // dollars it brought in, and the same expression covers a short being covered:
    // shorting 10 at 50 and buying 4 back at 45 gives -180 - (-200) = 20.
    transactionProfit = input.transactionTotalCost.neg().sub(costRemoved);
  }

  // Opening or adding consumes buying power; reducing releases it. Short selling raises
  // cash but still consumes buying power exactly as a long does, so the magnitude is
  // what matters and the sign comes from the direction of the transaction rather than
  // from the sign of the position.
  const buyingPowerDelta = reducedPosition ? input.transactionTotalCost.abs() : input.transactionTotalCost.abs().neg();

  return {
    positionSize: newPositionSize,
    positionTotalCost: newPositionTotalCost,
    buyingPowerDelta,
    // `undefined` means "this transaction realised nothing", which is a different
    // statement from breaking even. The legacy line was
    // `transactionProfit ? round(...) : undefined`, so a close at exactly the cost basis
    // fell through the truthiness check and was reported as no profit at all.
    transactionProfit,
  };
}
