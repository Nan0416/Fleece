/**
 * Cancels one Alpaca order, by the broker order id Alpaca assigned it.
 *
 *   npm run cancel-order -w @fleece/playground -- <brokerOrderId>
 *
 * Swap `ACCOUNT` below to cancel on the live account instead; that is a deliberate
 * edit, which is the point. On a live account the script asks before it cancels, and
 * `--yes` skips the question.
 *
 * Prints the order before and after, because cancelling tells you almost nothing on
 * its own — see the comments in `main`.
 */
import { HttpAlpacaRestClient } from '@fleece/alpaca';
import { LoggerFactory } from '@fleece/shared';
import { liveAccountInfo, paperAccountInfo } from './credentials';


const logger = LoggerFactory.getLogger('CancelOrder');



async function main(): Promise<void> {

  const account = paperAccountInfo ?? liveAccountInfo;

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
