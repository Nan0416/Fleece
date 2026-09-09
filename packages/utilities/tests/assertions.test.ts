import {
  assertArray,
  assertBoolean,
  assertDecimal,
  assertDefined,
  assertInteger,
  assertNonEmptyString,
  assertNumber,
  assertOneOf,
  assertOptionalDecimal,
  assertOptionalInteger,
  assertOptionalOneOf,
  assertOptionalRecord,
  assertOptionalString,
  assertOptionalStringArray,
  assertOptionalStringMap,
  assertPositiveDecimal,
  assertRecord,
  assertString,
  assertStringArray,
  assertStringMap,
  parseOptionalBooleanParam,
  parseOptionalIntegerParam,
} from '../src/assertions';
import { InvalidRequestError } from '../src/errors';

/**
 * The edge of the service. Everything here exists so that a malformed payload fails
 * with a 400 naming the field, rather than surfacing as a confusing `undefined` deep
 * inside the ledger — so what is asserted is both the accept and the refuse.
 */
describe('scalar assertions', () => {
  it('assertDefined accepts any value but absence, including null', () => {
    expect(assertDefined(0, 'f')).toBe(0);
    expect(assertDefined(null, 'f')).toBeNull();
    expect(() => assertDefined(undefined, 'f')).toThrow(InvalidRequestError);
  });

  it('assertString refuses a non-string, naming the field', () => {
    expect(assertString('a', 'f')).toBe('a');
    expect(() => assertString(1, 'symbol')).toThrow(/symbol must be a string/);
  });

  it('assertNonEmptyString refuses the empty string as well as the wrong type', () => {
    expect(assertNonEmptyString('a', 'f')).toBe('a');
    expect(() => assertNonEmptyString('', 'f')).toThrow(/must not be empty/);
  });

  it('assertNumber refuses NaN, which is a number by typeof and by nothing else', () => {
    expect(assertNumber(1.5, 'f')).toBe(1.5);
    expect(() => assertNumber(NaN, 'f')).toThrow(InvalidRequestError);
    expect(() => assertNumber('1', 'f')).toThrow(InvalidRequestError);
  });

  it('assertInteger refuses a fraction', () => {
    expect(assertInteger(3, 'f')).toBe(3);
    expect(() => assertInteger(3.5, 'f')).toThrow(/must be an integer/);
  });

  it('assertBoolean refuses a string that looks like one', () => {
    expect(assertBoolean(false, 'f')).toBe(false);
    expect(() => assertBoolean('true', 'f')).toThrow(InvalidRequestError);
  });

  it('assertOneOf lists the allowed values when it refuses', () => {
    expect(assertOneOf('buy', 'side', ['buy', 'sell'] as const)).toBe('buy');
    expect(() => assertOneOf('hold', 'side', ['buy', 'sell'] as const)).toThrow(/\[buy, sell\]/);
  });
});

describe('optional assertions', () => {
  it.each([
    ['assertOptionalString', assertOptionalString],
    ['assertOptionalInteger', assertOptionalInteger],
    ['assertOptionalRecord', assertOptionalRecord],
    ['assertOptionalStringArray', assertOptionalStringArray],
    ['assertOptionalStringMap', assertOptionalStringMap],
    ['assertOptionalDecimal', assertOptionalDecimal],
  ])('%s treats an explicit null the same as absence', (_label, assertion) => {
    expect(assertion(undefined, 'f')).toBeUndefined();
    expect(assertion(null, 'f')).toBeUndefined();
  });

  it('assertOptionalOneOf treats null as absence but still checks a value', () => {
    expect(assertOptionalOneOf(null, 'f', ['a'] as const)).toBeUndefined();
    expect(assertOptionalOneOf('a', 'f', ['a'] as const)).toBe('a');
    expect(() => assertOptionalOneOf('b', 'f', ['a'] as const)).toThrow(InvalidRequestError);
  });

  it('an optional assertion still refuses a present value of the wrong type', () => {
    expect(() => assertOptionalInteger('3', 'f')).toThrow(InvalidRequestError);
  });
});

describe('structural assertions', () => {
  it('assertRecord refuses an array and null, which typeof calls objects', () => {
    expect(assertRecord({ a: 1 }, 'f')).toEqual({ a: 1 });
    expect(() => assertRecord([], 'f')).toThrow(/must be an object/);
    expect(() => assertRecord(null, 'f')).toThrow(/must be an object/);
  });

  it('assertRecord copies rather than handing back the object it was given', () => {
    const source = { a: 1 };
    expect(assertRecord(source, 'f')).not.toBe(source);
  });

  it('assertArray refuses a non-array', () => {
    expect(assertArray([1], 'f')).toEqual([1]);
    expect(() => assertArray({}, 'f')).toThrow(/must be an array/);
  });

  it('assertStringArray names the index that failed rather than "an item"', () => {
    expect(assertStringArray(['a', 'b'], 'f')).toEqual(['a', 'b']);
    expect(() => assertStringArray(['a', 2], 'symbols')).toThrow(/symbols\[1\]/);
  });

  it('assertStringMap names the key that failed', () => {
    expect(assertStringMap({ a: 'x' }, 'f')).toEqual({ a: 'x' });
    expect(() => assertStringMap({ a: 1 }, 'env')).toThrow(/env\.a/);
  });
});

describe('query-string parsing', () => {
  it('treats an empty parameter as absent, which is what Express hands back for `?x=`', () => {
    expect(parseOptionalIntegerParam('', 'f')).toBeUndefined();
    expect(parseOptionalBooleanParam('', 'f')).toBeUndefined();
  });

  it('reads an integer out of its string form', () => {
    expect(parseOptionalIntegerParam('42', 'f')).toBe(42);
    expect(() => parseOptionalIntegerParam('4.2', 'f')).toThrow(/must be an integer/);
    expect(() => parseOptionalIntegerParam('abc', 'f')).toThrow(/must be an integer/);
  });

  it('reads a boolean case-insensitively and refuses anything else', () => {
    expect(parseOptionalBooleanParam('TRUE', 'f')).toBe(true);
    expect(parseOptionalBooleanParam('false', 'f')).toBe(false);
    expect(() => parseOptionalBooleanParam('1', 'f')).toThrow(/"true" or "false"/);
  });
});

describe('assertDecimal', () => {
  it('reads a decimal out of a string, exactly', () => {
    expect(assertDecimal('10.000000001', 'size').toString()).toBe('10.000000001');
  });

  it('refuses a JSON number, and says why', () => {
    // A JSON number is a double: whatever precision it could not hold is already gone
    // by the time it reaches here, so accepting it defeats the point of the ledger.
    expect(() => assertDecimal(10.5, 'size')).toThrow(/must be sent as a string/);
  });

  it('refuses a string that is not a number', () => {
    expect(() => assertDecimal('ten', 'size')).toThrow(/must be a decimal number/);
    expect(() => assertDecimal('', 'size')).toThrow(InvalidRequestError);
  });

  it('assertPositiveDecimal refuses zero and negatives, reporting the value seen', () => {
    expect(assertPositiveDecimal('1.5', 'ratio').toString()).toBe('1.5');
    expect(() => assertPositiveDecimal('0', 'ratio')).toThrow(/greater than zero, got 0/);
    expect(() => assertPositiveDecimal('-1', 'ratio')).toThrow(/greater than zero/);
  });
});
