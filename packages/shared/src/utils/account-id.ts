import { InvalidRequestError } from '../errors';

/**
 * Account ids are ten characters from a 36-symbol alphabet — digits and uppercase
 * letters only. They are read aloud and typed by hand, and they end up inside an
 * Alpaca `client_order_id`, so the alphabet excludes lowercase and the separators the
 * correlation codec reserves.
 */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ACCOUNT_ID_LENGTH = 10;
const ACCOUNT_ID_PATTERN = /^[0-9A-Z]{10}$/;

const MAX_ACCOUNT_NAME_LENGTH = 50;

/**
 * Word characters, whitespace and parentheses. The legacy pattern was written
 * `/[^(\w|\s|\(|\))]/`, which inside a character class also admits a literal `|` —
 * an accident, not a decision: its own comment said "number, alphabet, _, space, ()".
 * Names already stored are not revalidated, so tightening it only affects new ones.
 */
const ILLEGAL_ACCOUNT_NAME_CHARS = /[^\w\s()]/;

/**
 * Rejection sampling rather than `byte % 36`: 256 is not a multiple of 36, so a plain
 * modulo would make the first four symbols of the alphabet slightly likelier than the
 * rest. The bias is small but it is free to avoid.
 */
const REJECTION_THRESHOLD = 256 - (256 % ALPHABET.length);

export function generateAccountId(): string {
  const characters: string[] = [];
  const buffer = new Uint8Array(ACCOUNT_ID_LENGTH);
  while (characters.length < ACCOUNT_ID_LENGTH) {
    crypto.getRandomValues(buffer);
    for (const byte of buffer) {
      if (byte < REJECTION_THRESHOLD && characters.length < ACCOUNT_ID_LENGTH) {
        characters.push(ALPHABET[byte % ALPHABET.length]);
      }
    }
  }
  return characters.join('');
}

export function assertAccountId(accountId: string): string {
  if (ACCOUNT_ID_PATTERN.test(accountId)) {
    return accountId;
  }
  throw new InvalidRequestError(`Account id "${accountId}" is invalid. Use ${ACCOUNT_ID_LENGTH} characters from 0-9 and A-Z, or omit it to have one generated.`);
}

export function assertAccountName(name: string): string {
  if (name.length === 0) {
    throw new InvalidRequestError('Account name must not be empty.');
  }
  if (name.length > MAX_ACCOUNT_NAME_LENGTH) {
    throw new InvalidRequestError(`Account name must be at most ${MAX_ACCOUNT_NAME_LENGTH} characters, got ${name.length}.`);
  }
  if (ILLEGAL_ACCOUNT_NAME_CHARS.test(name)) {
    throw new InvalidRequestError('Account name may contain only letters, digits, underscores, spaces and parentheses.');
  }
  if (name.trim() !== name) {
    throw new InvalidRequestError('Account name must not begin or end with whitespace.');
  }
  return name;
}
