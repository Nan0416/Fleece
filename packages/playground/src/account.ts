import { Logger } from '@fleece/utilities';
import { AccountInfo } from './credentials';

/** The one place that decides whether a script reaches real money. */
export function prepareAccount(account: AccountInfo, logger: Logger): AccountInfo {
  if (account.live) {
    logger.warn('Running against the LIVE account. These are real orders.');
  }
  return account;
}
