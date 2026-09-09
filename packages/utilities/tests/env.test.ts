import { getenv, getenvBoolean, getenvInteger, getenvList, getenvOneOf } from '../src/env';

const NAME = 'FLEECE_TEST_ENV_VARIABLE';

/**
 * Every process here is configured from the environment and nothing parses arguments,
 * so these are the functions that decide whether a service starts correctly or starts
 * wrong. A malformed value has to fail loudly at boot rather than fall back to a
 * default that quietly is not what the operator wrote.
 */
function withEnv(value: string | undefined, body: () => void): void {
  const previous = process.env[NAME];
  if (value === undefined) {
    delete process.env[NAME];
  } else {
    process.env[NAME] = value;
  }
  try {
    body();
  } finally {
    if (previous === undefined) {
      delete process.env[NAME];
    } else {
      process.env[NAME] = previous;
    }
  }
}

describe('getenv', () => {
  it('reads a value that is set', () => {
    withEnv('hello', () => expect(getenv(NAME)).toBe('hello'));
  });

  it('falls back when unset', () => {
    withEnv(undefined, () => expect(getenv(NAME, 'fallback')).toBe('fallback'));
  });

  it('treats a blank value as unset, so an empty line in a .env file is not configuration', () => {
    withEnv('', () => expect(getenv(NAME, 'fallback')).toBe('fallback'));
  });

  it('throws when required and unset, naming the variable', () => {
    withEnv(undefined, () => expect(() => getenv(NAME)).toThrow(NAME));
  });
});

describe('getenvInteger', () => {
  it('reads an integer', () => {
    withEnv('42', () => expect(getenvInteger(NAME, 1)).toBe(42));
  });

  it('reads a negative integer', () => {
    withEnv('-1', () => expect(getenvInteger(NAME, 1)).toBe(-1));
  });

  it('falls back when unset', () => {
    withEnv(undefined, () => expect(getenvInteger(NAME, 7)).toBe(7));
  });

  it.each([
    ['not a number', 'abc'],
    ['a fraction', '1.5'],
  ])('refuses %s rather than falling back to the default', (_label, value) => {
    withEnv(value, () => expect(() => getenvInteger(NAME, 1)).toThrow(/must be an integer/));
  });
});

describe('getenvBoolean', () => {
  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['false', false],
    ['FALSE', false],
    ['0', false],
  ])('reads %s', (value, expected) => {
    withEnv(value, () => expect(getenvBoolean(NAME, !expected)).toBe(expected));
  });

  it('falls back when unset', () => {
    withEnv(undefined, () => expect(getenvBoolean(NAME, true)).toBe(true));
  });

  it('refuses anything else rather than reading it as false', () => {
    // "yes" quietly meaning false is how a service ends up in the wrong mode.
    withEnv('yes', () => expect(() => getenvBoolean(NAME, false)).toThrow(/must be a boolean/));
  });
});

describe('getenvOneOf', () => {
  const allowed = ['debug', 'info', 'error'] as const;

  it('reads an allowed value', () => {
    withEnv('debug', () => expect(getenvOneOf(NAME, allowed, 'info')).toBe('debug'));
  });

  it('falls back when unset', () => {
    withEnv(undefined, () => expect(getenvOneOf(NAME, allowed, 'info')).toBe('info'));
  });

  it('lists what was allowed when it refuses', () => {
    withEnv('verbose', () => expect(() => getenvOneOf(NAME, allowed, 'info')).toThrow(/debug, info, error/));
  });

  it('is case-sensitive, so a near miss is refused rather than silently defaulted', () => {
    withEnv('DEBUG', () => expect(() => getenvOneOf(NAME, allowed, 'info')).toThrow());
  });
});

describe('getenvList', () => {
  it('splits on commas and trims', () => {
    withEnv('a, b ,c', () => expect(getenvList(NAME)).toEqual(['a', 'b', 'c']));
  });

  it('drops blank entries, so a trailing comma is a typo the caller never handles', () => {
    withEnv('a,,b,', () => expect(getenvList(NAME)).toEqual(['a', 'b']));
  });

  it('falls back when unset, and to an empty list by default', () => {
    withEnv(undefined, () => {
      expect(getenvList(NAME, ['x'])).toEqual(['x']);
      expect(getenvList(NAME)).toEqual([]);
    });
  });

  it('reads a single entry with no comma at all', () => {
    withEnv('http://localhost:5173', () => expect(getenvList(NAME)).toEqual(['http://localhost:5173']));
  });
});
