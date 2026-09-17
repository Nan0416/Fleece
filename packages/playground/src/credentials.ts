/**
 * The broker accounts a playground script can run against, the market-data keys the chart
 * writers use, and the Discord channels a script posts to, all read from the repo-root `.env`. The only file in
 * `@fleece/playground` that touches `process.env`.
 *
 * | Variable | Used for |
 * | --- | --- |
 * | `ALPACA_PAPER_ACCOUNT_ID` | The paper account's Alpaca account id |
 * | `ALPACA_PAPER_API_KEY` / `ALPACA_PAPER_SECRET_KEY` | The paper account, and the market data the chart writers read |
 * | `ALPACA_LIVE_ACCOUNT_ID` | The live account's Alpaca account id |
 * | `ALPACA_LIVE_API_KEY` / `ALPACA_LIVE_SECRET_KEY` | The live account |
 * | `MARKETDATA_CACHE_PATH` | Where sweeps of Alpaca's market data are kept between runs |
 * | `CREDIT_SPREAD_MONITOR_CHANNEL` | Webhook URL of the channel the position monitor posts every report to |
 * | `CREDIT_SPREAD_ATTENTION_CHANNEL` | Webhook URL of the channel it posts signals and failures to |
 *
 * A script names its account by calling one of these, so no environment variable can move
 * one from paper to live.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { AlpacaAccountIdentifier, AlpacaCredentials } from '@fleece/broker';
import { getenv } from '@fleece/utilities';
import { config as loadEnv } from 'dotenv';

function isRepoRoot(dir: string): boolean {
  const manifest = resolve(dir, 'package.json');
  if (!existsSync(manifest)) {
    return false;
  }
  const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
  return typeof parsed === 'object' && parsed !== null && 'name' in parsed && parsed.name === 'fleece';
}

/**
 * Found by walking up rather than by counting levels: this file runs from `src/` under
 * ts-node and from `dist/src/` after a build, which sit at different depths.
 */
function findRepoRoot(): string {
  let dir = __dirname;
  while (!isRepoRoot(dir)) {
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Found no Fleece repo root above ${__dirname}.`);
    }
    dir = parent;
  }
  return dir;
}

export const REPO_ROOT = findRepoRoot();

// `dotenv` does not throw when the file is absent, so importing this module is safe with
// no `.env` at all.
loadEnv({ path: resolve(REPO_ROOT, '.env'), quiet: true });

function credential(name: string, account: string): string {
  const value = getenv(name, '');
  if (value === '') {
    throw new Error(`${name} is not set, so there is no ${account} account to run against. Add it to the repo-root .env — see .env.example.`);
  }
  return value;
}

export function paperAccount(): AlpacaAccountIdentifier {
  return {
    accountId: credential('ALPACA_PAPER_ACCOUNT_ID', 'paper'),
    live: false,
  };
}

export function paperAccountCredentials(): AlpacaCredentials {
  return {
    accessKey: credential('ALPACA_PAPER_API_KEY', 'paper'),
    secretKey: credential('ALPACA_PAPER_SECRET_KEY', 'paper'),
  };
}

export function liveAccount(): AlpacaAccountIdentifier {
  return {
    accountId: credential('ALPACA_LIVE_ACCOUNT_ID', 'live'),
    live: true,
  };
}

export function liveAccountCredentials(): AlpacaCredentials {
  return {
    accessKey: credential('ALPACA_LIVE_API_KEY', 'live'),
    secretKey: credential('ALPACA_LIVE_SECRET_KEY', 'live'),
  };
}

export function marketDataKeys(): { readonly apiKey: string; readonly secretKey: string } {
  return {
    apiKey: credential('ALPACA_PAPER_API_KEY', 'paper'),
    secretKey: credential('ALPACA_PAPER_SECRET_KEY', 'paper'),
  };
}

/** A webhook URL carries its token, so a missing one is named but no value is ever echoed. */
function webhookUrl(name: string, channel: string): string {
  const value = getenv(name, '');
  if (value === '') {
    throw new Error(`${name} is not set, so there is no ${channel} channel to post to. Add the channel's Discord webhook URL to the repo-root .env — see .env.example.`);
  }
  return value;
}

/** Muted: every position monitor run posts its whole report here, to read when wanted. */
export function creditSpreadMonitorWebhookUrl(): string {
  return webhookUrl('CREDIT_SPREAD_MONITOR_CHANNEL', 'credit spread monitor');
}

/** Notifying: posted to only when a spread has a signal or a run fails. */
export function creditSpreadAttentionWebhookUrl(): string {
  return webhookUrl('CREDIT_SPREAD_ATTENTION_CHANNEL', 'credit spread attention');
}

export function getCachePath(): string {
  return getenv('MARKETDATA_CACHE_PATH');
}
