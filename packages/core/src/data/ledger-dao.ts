import { BrokerOrderRecord, HistoricalPosition, Position, Profit, SortDirection, Transaction } from '@fleece/shared';

/**
 * Position, profit and the transaction log are one DAO rather than three.
 *
 * They are not merely related — they are written together or not at all. Applying a
 * fill updates the position, adds the realised profit to the running total, and
 * appends the transaction that records both; a crash between any two of those leaves
 * a ledger that does not add up. Guideline 16 puts multi-statement writes in a
 * transaction, and a transaction cannot span DAOs without handing transaction control
 * to the caller, which is how it ends up forgotten.
 */

export interface GetPositionInput {
  readonly accountId: string;
  readonly symbol: string;
}

export interface GetPositionOutput {
  readonly position: Position | null;
}

export interface ListPositionsInput {
  readonly accountId: string;
  readonly includeClosed: boolean;
}

export interface ListPositionsOutput {
  readonly positions: ReadonlyArray<Position>;
}

export interface ListHistoricalPositionsInput {
  readonly accountId: string;
  readonly symbol: string;
  readonly from: number;
  readonly limit: number;
  readonly sort: SortDirection;
}

export interface ListHistoricalPositionsOutput {
  readonly positions: ReadonlyArray<HistoricalPosition>;
}

export interface GetProfitInput {
  readonly accountId: string;
  readonly symbol: string;
}

export interface GetProfitOutput {
  readonly profit: Profit | null;
}

export interface ListProfitsInput {
  readonly accountId: string;
}

export interface ListProfitsOutput {
  readonly profits: ReadonlyArray<Profit>;
}

export interface ListTransactionsInput {
  readonly accountId: string;
  readonly symbol?: string;
  readonly from: number;
  readonly limit: number;
  readonly sort: SortDirection;
}

export interface ListTransactionsOutput {
  readonly transactions: ReadonlyArray<Transaction>;
}

export interface ListTransactionsByReferenceIdInput {
  readonly referenceId: string;
}

export interface ListTransactionsByReferenceIdOutput {
  readonly transactions: ReadonlyArray<Transaction>;
}

/**
 * One fill against one account, with the position it lands on read under lock rather
 * than supplied by the caller. This is the safe write path and the one the injector
 * and position transfers use.
 */
export interface ApplyFillInput {
  readonly referenceId: string;
  readonly accountId: string;
  readonly symbol: string;
  /** Negative means sell. */
  readonly transactionSize: number;
  readonly transactionUnitCost: number;
  readonly timestamp: number;
}

export interface ApplyFillOutput {
  readonly position: Position;
  readonly transaction: Transaction;
}

/**
 * A fill whose resulting position the caller has already computed.
 *
 * Unlike `applyFill` this cannot be safe against a concurrent writer, because the
 * position it writes was derived from a read that happened outside this transaction.
 * It exists for rebuilding history from a known-good sequence, where there is no
 * concurrent writer by construction. Prefer `applyFill` everywhere else.
 */
export interface AppendTransactionInput {
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

export interface AppendTransactionOutput {
  readonly position: Position;
  readonly transaction: Transaction;
}

/**
 * Applies a broker's *cumulative* fill report, working out for itself how much of it
 * is new.
 *
 * Brokers report progress, not deltas: each event carries the total filled so far and
 * the average price of that total. Turning those into transactions means subtracting
 * what has already been recorded, and where that subtraction happens decides whether
 * the ledger can be trusted.
 *
 * The legacy injector kept the running total in a `Map` in memory, which was wrong in
 * two ways that both silently double-count a fill:
 *
 * - The map entry is deleted when an order reaches a terminal status, so a `filled`
 *   event delivered twice — the websocket and the REST backfill both reporting it —
 *   is applied twice in full.
 * - The map does not survive a restart, so an injector restarted between two partial
 *   fills re-applies everything the order had filled before it went down.
 *
 * Here the already-applied amount is derived inside the same transaction from the
 * transactions themselves, under the position lock. That makes applying a fill
 * idempotent, restart-safe and safe against a duplicate arriving concurrently.
 */
export interface ApplyCumulativeFillInput {
  readonly referenceId: string;
  readonly accountId: string;
  readonly symbol: string;
  /** Signed total filled so far, as the broker reports it. Negative for a sell. */
  readonly cumulativeFilledSize: number;
  /** Average price of that whole cumulative fill. */
  readonly cumulativeFilledAvgPrice: number;
  readonly timestamp: number;
}

export interface ApplyCumulativeFillOutput {
  /** Null when the report added nothing — a duplicate, or a replay of known history. */
  readonly transaction: Transaction | null;
}

export interface ApplyStockSplitInput {
  readonly accountId: string;
  readonly symbol: string;
  /** 2 means one share becomes two. */
  readonly ratio: number;
}

export interface ApplyStockSplitOutput {
  /** Null when the account has never held the symbol, which is not an error. */
  readonly position: Position | null;
}

/**
 * Moving shares between two virtual accounts: both sides, in one transaction.
 *
 * This belongs here, alongside the fill path, rather than being orchestrated from a
 * service out of the pieces it is made of. A transfer that debits the origin and then
 * fails to credit the destination has destroyed shares — the two legs are not two
 * operations that usually both succeed, they are one operation. Composing it from
 * separate DAO calls means the atomicity depends on the caller remembering, and the
 * caller cannot open a transaction without being handed transaction control.
 *
 * The synthetic broker orders and their records are written here for the same reason:
 * they are part of what a transfer *is*.
 */
export interface TransferPositionInput {
  readonly symbol: string;
  readonly unitCost: number;
  /** Always positive; the direction comes from which side is which. */
  readonly shares: number;
  readonly timestamp: number;
  readonly brokerAccountId: string;
  readonly origin: TransferSide;
  readonly destination: TransferSide;
}

export interface TransferSide {
  readonly accountId: string;
  readonly groupId: string;
  /** Id for the synthetic order written on this side. */
  readonly orderId: string;
  readonly record: BrokerOrderRecord;
}

export interface TransferPositionOutput {
  readonly originTransaction: Transaction;
  readonly destinationTransaction: Transaction;
}

export interface LedgerDao {
  getPosition(input: GetPositionInput): Promise<GetPositionOutput>;
  listPositions(input: ListPositionsInput): Promise<ListPositionsOutput>;
  listHistoricalPositions(input: ListHistoricalPositionsInput): Promise<ListHistoricalPositionsOutput>;

  getProfit(input: GetProfitInput): Promise<GetProfitOutput>;
  listProfits(input: ListProfitsInput): Promise<ListProfitsOutput>;

  listTransactions(input: ListTransactionsInput): Promise<ListTransactionsOutput>;
  listTransactionsByReferenceId(input: ListTransactionsByReferenceIdInput): Promise<ListTransactionsByReferenceIdOutput>;

  applyFill(input: ApplyFillInput): Promise<ApplyFillOutput>;
  applyCumulativeFill(input: ApplyCumulativeFillInput): Promise<ApplyCumulativeFillOutput>;
  appendTransaction(input: AppendTransactionInput): Promise<AppendTransactionOutput>;
  applyStockSplit(input: ApplyStockSplitInput): Promise<ApplyStockSplitOutput>;
  transferPosition(input: TransferPositionInput): Promise<TransferPositionOutput>;
}
