import {
  Account,
  AssetClass,
  Decimal,
  defaultContractMultiplier,
  GetOrderFillProgressRequest,
  GetOrderFillProgressResponse,
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

/**
 * One fill to apply, with the resulting position left to the ledger to work out.
 *
 * **Sizes and costs are in ledger units**: a size counts the instrument's own units —
 * contracts for an option — and the cost is dollars. A caller holding a broker's quoted
 * premium multiplies it out before it gets here, because the caller is what knows the
 * contract multiplier. `multiplier` travels alongside so the row can record what was
 * used, not so anything here can apply it.
 */
export interface ApplyFillRequest {
  /** The broker order the fill belongs to. Several fills may share one. */
  readonly referenceId: string;
  readonly accountId: string;
  readonly symbol: string;
  readonly assetClass: AssetClass;
  readonly multiplier: Decimal;
  /** Negative means sell. */
  readonly transactionSize: Decimal;
  /** Dollars this fill moved, signed the same way as `transactionSize`. */
  readonly transactionTotalCost: Decimal;
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
  readonly assetClass: AssetClass;
  readonly multiplier: Decimal;
  readonly cumulativeFilledSize: Decimal;
  /** Dollars that whole cumulative fill has moved, signed the same way. */
  readonly cumulativeFilledTotalCost: Decimal;
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
  readonly assetClass: AssetClass;
  readonly multiplier: Decimal;
  readonly transactionSize: Decimal;
  readonly transactionTotalCost: Decimal;
  readonly transactionProfit?: Decimal;
  readonly positionSize: Decimal;
  readonly positionTotalCost: Decimal;
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
    return await this.ledgerDao.listPositions({ accountId: request.accountId, includeClosed: request.includeClosed ?? false, assetClass: request.assetClass });
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
   * What the ledger has booked against one broker order, and whether the stored counter
   * still agrees with the transactions it counts.
   *
   * The agreement used to be free: the applied total was summed from the log on every
   * fill, so the two could not disagree. Storing it made the write path cheaper and made
   * drift possible, so the check has to be asked for — and this is where it is asked.
   */
  async getOrderFillProgress(request: GetOrderFillProgressRequest): Promise<GetOrderFillProgressResponse> {
    const [{ progress }, { discrepancies }] = await Promise.all([
      this.ledgerDao.getOrderFillProgress({ referenceId: request.referenceId }),
      this.ledgerDao.reconcileOrderFillProgress({ referenceId: request.referenceId }),
    ]);
    if (discrepancies.length > 0) {
      for (const discrepancy of discrepancies) {
        logger.error(
          `Fill progress for broker order ${discrepancy.referenceId} in account ${discrepancy.accountId} says ${discrepancy.storedSize.toString()} ${discrepancy.symbol} at ${discrepancy.storedTotalCost.toString()}, but its transactions total ${discrepancy.summedSize.toString()} at ${discrepancy.summedTotalCost.toString()}. The transactions are the record; the counter is not.`,
        );
      }
    }
    return { progress, reconciled: discrepancies.length === 0 };
  }

  /**
   * A split changes how many units a position is counted in. It does not change what
   * was paid for it, so the stored total cost is left alone, no transaction is written
   * and no profit is realised.
   *
   * Not idempotent: running it twice splits twice. The corporate-action job leaves
   * splits alone for exactly this reason, and they are applied deliberately.
   */
  async stockSplit(request: StockSplitRequest): Promise<StockSplitResponse> {
    if (!request.ratio.isPositive()) {
      throw new InvalidRequestError(`Split ratio must be greater than zero, got ${request.ratio.toString()}.`);
    }
    await this.requireAccount(request.accountId);
    logger.info(`Applying a ${request.ratio.toString()}-for-1 split to ${request.symbol} in account ${request.accountId}.`);
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
      `Applied ${transaction.size.toString()} ${request.symbol} for ${transaction.totalCost.toString()} to account ${request.accountId}: position now ${transaction.cumulativeSize.toString()} at ${transaction.cumulativeAvgPrice.toString()}, realised ${transaction.profit?.toString() ?? 'nothing'}.`,
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
      `Recorded ${transaction.size.toString()} ${request.symbol} for ${transaction.totalCost.toString()} from broker order ${request.referenceId} in account ${request.accountId}: position now ${transaction.cumulativeSize.toString()} at ${transaction.cumulativeAvgPrice.toString()}, realised ${transaction.profit?.toString() ?? 'nothing'}.`,
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
   * Moves units between two virtual accounts, booking both sides as a matched pair of
   * synthetic orders so each account's cost basis and realised profit move exactly as
   * they would for a real fill.
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
    // `unitCost` is per unit of `size`, which for an option is per contract, so this is
    // already dollars and the multiplier does not enter it. It is recorded so the
    // premium behind the figure stays recoverable.
    const totalCost = request.size.mul(request.unitCost);
    const multiplier = defaultContractMultiplier(request.assetClass);

    const record = (accountId: string, counterpartAccountId: string, orderId: string, signedSize: Decimal): TransferOrderRecord => ({
      id: orderId,
      accountId,
      counterpartAccountId,
      status: 'filled',
      symbol: request.symbol,
      assetClass: request.assetClass,
      size: signedSize,
      filledSize: signedSize,
      filledTotalCost: signedSize.mul(request.unitCost),
      createdAt: occurredAt,
      filledAt: occurredAt,
    });

    logger.info(
      `Transferring ${request.size.toString()} ${request.symbol} from account ${request.originAccountId} to ${request.destinationAccountId} at ${request.unitCost.toString()}, dated ${occurredAt}.`,
    );

    await this.ledgerDao.transferPosition({
      symbol: request.symbol,
      assetClass: request.assetClass,
      multiplier,
      size: request.size,
      totalCost,
      timestamp,
      brokerAccountId: TRANSFER_BROKER_ACCOUNT_ID,
      origin: {
        accountId: request.originAccountId,
        orderId: originOrderId,
        record: record(request.originAccountId, request.destinationAccountId, originOrderId, request.size.neg()),
      },
      destination: {
        accountId: request.destinationAccountId,
        orderId: destinationOrderId,
        record: record(request.destinationAccountId, request.originAccountId, destinationOrderId, request.size),
      },
    });

    return {};
  }

  private assertTransferable(request: TransferPositionRequest): void {
    if (request.originAccountId === request.destinationAccountId) {
      throw new InvalidRequestError('A transfer needs two different accounts; origin and destination are the same.');
    }
    // Fractional sizes are allowed — fractional shares and crypto are both real — so the
    // only constraint is a positive magnitude. Direction comes from which side is which.
    if (!request.size.isPositive()) {
      throw new InvalidRequestError(`Size must be greater than zero, got ${request.size.toString()}. To transfer the other way, swap origin and destination.`);
    }
    if (!request.unitCost.isPositive()) {
      throw new InvalidRequestError(`Unit cost must be greater than zero, got ${request.unitCost.toString()}.`);
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
