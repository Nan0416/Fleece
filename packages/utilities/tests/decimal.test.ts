import { Decimal, LEDGER_SCALE, sumDecimals } from '../src/decimal';
import { InternalServiceError } from '../src/errors';

/**
 * The arithmetic facade the whole ledger accounts in. It was reached only through
 * `position-reconciliation` before, which exercises the operations the accounting
 * happens to use and says nothing about the ones that guard the boundary — parsing,
 * rendering, and the rounding mode.
 */
describe('Decimal.of', () => {
  it('reads a decimal string exactly, however many places it carries', () => {
    expect(Decimal.of('0.000000001').toString()).toBe('0.000000001');
    expect(Decimal.of('123456789012345678901234567890').toString()).toBe('123456789012345678901234567890');
  });

  it('accepts a bigint, which cannot be routed through a double on the way in', () => {
    expect(Decimal.of(9007199254740993n).toString()).toBe('9007199254740993');
  });

  it.each([
    ['not a number at all', 'abc'],
    ['an empty string', ''],
    ['a number with two points', '1.2.3'],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['NaN', NaN],
  ])('refuses %s rather than producing a value that spreads silently', (_label, value) => {
    expect(() => Decimal.of(value)).toThrow(InternalServiceError);
  });

  it('names the offending value, so a bad row says which one it was', () => {
    expect(() => Decimal.parse('oops', 'position total_cost')).toThrow(/position total_cost/);
  });
});

describe('Decimal arithmetic', () => {
  it('adds exactly where a double would not', () => {
    // The canonical float failure: 0.1 + 0.2 !== 0.3.
    expect(Decimal.of('0.1').add(Decimal.of('0.2')).toString()).toBe('0.3');
  });

  it('keeps a long sum exact, which is what stops a cost basis drifting', () => {
    const tenth = Decimal.of('0.1');
    let total = Decimal.ZERO;
    for (let i = 0; i < 1000; i += 1) {
      total = total.add(tenth);
    }
    expect(total.toString()).toBe('100');
  });

  it('subtracts and multiplies without rounding', () => {
    expect(Decimal.of('1').sub(Decimal.of('0.9')).toString()).toBe('0.1');
    expect(Decimal.of('4.13').mul(Decimal.of('100')).toString()).toBe('413');
  });

  it('refuses to divide by zero rather than producing an Infinity nothing catches', () => {
    expect(() => Decimal.of('1').div(Decimal.ZERO, LEDGER_SCALE)).toThrow(InternalServiceError);
  });

  it('rounds a division half to even, so repeated ties do not bias realised profit', () => {
    // 0.125 and 0.135 are ties at two places. Half-up would round both away from zero
    // and gain a cent every time; banker's rounding sends them to the even digit.
    expect(Decimal.of('0.125').round(2).toString()).toBe('0.12');
    expect(Decimal.of('0.135').round(2).toString()).toBe('0.14');
  });

  it('divides at exactly the scale it is given', () => {
    expect(Decimal.of('1').div(Decimal.of('3'), 9).toString()).toBe('0.333333333');
    expect(Decimal.of('1').div(Decimal.of('3'), 2).toString()).toBe('0.33');
  });
});

describe('Decimal comparison', () => {
  it('treats zero as unsigned', () => {
    expect(Decimal.ZERO.signum()).toBe(0);
    expect(Decimal.ZERO.isPositive()).toBe(false);
    expect(Decimal.ZERO.isNegative()).toBe(false);
    expect(Decimal.of('-0').signum()).toBe(0);
  });

  it('orders values', () => {
    const small = Decimal.of('1.5');
    const large = Decimal.of('2');
    expect(small.cmp(large)).toBe(-1);
    expect(large.cmp(small)).toBe(1);
    expect(small.cmp(Decimal.of('1.50'))).toBe(0);
    expect(small.lt(large)).toBe(true);
    expect(small.lte(Decimal.of('1.5'))).toBe(true);
    expect(large.gt(small)).toBe(true);
    expect(large.gte(Decimal.of('2'))).toBe(true);
    expect(small.eq(Decimal.of('1.500'))).toBe(true);
  });

  it('negates and takes magnitude', () => {
    expect(Decimal.of('-3.5').abs().toString()).toBe('3.5');
    expect(Decimal.of('3.5').neg().toString()).toBe('-3.5');
  });
});

describe('Decimal rendering', () => {
  it('never uses exponent notation, which a NUMERIC column could not parse', () => {
    expect(Decimal.of('0.000000000000001').toString()).toBe('0.000000000000001');
    expect(Decimal.of('1e21').toString()).toBe('1000000000000000000000');
  });

  it('collapses negative zero, which closing at exactly the cost basis computes', () => {
    // It compares equal to zero, so nothing downstream catches it, and it renders as a
    // realised profit of "-0" wherever a number is shown.
    expect(Decimal.of('0').sub(Decimal.of('0')).toString()).toBe('0');
    expect(Decimal.of('-0').toString()).toBe('0');
  });

  it('serialises as a JSON string, never a JSON number', () => {
    expect(JSON.parse(JSON.stringify({ size: Decimal.of('10.000000001') }))).toEqual({ size: '10.000000001' });
  });

  it('pads to a fixed scale for display', () => {
    expect(Decimal.of('1.5').toFixed(4)).toBe('1.5000');
    expect(Decimal.of('1.23456').toFixed(2)).toBe('1.23');
  });

  it('converts to a number only where the caller has asked for the loss', () => {
    expect(Decimal.of('1.5').toNumber()).toBe(1.5);
  });
});

describe('sumDecimals', () => {
  it('sums an empty list to zero rather than throwing', () => {
    expect(sumDecimals([]).toString()).toBe('0');
  });

  it('is exact across values a double would round', () => {
    expect(sumDecimals([Decimal.of('0.1'), Decimal.of('0.2'), Decimal.of('0.3')]).toString()).toBe('0.6');
  });
});
