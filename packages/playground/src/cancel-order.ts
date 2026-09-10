/**
 * Cancels one Alpaca order, by the broker order id Alpaca assigned it.
 *
 *   npm run cancel-order -w @fleece/playground -- <brokerOrderId>
 *
 * Keys come from the repo-root `.env`, by way of `credentials.ts`. Swap `paperAccount` for
 * `liveAccount` below to cancel on the live account instead.
 *
 * Prints the order before and after, because cancelling tells you almost nothing on
 * its own — see the comments in `main`.
 */
import { HttpAlpacaRestClient } from '@fleece/broker';
import { LoggerFactory } from '@fleece/utilities';
import { prepareAccount } from './account';
import { paperAccount } from './credentials';

const logger = LoggerFactory.getLogger('CancelOrder');

async function main(): Promise<void> {
  const account = prepareAccount(paperAccount(), logger); // swap to liveAccount()

  const client = new HttpAlpacaRestClient({
    account: { accountId: account.accountId, live: account.live },
    credentialsProvider: { accessKey: account.apiKey, secretKey: account.secretKey },
    baseUrl: account.restUrl,
  });

  await client.cancelOrder({ brokerOrderId: '03ba6bb0-3e62-4508-ad44-9a3d8c1b2f67' });
}

main().catch((err: unknown) => {
  logger.error('The cancel failed.', err);
  process.exitCode = 1;
});
