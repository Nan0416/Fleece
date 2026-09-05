import { Decimal } from '@fleece/shared';

export function hasDifferentSign(first: Decimal, second: Decimal): boolean {
  return first.signum() * second.signum() < 0;
}

/** Whichever of the two is nearer zero, keeping its own sign. */
export function nearerZero(first: Decimal, second: Decimal): Decimal {
  return first.abs().lt(second.abs()) ? first : second;
}

/** True when no two non-zero entries disagree in sign. An empty list agrees. */
export function allSameSign(sizes: ReadonlyArray<Decimal>): boolean {
  let sign: -1 | 1 | undefined;
  for (const value of sizes) {
    const current = value.signum();
    if (current === 0) {
      continue;
    }
    if (sign === undefined) {
      sign = current;
    } else if (sign !== current) {
      return false;
    }
  }
  return true;
}
