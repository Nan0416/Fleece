import { Logger } from '@fleece/shared';
import { AccountInfo } from './credentials';

/**
 * The checks a script runs before it touches an account.
 *
 * Shared rather than copied into each script: this is the code that decides whether
 * something reaches real money, and two copies of that rule is one too many.
 */
export function prepareAccount(account: AccountInfo, logger: Logger): AccountInfo {
  const which = account.live ? 'liveAccountInfo' : 'paperAccountInfo';

  // Checked here rather than left to Alpaca: a blank key comes back as a generic
  // refusal, which reads like a wrong key rather than a missing one.
  if (account.apiKey === '' || account.secretKey === '') {
    throw new Error(`No API key for the ${account.live ? 'live' : 'paper'} account. Fill in ${which} in packages/playground/src/credentials.ts.`);
  }
  if (account.live) {
    logger.warn('Running against the LIVE account. These are real orders.');
  }
  return account;
}
