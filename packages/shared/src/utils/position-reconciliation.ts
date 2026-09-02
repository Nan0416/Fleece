import { roundPrice } from './round-price';

/**
 * Average-cost position accounting. This is the arithmetic the whole ledger rests on,
 * and it is deliberately a pure function with no store, no clock and no logger, so it
 * can be tested exhaustively without a database.
 */

export interface ReconciliationInput {
  /** Current position. Negative is short, 0 is flat. */
  readonly positionSize: number;
  /** Current cost basis per share. Always positive; 0 when flat. */
  readonly positionUnitCost: number;
  /** The trade being applied. Negative is a sell. */
  readonly transactionSize: number;
  readonly transactionUnitCost: number;
}

export interface ReconciliationResult {
  /** Realised profit, present only when the trade reduced an existing position. */
  readonly transactionProfit?: number;
  readonly positionUnitCost: number;
  readonly positionSize: number;
  readonly buyingPowerDelta: number;
}

function hasDifferentSign(a: number, b: number): boolean {
  return (a > 0 && b < 0) || (a < 0 && b > 0);
}

function addProfit(first?: number, second?: number): number | undefined {
  if (typeof first === 'number' && typeof second === 'number') {
    return first + second;
  }
  if (typeof first === 'number') {
    return first;
  }
  return second;
}

/**
 * Applies one trade to one position.
 *
 * A trade that carries a position through zero — selling 15 while long 10 — is two
 * economically different events glued together: closing the 10 realises profit
 * against the old cost basis, and the remaining 5 opens a short at the trade price.
 * Averaging across the flip would produce a cost basis that is neither. So the flip is
 * split into two applications, and the profits are summed.
 */
export function reconcilePosition(input: ReconciliationInput): ReconciliationResult {
  const newPositionSize = input.positionSize + input.transactionSize;

  if (!hasDifferentSign(newPositionSize, input.positionSize)) {
    return applyWithoutFlip(input);
  }

  const closing = applyWithoutFlip({
    positionSize: input.positionSize,
    positionUnitCost: input.positionUnitCost,
    transactionSize: -1 * input.positionSize,
    transactionUnitCost: input.transactionUnitCost,
  });

  const opening = applyWithoutFlip({
    positionSize: closing.positionSize,
    positionUnitCost: closing.positionUnitCost,
    transactionSize: newPositionSize,
    transactionUnitCost: input.transactionUnitCost,
  });

  return {
    positionSize: opening.positionSize,
    positionUnitCost: opening.positionUnitCost,
    transactionProfit: addProfit(closing.transactionProfit, opening.transactionProfit),
    buyingPowerDelta: closing.buyingPowerDelta + opening.buyingPowerDelta,
  };
}

/**
 * The single-direction case: the trade may take the position to zero but never
 * through it. `reconcilePosition` guarantees that by splitting a flip before it gets
 * here.
 */
function applyWithoutFlip(input: ReconciliationInput): ReconciliationResult {
  // Zero has no sign, so a trade against a flat position is never a reduction.
  const reducedPosition = hasDifferentSign(input.transactionSize, input.positionSize);

  // Selling at more than cost is a gain, and the signs work out for shorts too: a
  // negative transactionSize against a positive spread gives a positive profit.
  const transactionProfit = reducedPosition ? input.transactionSize * (input.positionUnitCost - input.transactionUnitCost) : undefined;

  const newPositionSize = input.transactionSize + input.positionSize;

  let newUnitCost = input.positionUnitCost;
  if (input.positionSize === 0) {
    // Opening from flat: the trade price is the cost basis.
    newUnitCost = input.transactionUnitCost;
  } else if (reducedPosition) {
    // Reducing leaves the cost basis of what remains untouched — that is what makes
    // it average cost rather than FIFO — except that closing out resets it.
    if (newPositionSize === 0) {
      newUnitCost = 0;
    }
  } else {
    newUnitCost = (input.positionSize * input.positionUnitCost + input.transactionSize * input.transactionUnitCost) / newPositionSize;
  }

  /**
   * Opening or adding consumes buying power; reducing releases it. Short selling
   * raises cash but still consumes buying power, exactly as a long does, so the
   * magnitude is what matters here and the sign comes from the direction of the trade
   * rather than from the sign of the position.
   */
  const buyingPowerDelta = (reducedPosition ? 1 : -1) * Math.abs(input.transactionSize) * input.transactionUnitCost;

  return {
    positionSize: newPositionSize,
    positionUnitCost: roundPrice(newUnitCost, 4),
    buyingPowerDelta: roundPrice(buyingPowerDelta, 4),
    // `undefined` means "this trade realised nothing", which is a different statement
    // from breaking even. The legacy line was `transactionProfit ? round(...) : undefined`,
    // so a close at exactly the cost basis fell through the truthiness check and was
    // reported as no profit at all — which then left `profit` and `roi` empty on the
    // transaction record rather than 0.
    transactionProfit: typeof transactionProfit === 'number' ? roundPrice(transactionProfit, 4) : undefined,
  };
}
