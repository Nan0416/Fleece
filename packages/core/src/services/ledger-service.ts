import {
  Account,
  GetPositionRequest,
  GetPositionResponse,
  GetProfitRequest,
  GetProfitResponse,
  InvalidRequestError,
  ListHistoricalPositionsRequest,
  ListHistoricalPositionsResponse,
  ListPositionsRequest,
  ListPositionsResponse,
  ListProfitsRequest,
  ListProfitsResponse,
  ListTransactionsByReferenceIdRequest,
  ListTransactionsByReferenceIdResponse,
  ListTransactionsRequest,
  ListTransactionsResponse,
  LoggerFactory,
  NotFoundError,
  StockSplitRequest,
  StockSplitResponse,
  Transaction,
  TransferOrderRecord,
  TransferPositionRequest,
  TransferPositionResponse,
} from '@fleece/shared';
import { TRANSFER_BROKER_ACCOUNT_ID } from '../constants';
import { AccountDao } from '../data/account-dao';
import { LedgerDao } from '../data/ledger-dao';

const logger = LoggerFactory.getLogger('LedgerService');

/** One fill to apply, with the resulting position left to the ledger to work out. */
export interface ApplyFillRequest {
  /** The broker order the fill belongs to. Several fills may share one. */
  readonly referenceId: string;
  readonly accountId: string;
  readonly symbol: string;
  /** Negative means sell. */
  readonly transactionSize: number;
  readonly transactionUnitCost: number;
  readonly timestamp: number;
}

export interface ApplyFillResponse {
  readonly transaction: Transaction;
}

/**
 * A broker's cumulative fill report. The ledger works out how much of it is new, so
 * delivering the same report twice changes nothing.
 */
export interface ApplyCumulativeFillRequest {
  readonly referenceId: string;
  readonly accountId: string;
  readonly symbol: string;
  readonly cumulativeFilledSize: number;
  readonly cumulativeFilledAvgPrice: number;
  readonly timestamp: number;
}

export interface ApplyCumulativeFillResponse {
  /** Null when the report added nothing. */
  readonly transaction: Transaction | null;
}

/**
 * Declared field by field rather than aliased to the DAO's input type: a service
 * contract and a DAO input happen to coincide here, and tying them together would make
 * a column rename a breaking change for every caller.
 */
export interface AppendTransactionRequest {
  readonly referenceId: string;
  readonly accountId: string;
  readonly symbol: string;
  readonly transactionSize: number;
  readonly transactionUnitCost: number;
  readonly transactionProfit?: number;
  readonly positionSize: number;
  readonly positionUnitCost: number;
  readonly timestamp: number;
}

export interface AppendTransactionResponse {
  readonly transaction: Transaction;
}

/**
 * Positions, realised profit and the transaction log.
 *
 * Everything that writes goes through here, including the injector and the
 * corporate-action job, which hold this object directly rather than reaching the
 * service over HTTP.
 */
export class LedgerService {
  constructor(
    private readonly ledgerDao: LedgerDao,
    private readonly accountDao: AccountDao,
  ) {}

  async listPositions(request: ListPositionsRequest): Promise<ListPositionsResponse> {
    await this.requireAccount(request.accountId);
    return await this.ledgerDao.listPositions({ accountId: request.accountId, includeClosed: request.includeClosed ?? false });
  }

  async getPosition(request: GetPositionRequest): Promise<GetPositionResponse> {
    await this.requireAccount(request.accountId);
    const { position } = await this.ledgerDao.getPosition({ accountId: request.accountId, symbol: request.symbol });
    if (position === null) {
      throw new NotFoundError(`Account ${request.accountId} has never held ${request.symbol}.`);
    }
    return { position };
  }

  async listHistoricalPositions(request: ListHistoricalPositionsRequest): Promise<ListHistoricalPositionsResponse> {
    await this.requireAccount(request.accountId);
    return await this.ledgerDao.listHistoricalPositions(request);
  }

  async listProfits(request: ListProfitsRequest): Promise<ListProfitsResponse> {
    await this.requireAccount(request.accountId);
    return await this.ledgerDao.listProfits({ accountId: request.accountId });
  }

  async getProfit(request: GetProfitRequest): Promise<GetProfitResponse> {
    await this.requireAccount(request.accountId);
    const { profit } = await this.ledgerDao.getProfit({ accountId: request.accountId, symbol: request.symbol });
    if (profit === null) {
      throw new NotFoundError(`Account ${request.accountId} has not realised any profit on ${request.symbol}. A profit is recorded the first time a position in it is reduced.`);
    }
    return { profit };
  }

  async listTransactions(request: ListTransactionsRequest): Promise<ListTransactionsResponse> {
    await this.requireAccount(request.accountId);
    return await this.ledgerDao.listTransactions(request);
  }

  async listTransactionsByReferenceId(request: ListTransactionsByReferenceIdRequest): Promise<ListTransactionsByReferenceIdResponse> {
    return await this.ledgerDao.listTransactionsByReferenceId(request);
  }

  /**
   * A split changes the share count and the cost basis but not the value of the
   * holding, so no transaction is written and no profit is realised.
   *
   * Not idempotent: running it twice splits twice. The corporate-action job leaves
   * splits alone for exactly this reason, and they are applied deliberately.
   */
  async stockSplit(request: StockSplitRequest): Promise<StockSplitResponse> {
    if (!(request.ratio > 0)) {
      throw new InvalidRequestError(`Split ratio must be greater than zero, got ${request.ratio}.`);
    }
    await this.requireAccount(request.accountId);
    logger.info(`Applying a ${request.ratio}-for-1 split to ${request.symbol} in account ${request.accountId}.`);
    const { position } = await this.ledgerDao.applyStockSplit(request);
    if (position === null) {
      logger.info(`Account ${request.accountId} has never held ${request.symbol}; nothing to split.`);
    }
    return {};
  }

  /** Applies one fill, reading the position it lands on under lock. */
  async applyFill(request: ApplyFillRequest): Promise<ApplyFillResponse> {
    await this.requireAccount(request.accountId);
    const { transaction } = await this.ledgerDao.applyFill(request);
    logger.info(
      `Applied ${request.transactionSize} ${request.symbol} at ${request.transactionUnitCost} to account ${request.accountId}: position now ${transaction.cumulativeSize} at ${transaction.cumulativeAvgPrice}, realised ${transaction.profit ?? 'nothing'}.`,
    );
    return { transaction };
  }

  /**
   * Applies a broker's cumulative fill report, recording only what is new.
   *
   * This is the injector's write path. It is idempotent by construction, which is what
   * lets the websocket and the REST backfill both report a fill without the position
   * moving twice.
   */
  async applyCumulativeFill(request: ApplyCumulativeFillRequest): Promise<ApplyCumulativeFillResponse> {
    await this.requireAccount(request.accountId);
    const { transaction } = await this.ledgerDao.applyCumulativeFill(request);
    if (transaction === null) {
      logger.debug(`Fill report for broker order ${request.referenceId} added nothing; already recorded in full.`);
      return { transaction: null };
    }
    logger.info(
      `Recorded ${transaction.size} ${request.symbol} at ${transaction.avgPrice} from broker order ${request.referenceId} in account ${request.accountId}: position now ${transaction.cumulativeSize} at ${transaction.cumulativeAvgPrice}, realised ${transaction.profit ?? 'nothing'}.`,
    );
    return { transaction };
  }

  /**
   * Appends a fill whose resulting position the caller has already computed. Use
   * `applyFill` unless you are rebuilding history and know nothing else is writing.
   */
  async appendTransaction(request: AppendTransactionRequest): Promise<AppendTransactionResponse> {
    await this.requireAccount(request.accountId);
    const { transaction } = await this.ledgerDao.appendTransaction(request);
    return { transaction };
  }

  /**
   * Moves shares between two virtual accounts, booking both sides as a matched pair
   * of synthetic orders so each account's cost basis and realised profit move exactly
   * as they would for a real fill.
   */
  async transferPosition(request: TransferPositionRequest): Promise<TransferPositionResponse> {
    this.assertTransferable(request);

    const [origin, destination] = await Promise.all([this.requireAccount(request.originAccountId), this.requireAccount(request.destinationAccountId)]);

    // Real money and paper money must not mix: a transfer is the one operation that
    // could move a position from a simulated account into a live one, and the totals
    // on both sides would then be fiction.
    if (origin.accountType !== destination.accountType) {
      throw new InvalidRequestError(
        `Cannot transfer between a ${origin.accountType} account and a ${destination.accountType} account. Both sides of a transfer must be the same account type.`,
      );
    }

    const timestamp = request.timestamp ?? Date.now();
    const occurredAt = new Date(timestamp).toISOString();
    const originOrderId = crypto.randomUUID();
    const destinationOrderId = crypto.randomUUID();

    const record = (accountId: string, counterpartAccountId: string, orderId: string, signedShares: number): TransferOrderRecord => ({
      id: orderId,
      accountId,
      counterpartAccountId,
      status: 'filled',
      symbol: request.symbol,
      size: signedShares,
      filledSize: signedShares,
      filledAvgPrice: request.unitCost,
      createdAt: occurredAt,
      filledAt: occurredAt,
    });

    logger.info(
      `Transferring ${request.shares} ${request.symbol} from account ${request.originAccountId} to ${request.destinationAccountId} at ${request.unitCost}, dated ${occurredAt}.`,
    );

    await this.ledgerDao.transferPosition({
      symbol: request.symbol,
      unitCost: request.unitCost,
      shares: request.shares,
      timestamp,
      brokerAccountId: TRANSFER_BROKER_ACCOUNT_ID,
      origin: {
        accountId: request.originAccountId,
        groupId: request.originGroupId,
        orderId: originOrderId,
        record: record(request.originAccountId, request.destinationAccountId, originOrderId, -1 * request.shares),
      },
      destination: {
        accountId: request.destinationAccountId,
        groupId: request.destinationGroupId,
        orderId: destinationOrderId,
        record: record(request.destinationAccountId, request.originAccountId, destinationOrderId, request.shares),
      },
    });

    return {};
  }

  private assertTransferable(request: TransferPositionRequest): void {
    if (request.originAccountId === request.destinationAccountId) {
      throw new InvalidRequestError('A transfer needs two different accounts; origin and destination are the same.');
    }
    if (request.originGroupId === request.destinationGroupId) {
      throw new InvalidRequestError('A transfer needs a different order group on each side; origin and destination are the same.');
    }
    if (!Number.isInteger(request.shares) || request.shares <= 0) {
      throw new InvalidRequestError(`Shares must be a whole number greater than zero, got ${request.shares}. To transfer the other way, swap origin and destination.`);
    }
    if (!(request.unitCost > 0)) {
      throw new InvalidRequestError(`Unit cost must be greater than zero, got ${request.unitCost}.`);
    }
  }

  private async requireAccount(accountId: string): Promise<Account> {
    const { account } = await this.accountDao.getAccount({ accountId });
    if (account === null) {
      throw new NotFoundError(`Account ${accountId} does not exist. List accounts to see which ids are in use.`);
    }
    return account;
  }
}
