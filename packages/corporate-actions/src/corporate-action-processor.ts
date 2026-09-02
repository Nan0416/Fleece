import { DividendService, LedgerService } from '@fleece/core';
import { AccountService } from '@fleece/core';
import { MarketDataClient } from '@fleece/marketdata';
import { easternDate, LoggerFactory, shiftIsoDate } from '@fleece/shared';

const logger = LoggerFactory.getLogger('CorporateActionProcessor');

/**
 * How far either side of the reference date to look.
 *
 * Backwards, to catch a dividend Polygon published late. Forwards, so an upcoming
 * dividend is visible before it is paid.
 */
const LOOKBACK_DAYS = 30;
const LOOKAHEAD_DAYS = 30;

/** One page of position history. */
const HISTORY_PAGE_SIZE = 100;

/** A stop, so a symbol with a pathological amount of history cannot spin. */
const MAX_HISTORY_PAGES = 200;

interface DateWindow {
  readonly referenceDate: string;
  readonly from: string;
  readonly to: string;
}

/** The position an account held at the close of a given trading day. */
interface DailyClosePosition {
  readonly date: string;
  readonly size: number;
}

export interface CorporateActionProcessorProps {
  readonly accountService: AccountService;
  readonly ledgerService: LedgerService;
  readonly dividendService: DividendService;
  readonly marketDataClient: MarketDataClient;
}

export interface ProcessCorporateActionsRequest {
  /** Eastern calendar date to process, ISO `YYYY-MM-DD`. Defaults to today. */
  readonly referenceDate?: string;
}

export interface ProcessCorporateActionsResponse {
  readonly accountsProcessed: number;
  readonly symbolsProcessed: number;
  readonly dividendsRecorded: number;
}

/**
 * Records the dividends each virtual account is owed.
 *
 * Splits are deliberately not applied here. Applying one is not idempotent — running
 * it twice splits the position twice — and the job has no way to tell a split it has
 * already applied from one it has not. The legacy processor had the code for it, commented
 * out, under the note "todo: make it idempotent"; splits are applied by hand through
 * `PUT /position/split` until that is solved.
 */
export class CorporateActionProcessor {
  constructor(private readonly props: CorporateActionProcessorProps) {}

  async process(request: ProcessCorporateActionsRequest = {}): Promise<ProcessCorporateActionsResponse> {
    const referenceDate = request.referenceDate ?? easternDate();
    const window: DateWindow = {
      referenceDate,
      from: shiftIsoDate(referenceDate, -LOOKBACK_DAYS),
      to: shiftIsoDate(referenceDate, LOOKAHEAD_DAYS),
    };

    logger.info(`Processing corporate actions for ${referenceDate}, looking at ex-dividend dates from ${window.from} to ${window.to}.`);

    const { accounts } = await this.props.accountService.listAccounts({});
    let symbolsProcessed = 0;
    let dividendsRecorded = 0;

    for (const account of accounts) {
      // Closed positions included: a dividend can be owed on shares held before the
      // ex-dividend date and sold since.
      const { positions } = await this.props.ledgerService.listPositions({ accountId: account.accountId, includeClosed: true });
      for (const position of positions) {
        try {
          dividendsRecorded += await this.processSymbol(account.accountId, position.symbol, window);
          symbolsProcessed += 1;
        } catch (err) {
          // One symbol failing — a data provider hiccup, most likely — must not stop
          // the rest of the run. The next run picks it up again.
          logger.error(`Could not process corporate actions for ${position.symbol} in account ${account.accountId}.`, err);
        }
      }
    }

    logger.info(`Processed ${symbolsProcessed} account/symbol pair(s) across ${accounts.length} account(s); recorded ${dividendsRecorded} dividend(s).`);
    return { accountsProcessed: accounts.length, symbolsProcessed, dividendsRecorded };
  }

  private async processSymbol(accountId: string, symbol: string, window: DateWindow): Promise<number> {
    const { dividends } = await this.props.marketDataClient.listDividends({
      symbol,
      dateType: 'ex_dividend_date',
      fromDate: window.from,
      toDate: window.to,
    });

    if (dividends.length === 0) {
      return 0;
    }

    const history = await this.loadDailyClosePositions(accountId, symbol, window);
    let recorded = 0;

    for (const dividend of dividends) {
      /**
       * Buying on the ex-dividend date does not earn the dividend; holding at the
       * close of the day before does. So the size that matters is the last daily
       * close strictly before that date, not the position today.
       */
      const holding = lastPositionBefore(history, dividend.exDividendDate);

      if (holding === undefined || holding.size === 0) {
        continue;
      }

      await this.props.dividendService.recordDividend({
        accountId,
        symbol,
        size: holding.size,
        amountPerShare: dividend.cashAmount,
        declarationDate: dividend.declarationDate,
        exDividendDate: dividend.exDividendDate,
        recordDate: dividend.recordDate,
        payDate: dividend.payDate,
      });
      recorded += 1;
    }

    return recorded;
  }

  /**
   * The account's closing position in this symbol on each day it changed, oldest
   * first.
   *
   * Built from the transaction log rather than a history table: pages backwards from
   * now until the window's start, then keeps the last position recorded on each day.
   */
  private async loadDailyClosePositions(accountId: string, symbol: string, window: DateWindow): Promise<ReadonlyArray<DailyClosePosition>> {
    const cutoff = Date.parse(`${window.from}T00:00:00Z`);
    const byDate: DailyClosePosition[] = [];
    let seenDate: string | undefined;
    let from = Date.now();

    for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
      const { positions } = await this.props.ledgerService.listHistoricalPositions({
        accountId,
        symbol,
        from,
        limit: HISTORY_PAGE_SIZE,
        sort: 'desc',
      });

      if (positions.length === 0) {
        break;
      }

      for (const position of positions) {
        const date = easternDate(position.updatedAt);
        // Descending by time, so the first entry seen for a date is that day's last —
        // its close.
        if (date !== seenDate) {
          seenDate = date;
          byDate.push({ date, size: position.size });
        }
      }

      const oldest = positions[positions.length - 1];
      if (oldest.updatedAt < cutoff) {
        break;
      }
      // Step past the oldest row so the next page cannot repeat it.
      from = oldest.updatedAt - 1;
    }

    byDate.reverse();
    return byDate;
  }
}

/** The last close strictly before `date`. History is ascending by date. */
function lastPositionBefore(history: ReadonlyArray<DailyClosePosition>, date: string): DailyClosePosition | undefined {
  let found: DailyClosePosition | undefined;
  for (const entry of history) {
    if (entry.date >= date) {
      break;
    }
    found = entry;
  }
  return found;
}
