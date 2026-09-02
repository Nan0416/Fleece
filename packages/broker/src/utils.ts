export function hasDifferentSign(first: number, second: number): boolean {
  return (first > 0 && second < 0) || (first < 0 && second > 0);
}

/** Whichever of the two is nearer zero, keeping its own sign. */
export function nearerZero(first: number, second: number): number {
  return Math.abs(first) < Math.abs(second) ? first : second;
}

/** True when no two non-zero entries disagree in sign. An empty list agrees. */
export function allSameSign(numbers: ReadonlyArray<number>): boolean {
  let sign: 'positive' | 'negative' | undefined;
  for (const value of numbers) {
    if (value === 0) {
      continue;
    }
    const current = value > 0 ? 'positive' : 'negative';
    if (sign === undefined) {
      sign = current;
    } else if (sign !== current) {
      return false;
    }
  }
  return true;
}
