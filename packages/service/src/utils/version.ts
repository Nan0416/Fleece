import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Read from package.json rather than kept as a constant here, so it cannot drift from
 * the version that was actually published. `dist/` and `src/` are both one level under
 * the package root, so the same path resolves whether this is running compiled or
 * through ts-jest.
 */
export function serviceVersion(): string {
  try {
    const raw = readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed && typeof parsed.version === 'string') {
      return parsed.version;
    }
  } catch {
    // Reporting a version is a convenience; failing to read one must not stop the
    // service from starting.
  }
  return 'unknown';
}
