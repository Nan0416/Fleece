import { InvalidRequestError } from '../errors';

/**
 * Runtime assertions for data crossing a trust boundary — HTTP bodies, query
 * strings, WebSocket frames, JSON read back off disk. Use these instead of `as`
 * casts so a malformed payload fails at the edge with a 400 rather than surfacing
 * as a confusing `undefined` deep inside the service.
 */

/**
 * Asserts a field is present without constraining its type — for fields such as a
 * message payload, where any JSON value is acceptable but absence is not.
 */
export function assertDefined(value: unknown, field: string): unknown {
  if (value === undefined) {
    throw new InvalidRequestError(`${field} is required`);
  }
  return value;
}

export function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new InvalidRequestError(`${field} must be a string`);
  }
  return value;
}

export function assertNonEmptyString(value: unknown, field: string): string {
  const str = assertString(value, field);
  if (str.length === 0) {
    throw new InvalidRequestError(`${field} must not be empty`);
  }
  return str;
}

export function assertOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return assertString(value, field);
}

export function assertNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new InvalidRequestError(`${field} must be a number`);
  }
  return value;
}

export function assertInteger(value: unknown, field: string): number {
  const num = assertNumber(value, field);
  if (!Number.isInteger(num)) {
    throw new InvalidRequestError(`${field} must be an integer`);
  }
  return num;
}

export function assertOptionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return assertInteger(value, field);
}

export function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new InvalidRequestError(`${field} must be a boolean`);
  }
  return value;
}

export function assertOneOf<T extends string>(value: unknown, field: string, allowed: ReadonlyArray<T>): T {
  const str = assertString(value, field);
  const match = allowed.find((candidate) => candidate === str);
  if (match === undefined) {
    throw new InvalidRequestError(`${field} must be one of [${allowed.join(', ')}]`);
  }
  return match;
}

export function assertOptionalOneOf<T extends string>(value: unknown, field: string, allowed: ReadonlyArray<T>): T | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return assertOneOf(value, field, allowed);
}

export function assertRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidRequestError(`${field} must be an object`);
  }
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    record[key] = entry;
  }
  return record;
}

export function assertOptionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return assertRecord(value, field);
}

export function assertArray(value: unknown, field: string): ReadonlyArray<unknown> {
  if (!Array.isArray(value)) {
    throw new InvalidRequestError(`${field} must be an array`);
  }
  return value;
}

export function assertStringArray(value: unknown, field: string): string[] {
  return assertArray(value, field).map((entry, index) => assertString(entry, `${field}[${index}]`));
}

export function assertOptionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return assertStringArray(value, field);
}

/** A string-to-string map, as used for env and replacement variables. */
export function assertStringMap(value: unknown, field: string): Record<string, string> {
  const record = assertRecord(value, field);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    result[key] = assertString(entry, `${field}.${key}`);
  }
  return result;
}

export function assertOptionalStringMap(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return assertStringMap(value, field);
}

/** Parses a query-string value that should hold an integer. */
export function parseOptionalIntegerParam(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const str = assertString(value, field);
  const num = Number(str);
  if (Number.isNaN(num) || !Number.isInteger(num)) {
    throw new InvalidRequestError(`${field} must be an integer`);
  }
  return num;
}

/** Parses a query-string value that should hold a boolean. */
export function parseOptionalBooleanParam(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const str = assertString(value, field).toLowerCase();
  if (str === 'true') {
    return true;
  }
  if (str === 'false') {
    return false;
  }
  throw new InvalidRequestError(`${field} must be "true" or "false"`);
}
