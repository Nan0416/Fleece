import { assertAccountId, assertAccountName, generateAccountId } from '../../src/utils/account-id';
import { InvalidRequestError } from '../../src/errors';

describe('generateAccountId', () => {
  it('produces ten characters from the digit-and-uppercase alphabet', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(generateAccountId()).toMatch(/^[0-9A-Z]{10}$/);
    }
  });

  it('produces ids that pass its own validator', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(() => assertAccountId(generateAccountId())).not.toThrow();
    }
  });

  it('does not repeat itself across a batch', () => {
    const ids = new Set(Array.from({ length: 1000 }, generateAccountId));
    expect(ids.size).toBe(1000);
  });

  it('draws every symbol of the alphabet, so rejection sampling has not narrowed the range', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i += 1) {
      for (const character of generateAccountId()) {
        seen.add(character);
      }
    }
    expect(seen.size).toBe(36);
  });
});

describe('assertAccountId', () => {
  it('accepts a well-formed id', () => {
    expect(assertAccountId('0123456789')).toBe('0123456789');
    expect(assertAccountId('ABCDEFGHIJ')).toBe('ABCDEFGHIJ');
  });

  it.each([
    ['too short', '012345678'],
    ['too long', '01234567890'],
    ['lowercase', 'abcdefghij'],
    ['punctuation', '012345678-'],
    ['empty', ''],
    ['a separator the correlation codec reserves', '01234567;9'],
  ])('rejects an id that is %s', (_reason, candidate) => {
    expect(() => assertAccountId(candidate)).toThrow(InvalidRequestError);
  });
});

describe('assertAccountName', () => {
  it.each([['Momentum'], ['Mean Reversion (v2)'], ['pairs_trading_3']])('accepts %s', (name) => {
    expect(assertAccountName(name)).toBe(name);
  });

  it('rejects an empty name', () => {
    expect(() => assertAccountName('')).toThrow(InvalidRequestError);
  });

  it('rejects a name longer than fifty characters', () => {
    expect(() => assertAccountName('a'.repeat(51))).toThrow(InvalidRequestError);
    expect(assertAccountName('a'.repeat(50))).toHaveLength(50);
  });

  it('rejects leading or trailing whitespace, which is invisible in a listing', () => {
    expect(() => assertAccountName(' Momentum')).toThrow(InvalidRequestError);
    expect(() => assertAccountName('Momentum ')).toThrow(InvalidRequestError);
  });

  it('rejects the pipe the legacy pattern let through by accident', () => {
    // `/[^(\w|\s|\(|\))]/` admits a literal `|` inside the character class, contrary
    // to its own comment: "number, alphabet, _, space, ()".
    expect(() => assertAccountName('Momentum|Reversion')).toThrow(InvalidRequestError);
  });

  it.each([
    ['a comma', 'Momentum, v2'],
    ['a slash', 'Momentum/2'],
    ['an emoji', 'Momentum 🚀'],
  ])('rejects %s', (_reason, name) => {
    expect(() => assertAccountName(name)).toThrow(InvalidRequestError);
  });
});
