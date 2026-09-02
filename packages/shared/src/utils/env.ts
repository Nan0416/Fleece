/**
 * Reads one variable from the process environment, or `undefined` when it is unset,
 * blank, or when there is no process environment at all.
 *
 * The `typeof process` guard is what lets `@fleece/shared` be bundled into the
 * browser by `@fleece/web`. Without it the module-level log-level lookup in
 * `logger.ts` throws `process is not defined` before any UI code runs, which is a
 * confusing failure a long way from its cause.
 */
function readEnv(name: string): string | undefined {
  if (typeof process === 'undefined' || process.env === undefined) {
    return undefined;
  }
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  return value;
}

/** Reads an environment variable, falling back to `fallback` when unset. */
export function getenv(name: string, fallback?: string): string {
  const value = readEnv(name);
  if (value !== undefined) {
    return value;
  }
  if (typeof fallback === 'string') {
    return fallback;
  }
  throw new Error(`Required environment variable ${name} is not set`);
}

export function getenvInteger(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (Number.isNaN(value) || !Number.isInteger(value)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  }
  return value;
}

export function getenvBoolean(name: string, fallback: boolean): boolean {
  const raw = readEnv(name);
  if (raw === undefined) {
    return fallback;
  }
  const normalised = raw.toLowerCase();
  if (normalised === 'true' || normalised === '1') {
    return true;
  }
  if (normalised === 'false' || normalised === '0') {
    return false;
  }
  throw new Error(`Environment variable ${name} must be a boolean, got "${raw}"`);
}

export function getenvOneOf<T extends string>(name: string, allowed: ReadonlyArray<T>, fallback: T): T {
  const raw = readEnv(name);
  if (raw === undefined) {
    return fallback;
  }
  const match = allowed.find((candidate) => candidate === raw);
  if (match === undefined) {
    throw new Error(`Environment variable ${name} must be one of [${allowed.join(', ')}], got "${raw}"`);
  }
  return match;
}

/**
 * Reads a comma-separated list. Blank entries are dropped rather than passed through
 * as empty strings, so a trailing comma is a typo the caller never has to handle.
 */
export function getenvList(name: string, fallback: ReadonlyArray<string> = []): ReadonlyArray<string> {
  const raw = readEnv(name);
  if (raw === undefined) {
    return fallback;
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
