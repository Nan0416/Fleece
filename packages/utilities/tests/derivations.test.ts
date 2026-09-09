import { Decimal } from '../src/decimal';
import { derivePremium, deriveRoi, deriveUnitCost } from '../src/derivations';

const d = (value: string): Decimal => Decimal.of(value);

describe('deriveUnitCost', () => {
  it('divides the basis by the size', () => {
    expect(deriveUnitCost(d('1000'), d('10')).toString()).toBe('100');
  });

  it('is positive for a short, because both signs cancel', () => {
    // A short of 10 at 50 is a size of -10 against a total cost of -500.
    expect(deriveUnitCost(d('-500'), d('-10')).toString()).toBe('50');
  });

  it('answers zero for a flat position rather than dividing by zero', () => {
    // A statement about a position that holds nothing, not a price of nothing.
    expect(deriveUnitCost(d('0'), d('0')).toString()).toBe('0');
    expect(deriveUnitCost(d('123'), d('0')).toString()).toBe('0');
  });

  it('rounds to the ledger scale rather than carrying an unbounded quotient', () => {
    expect(deriveUnitCost(d('100'), d('3')).toString()).toBe('33.333333333');
  });
});

describe('derivePremium', () => {
  it('turns an option position back into the per-share price the broker quotes', () => {
    // One contract booked at $385 was quoted at 3.85 per share.
    expect(derivePremium(d('385'), d('1'), d('100')).toString()).toBe('3.85');
  });

  it('equals the unit cost for an equity, whose multiplier is one', () => {
    expect(derivePremium(d('1000'), d('10'), Decimal.ONE).toString()).toBe(deriveUnitCost(d('1000'), d('10')).toString());
  });

  it('answers zero rather than dividing by a zero size or a zero multiplier', () => {
    expect(derivePremium(d('385'), d('0'), d('100')).toString()).toBe('0');
    expect(derivePremium(d('385'), d('1'), d('0')).toString()).toBe('0');
  });
});

describe('deriveRoi', () => {
  it('reports basis points', () => {
    // 20 profit on a notional of 200 is 10%, which is 1000 basis points.
    expect(deriveRoi(d('20'), d('200'))?.toString()).toBe('1000');
  });

  it('uses the notional magnitude, so covering a short reports a gain as a gain', () => {
    expect(deriveRoi(d('20'), d('-200'))?.toString()).toBe('1000');
  });

  it('reports a loss as negative', () => {
    expect(deriveRoi(d('-20'), d('200'))?.toString()).toBe('-1000');
  });

  it('distinguishes realising nothing from realising zero', () => {
    // `undefined` in means the transaction realised nothing; zero in is a real
    // break-even and has a real return.
    expect(deriveRoi(undefined, d('200'))).toBeUndefined();
    expect(deriveRoi(d('0'), d('200'))?.toString()).toBe('0');
  });

  it('is undefined against a zero notional rather than producing a value every reader must cope with', () => {
    expect(deriveRoi(d('20'), d('0'))).toBeUndefined();
  });
});
