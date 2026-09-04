/**
 * Template for `credentials.ts`, which is gitignored because it holds real broker keys.
 *
 *   cp packages/playground/src/credentials.example.ts packages/playground/src/credentials.ts
 *
 * Then paste your keys into the copy. This file exists so the package still compiles on
 * a fresh clone — `packages/playground` is in the root `tsconfig.json`, so a missing
 * `credentials.ts` would break `tsc -b` for the whole repo, not just the playground.
 *
 * Keep the two files' exports in step: adding a constant here without adding it to your
 * own `credentials.ts` breaks nobody's build but your own, and the reverse breaks
 * everyone else's.
 */
import { ALPACA_REST_LIVE_URL, ALPACA_REST_PAPER_URL, ALPACA_WS_LIVE_URL, ALPACA_WS_PAPER_URL } from '@fleece/alpaca';

/**
 * One broker account, and everything a playground script needs to connect to it.
 *
 * Scripts take an `AccountInfo` rather than reaching for named constants, so swapping
 * paper for live is choosing a different value, not editing the script.
 */
export interface AccountInfo {
  readonly accountId: string;
  readonly apiKey: string;
  readonly secretKey: string;
  /** For the websocket client. */
  readonly wsUrl: string;
  /** For the REST client. Separate from `wsUrl` because Alpaca serves them from different hosts. */
  readonly restUrl: string;
  /**
   * Real money. Stated rather than inferred from `wsUrl`, because this is the bit a
   * script checks before it warns you, and a typo in a URL should not be able to make
   * a live account quietly present itself as paper.
   */
  readonly live: boolean;
}

export const paperAccountInfo: AccountInfo = {
  accountId: '',
  apiKey: '',
  secretKey: '',
  wsUrl: ALPACA_WS_PAPER_URL,
  restUrl: ALPACA_REST_PAPER_URL,
  live: false,
};

export const liveAccountInfo: AccountInfo = {
  accountId: '',
  apiKey: '',
  secretKey: '',
  wsUrl: ALPACA_WS_LIVE_URL,
  restUrl: ALPACA_REST_LIVE_URL,
  live: true,
};
