import { getenv, getenvBoolean, getenvInteger, LoggerFactory } from '@fleece/shared';
import { AlpacaAccountIdentifier, AlpacaCredentials } from '@fleece/alpaca';

const logger = LoggerFactory.getLogger('TrackingConfig');

export interface BrokerAccountConfig {
  readonly account: AlpacaAccountIdentifier;
  readonly credentials: AlpacaCredentials;
}

export interface TrackingConfig {
  readonly databaseUrl: string;
  /** The port `PUT /track` listens on. Distinct from the API's, which is 3100. */
  readonly port: number;
  readonly host: string;
  /** Bearer token callers must present. Unset disables authentication. */
  readonly authToken?: string;
  readonly brokerAccounts: ReadonlyArray<BrokerAccountConfig>;
  /**
   * Where a fill lands when no strategy claims it — an order placed by hand on the
   * broker's website, most often. Separate accounts for live and paper so real and
   * simulated money can never end up in the same one.
   */
  readonly defaultLiveAccountId: string;
  readonly defaultPaperAccountId: string;
  /** How long to wait for an execution service to claim an order before giving up. */
  readonly unresolvedTimeoutMs: number;
}

/**
 * Reads one broker account's settings from the environment.
 *
 * The first account uses unsuffixed names; further accounts are numbered from 2, so a
 * single-account setup — which is the usual one — needs no numbering at all:
 *
 *   FLEECE_ALPACA_ACCOUNT_ID=PA3XYZ        FLEECE_ALPACA_2_ACCOUNT_ID=PA9ABC
 *   FLEECE_ALPACA_KEY=...                  FLEECE_ALPACA_2_KEY=...
 *   FLEECE_ALPACA_SECRET=...               FLEECE_ALPACA_2_SECRET=...
 *   FLEECE_ALPACA_LIVE=false               FLEECE_ALPACA_2_LIVE=true
 *
 * The legacy injector read this list from a remote config service, which also served
 * the credentials. That service is not part of this port.
 */
function readBrokerAccount(index: number): BrokerAccountConfig | undefined {
  const prefix = index === 1 ? 'FLEECE_ALPACA' : `FLEECE_ALPACA_${index}`;
  const accountId = process.env[`${prefix}_ACCOUNT_ID`];
  if (typeof accountId !== 'string' || accountId.length === 0) {
    return undefined;
  }

  return {
    account: { accountId, live: getenvBoolean(`${prefix}_LIVE`, false) },
    // No defaults: a missing key should stop the injector at startup rather than
    // surface later as an authorization failure against the broker.
    credentials: { accessKey: getenv(`${prefix}_KEY`), secretKey: getenv(`${prefix}_SECRET`) },
  };
}

/** The single place this package reads `process.env`. */
export function loadTrackingConfig(): TrackingConfig {
  const stage = getenv('FLEECE_STAGE', 'beta');

  const brokerAccounts: BrokerAccountConfig[] = [];
  for (let index = 1; ; index += 1) {
    const account = readBrokerAccount(index);
    if (account === undefined) {
      break;
    }
    brokerAccounts.push(account);
  }

  if (brokerAccounts.length === 0) {
    logger.warn('No broker accounts are configured. Set FLEECE_ALPACA_ACCOUNT_ID, FLEECE_ALPACA_KEY and FLEECE_ALPACA_SECRET; the injector will do nothing until you do.');
  }

  const live = brokerAccounts.filter((entry) => entry.account.live);
  if (live.length > 0) {
    logger.warn(`Connected to ${live.length} LIVE Alpaca account(s): ${live.map((entry) => entry.account.accountId).join(', ')}. Fills recorded from these moved real money.`);
  }

  return {
    databaseUrl: getenv('FLEECE_DATABASE_URL', `postgres://localhost:5432/fleece_${stage}`),
    port: getenvInteger('FLEECE_TRACKING_PORT', 3101),
    // Loopback by default, like the API: a claim decides which account an order's fills
    // are booked to, so exposing the port needs to be a deliberate act.
    host: getenv('FLEECE_TRACKING_HOST', '127.0.0.1'),
    authToken: process.env['FLEECE_TRACKING_TOKEN'],
    brokerAccounts,
    defaultLiveAccountId: getenv('FLEECE_DEFAULT_LIVE_ACCOUNT_ID', '0000000002'),
    defaultPaperAccountId: getenv('FLEECE_DEFAULT_PAPER_ACCOUNT_ID', '0000000001'),
    unresolvedTimeoutMs: Number(getenv('FLEECE_UNRESOLVED_ORDER_TIMEOUT_MS', '60000')),
  };
}
