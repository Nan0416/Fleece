/**
 * The market-data client these helpers share, and the disk cache behind it.
 *
 * Keys come from `credentials.ts`, which is the one file in this package that reads the
 * environment.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { AlpacaMarketDataClient } from '@fleece/marketdata';
import { easternClock } from '@fleece/utilities';

import { marketDataKeys } from '../credentials';

/** `dist/research/` at runtime, so four levels up is the repo root. */
const ROOT = resolve(__dirname, '../../../..');
const CACHE = resolve(ROOT, 'packages/playground/data/research');

let client: AlpacaMarketDataClient | undefined;

/** Built once and kept, so a loop over sessions does not rebuild it per day. */
export function marketDataClient(): AlpacaMarketDataClient {
  if (client === undefined) {
    client = new AlpacaMarketDataClient(marketDataKeys());
  }
  return client;
}

/** Whether a date is far enough back that nothing about it can still change. */
export function settled(date: string): boolean {
  return date < easternClock.date();
}

/**
 * Reads `key` from disk, or loads it and writes it there.
 *
 * Only when `keep`, which callers set from `settled`: a day that has not finished is a
 * day whose bars are still arriving, and caching one would pin a partial session as if
 * it were the whole thing. Cached values cross as JSON, so `load` must return something
 * JSON survives — arrays and plain objects, not a `Map`.
 */
export async function cached<T>(key: string, keep: boolean, load: () => Promise<T>): Promise<T> {
  const file = resolve(CACHE, `${key.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  if (keep) {
    try {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- our own file, written by the branch below.
      return JSON.parse(readFileSync(file, 'utf8')) as T;
    } catch {
      // Absent or unreadable: fetch it and write a good copy over whatever was there.
    }
  }

  const loaded = await load();
  if (keep) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(loaded));
  }
  return loaded;
}
