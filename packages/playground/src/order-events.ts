/**
 * Opens an Alpaca trade_updates stream and prints every order event as JSON.
 *
 *   npm run order-events -w @fleece/playground        # paper
 *   npm run order-events:live -w @fleece/playground   # live
 *
 * Keys come from `credentials.ts`, which is gitignored — see `credentials.example.ts`.
 *
 * Place, replace or cancel an order in that account and it shows up here. Note that
 * the stream is quiet outside market hours: Alpaca sends no `new` or `accepted` event
 * while the market is closed, so a silent console is not necessarily a broken
 * connection — the "stream is listening" line is what says the socket is up.
 *
 * `WsAlpacaWsClient` hands its handlers `data.order` only, so the trade-update wrapper
 * (`event`, `execution_id`, `price`, `qty`, `timestamp`) is not printed here.
 * `order.status` carries most of the same information.
 */
import { AlpacaOrder, WsAlpacaWsClient } from '@fleece/alpaca';
import { LoggerFactory } from '@fleece/shared';
import { AccountInfo, liveAccountInfo, paperAccountInfo } from './credentials';

const logger = LoggerFactory.getLogger('OrderEvents');

/** Resolves on the first SIGINT or SIGTERM, so Ctrl-C closes the socket rather than killing the process mid-frame. */
function untilInterrupted(): Promise<void> {
  return new Promise<void>((resolve) => {
    const stop = (): void => {
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

async function streamOrderEvents(account: AccountInfo): Promise<void> {
  // `terminate` closes the socket, which fires `onDisconnected` like any other drop.
  // Without this the last thing Ctrl-C prints is a warning promising a reconnect that
  // is never coming.
  let stopping = false;

  const client = new WsAlpacaWsClient({
    account: { accountId: account.accountId, live: account.live },
    credentialsProvider: { accessKey: account.apiKey, secretKey: account.secretKey },
    url: account.wsUrl,
    onDisconnected: (code, reason) => {
      if (stopping) {
        return;
      }
      logger.warn(`Stream disconnected: code ${code} ${reason}. The client reconnects on its own.`);
    },
  });

  client.addOrderEventHandler((order: AlpacaOrder) => {
    console.log(JSON.stringify(order, null, 2));
  });

  // `finally`, not a trailing call: a rejected `init` — a refused key is the usual
  // one — leaves the socket open, and an open socket keeps the process alive forever
  // after the error has already been printed.
  try {
    await client.init();
    logger.info(`Listening on ${account.wsUrl}. Ctrl-C to stop.`);
    await untilInterrupted();
  } finally {
    stopping = true;
    await client.terminate();
  }
}

async function main(): Promise<void> {
  const account = liveAccountInfo ?? paperAccountInfo;
  const which = account.live ? 'liveAccountInfo' : 'paperAccountInfo';

  if (account.apiKey === '' || account.secretKey === '') {
    throw new Error(`No API key for the ${account.live ? 'live' : 'paper'} account. Fill in ${which} in packages/playground/src/credentials.ts.`);
  }
  if (account.live) {
    logger.warn('Connecting to the LIVE account. This script only reads the stream, but the orders it prints are real.');
  }

  await streamOrderEvents(account);
}

main().catch((err: unknown) => {
  logger.error('The order event stream stopped.', err);
  process.exitCode = 1;
});
