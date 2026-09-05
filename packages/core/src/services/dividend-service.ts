import { Dividend, easternDate, isIsoDate, InvalidRequestError, ListDividendsRequest, ListDividendsResponse, LoggerFactory, NotFoundError, Decimal } from '@fleece/shared';
import { AccountDao } from '../data/account-dao';
import { DividendDao } from '../data/dividend-dao';

const logger = LoggerFactory.getLogger('DividendService');

interface DateField {
  readonly field: string;
  readonly value: string;
}

export interface RecordDividendRequest {
  readonly accountId: string;
  readonly symbol: string;
  readonly exDividendDate: string;
  /** The position held going into the ex-dividend date; negative for a short. */
  readonly size: Decimal;
  readonly amountPerShare: Decimal;
  readonly declarationDate: string;
  readonly recordDate: string;
  readonly payDate: string;
}

export interface RecordDividendResponse {
  readonly dividend: Dividend;
}

export class DividendService {
  /**
   * `now` is injected rather than read from the clock so that status derivation is
   * testable: every dividend is `declared`, `pending`, `recorded` or `paid` purely as
   * a function of today's Eastern date against its four dates.
   */
  constructor(
    private readonly dividendDao: DividendDao,
    private readonly accountDao: AccountDao,
    private readonly now: () => number = Date.now,
  ) {}

  async listDividends(request: ListDividendsRequest): Promise<ListDividendsResponse> {
    await this.requireAccount(request.accountId);
    return await this.dividendDao.listDividends({
      accountId: request.accountId,
      symbol: request.symbol,
      today: easternDate(this.now()),
    });
  }

  async recordDividend(request: RecordDividendRequest): Promise<RecordDividendResponse> {
    await this.requireAccount(request.accountId);

    const dates: ReadonlyArray<DateField> = [
      { field: 'exDividendDate', value: request.exDividendDate },
      { field: 'declarationDate', value: request.declarationDate },
      { field: 'recordDate', value: request.recordDate },
      { field: 'payDate', value: request.payDate },
    ];
    for (const { field, value } of dates) {
      if (!isIsoDate(value)) {
        throw new InvalidRequestError(`${field} must be an Eastern calendar date in YYYY-MM-DD form, got "${value}".`);
      }
    }

    logger.info(
      `Recording a ${request.amountPerShare.toString()}/share dividend on ${request.symbol} for account ${request.accountId}, ex-dividend ${request.exDividendDate}, size ${request.size.toString()}.`,
    );
    return await this.dividendDao.upsertDividend({ ...request, today: easternDate(this.now()) });
  }

  private async requireAccount(accountId: string): Promise<void> {
    const { account } = await this.accountDao.getAccount({ accountId });
    if (account === null) {
      throw new NotFoundError(`Account ${accountId} does not exist. List accounts to see which ids are in use.`);
    }
  }
}
