/**
 * The market-data client these helpers share, and the disk cache behind it.
 *
 * Keys come from the repo-root `.env` — `ALPACA_PAPER_API_KEY` and
 * `ALPACA_PAPER_SECRET_KEY` — as the surface scripts do, and for the same reason: these
 * are market-data keys rather than broker keys.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { AlpacaMarketDataClient } from '@fleece/marketdata';
import { easternClock } from '@fleece/utilities';
import { config as loadEnv } from 'dotenv';

/** `dist/research/` at runtime, so four levels up is the repo root. */
const ROOT = resolve(__dirname, '../../../..');
const CACHE = resolve(ROOT, 'packages/playground/data/research');

let client: AlpacaMarketDataClient | undefined;

export function marketDataClient(): AlpacaMarketDataClient {
  if (client === undefined) {
    loadEnv({ path: resolve(ROOT, '.env'), quiet: true });
    const apiKey = process.env['ALPACA_PAPER_API_KEY'];
    const secretKey = process.env['ALPACA_PAPER_SECRET_KEY'];
    if (apiKey === undefined || secretKey === undefined) {
      throw new Error('The research helpers need ALPACA_PAPER_API_KEY and ALPACA_PAPER_SECRET_KEY in the repo-root .env.');
    }
    client = new AlpacaMarketDataClient({ apiKey, secretKey });
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
