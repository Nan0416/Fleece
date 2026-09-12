/**
 * The broker accounts a playground script can run against, and the market-data keys the
 * chart writers use, all read from the repo-root `.env`. The only file in
 * `@fleece/playground` that touches `process.env`.
 *
 * | Variable | Used for |
 * | --- | --- |
 * | `ALPACA_PAPER_ACCOUNT_ID` | The paper account's Alpaca account id |
 * | `ALPACA_PAPER_API_KEY` / `ALPACA_PAPER_SECRET_KEY` | The paper account, and the market data the chart writers read |
 * | `ALPACA_LIVE_ACCOUNT_ID` | The live account's Alpaca account id |
 * | `ALPACA_LIVE_API_KEY` / `ALPACA_LIVE_SECRET_KEY` | The live account |
 * | `MARKETDATA_CACHE_PATH` | Where sweeps of Alpaca's market data are kept between runs |
 *
 * A script names its account by calling one of these, so no environment variable can move
 * one from paper to live.
 */
import { resolve } from 'node:path';

import { ALPACA_REST_LIVE_URL, ALPACA_REST_PAPER_URL, ALPACA_WS_LIVE_URL, ALPACA_WS_PAPER_URL } from '@fleece/broker';
import { getenv } from '@fleece/utilities';
import { config as loadEnv } from 'dotenv';

/** `dist/` at runtime, so three levels up is the repo root. */
const REPO_ROOT = resolve(__dirname, '../../..');

// `dotenv` does not throw when the file is absent, so importing this module is safe with
// no `.env` at all.
loadEnv({ path: resolve(REPO_ROOT, '.env'), quiet: true });

export interface AccountInfo {
  readonly accountId: string;
  readonly apiKey: string;
  readonly secretKey: string;
  /** For the websocket client. */
  readonly wsUrl: string;
  /** For the REST client. Separate from `wsUrl` because Alpaca serves them from different hosts. */
  readonly restUrl: string;
  /** Real money. Stated rather than inferred from a URL, so a typo cannot make live look like paper. */
  readonly live: boolean;
}

function credential(name: string, account: string): string {
  const value = getenv(name, '');
  if (value === '') {
    throw new Error(`${name} is not set, so there is no ${account} account to run against. Add it to the repo-root .env — see .env.example.`);
  }
  return value;
}

// Functions, not constants: nothing is read until a script asks for one account, so a
// missing live key never breaks a paper script and importing this never throws.
export function paperAccount(): AccountInfo {
  return {
    accountId: credential('ALPACA_PAPER_ACCOUNT_ID', 'paper'),
    apiKey: credential('ALPACA_PAPER_API_KEY', 'paper'),
    secretKey: credential('ALPACA_PAPER_SECRET_KEY', 'paper'),
    wsUrl: ALPACA_WS_PAPER_URL,
    restUrl: ALPACA_REST_PAPER_URL,
    live: false,
  };
}

export function liveAccount(): AccountInfo {
  return {
    accountId: credential('ALPACA_LIVE_ACCOUNT_ID', 'live'),
    apiKey: credential('ALPACA_LIVE_API_KEY', 'live'),
    secretKey: credential('ALPACA_LIVE_SECRET_KEY', 'live'),
    wsUrl: ALPACA_WS_LIVE_URL,
    restUrl: ALPACA_REST_LIVE_URL,
    live: true,
  };
}

export function marketDataKeys(): { readonly apiKey: string; readonly secretKey: string } {
  return {
    apiKey: credential('ALPACA_PAPER_API_KEY', 'paper'),
    secretKey: credential('ALPACA_PAPER_SECRET_KEY', 'paper'),
  };
}

export function getCachePath(): string {
  return getenv('MARKETDATA_CACHE_PATH');
}
