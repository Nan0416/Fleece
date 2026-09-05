import { AssetClass, BrokerOrderRecord, Decimal, HistoricalPosition, OrderFillProgress, Position, Profit, SortDirection, Transaction } from '@fleece/shared';

/**
 * Position, profit, the transaction log and each order's fill progress are one DAO
 * rather than four.
 *
 * They are not merely related — they are written together or not at all. Applying a
 * fill updates the position, adds the realised profit to the running total, appends the
 * transaction that records both, and advances the progress counter that makes the next
 * report idempotent; a crash between any two of those leaves a ledger that does not add
 * up. Guideline 16 puts multi-statement writes in a transaction, and a transaction
 * cannot span DAOs without handing transaction control to the caller, which is how it
 * ends up forgotten.
 *
 * **Everything here is in ledger units.** Sizes count the instrument's own units —
 * contracts for an option — and costs are dollars. Turning a broker's quoted premium
 * into dollars is the caller's job, because the caller is what knows the contract
 * multiplier; by the time a number reaches this interface the conversion has happened
 * and `multiplier` travels alongside only so the row can record what was used.
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
  readonly assetClass?: AssetClass;
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
  readonly assetClass?: AssetClass;
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
  readonly assetClass: AssetClass;
  /** Units of the underlying per unit of `transactionSize`; 1 for anything but an option. */
  readonly multiplier: Decimal;
  /** Negative means sell. Counts contracts for an option. */
  readonly transactionSize: Decimal;
  /** Dollars this fill moved, signed the same way as `transactionSize`. */
  readonly transactionTotalCost: Decimal;
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
  readonly assetClass: AssetClass;
  readonly multiplier: Decimal;
  readonly transactionSize: Decimal;
  readonly transactionTotalCost: Decimal;
  readonly transactionProfit?: Decimal;
  readonly positionSize: Decimal;
  readonly positionTotalCost: Decimal;
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
 * what it cost. Turning those into transactions means subtracting what has already been
 * recorded, and where that subtraction happens decides whether the ledger can be
 * trusted.
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
 * Here the already-applied amount is read from `order_fill_progress` inside the same
 * transaction, under the position lock, and advanced in that same transaction. That
 * makes applying a fill idempotent, restart-safe and safe against a duplicate arriving
 * concurrently.
 *
 * Both figures are in ledger units and neither is a price, so this path performs no
 * division at all.
 */
export interface ApplyCumulativeFillInput {
  readonly referenceId: string;
  readonly accountId: string;
  readonly symbol: string;
  readonly assetClass: AssetClass;
  readonly multiplier: Decimal;
  /** Signed total filled so far, as the broker reports it. Negative for a sell. */
  readonly cumulativeFilledSize: Decimal;
  /** Signed dollars that whole cumulative fill has moved. */
  readonly cumulativeFilledTotalCost: Decimal;
  readonly timestamp: number;
}

export interface ApplyCumulativeFillOutput {
  /** Null when the report added nothing — a duplicate, or a replay of known history. */
  readonly transaction: Transaction | null;
}

export interface GetOrderFillProgressInput {
  readonly referenceId: string;
}

export interface GetOrderFillProgressOutput {
  readonly progress: ReadonlyArray<OrderFillProgress>;
}

/**
 * Re-derives every order's applied totals from the transactions themselves and reports
 * where the stored counter disagrees.
 *
 * This is the guarantee that came free while the totals were summed on every read, and
 * that has to be asked for now that they are stored. It is not on any hot path: it
 * exists so that "the counter and the log agree" is a question with an answer rather
 * than an assumption.
 */
export interface ReconcileOrderFillProgressInput {
  /** Limit the check to one order. Omit to check every order for the account. */
  readonly referenceId?: string;
  readonly accountId?: string;
}

export interface FillProgressDiscrepancy {
  readonly referenceId: string;
  readonly accountId: string;
  readonly symbol: string;
  readonly storedSize: Decimal;
  readonly summedSize: Decimal;
  readonly storedTotalCost: Decimal;
  readonly summedTotalCost: Decimal;
}

export interface ReconcileOrderFillProgressOutput {
  readonly checked: number;
  readonly discrepancies: ReadonlyArray<FillProgressDiscrepancy>;
}

/**
 * A split changes how many units a position is counted in. It does not change what was
 * paid for it, so `total_cost` is left exactly as it is and the unit cost falls out of
 * the new size.
 *
 * That is the whole operation: one multiplication, no division, and no possibility of
 * the size and the price disagreeing about the ratio. The previous form rounded the
 * size and divided the price, two roundings that were not constrained to agree.
 */
export interface ApplyStockSplitInput {
  readonly accountId: string;
  readonly symbol: string;
  /** 2 means one share becomes two. */
  readonly ratio: Decimal;
}

export interface ApplyStockSplitOutput {
  /** Null when the account has never held the symbol, which is not an error. */
  readonly position: Position | null;
}

/**
 * Moving units between two virtual accounts: both sides, in one transaction.
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
  readonly assetClass: AssetClass;
  readonly multiplier: Decimal;
  /** Always positive; the direction comes from which side is which. */
  readonly size: Decimal;
  /** Dollars moved, always positive. Signed per side by the DAO. */
  readonly totalCost: Decimal;
  readonly timestamp: number;
  readonly brokerAccountId: string;
  readonly origin: TransferSide;
  readonly destination: TransferSide;
}

export interface TransferSide {
  readonly accountId: string;
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

  getOrderFillProgress(input: GetOrderFillProgressInput): Promise<GetOrderFillProgressOutput>;
  /** Off the hot path: re-derives the counters from the transaction log and reports disagreements. */
  reconcileOrderFillProgress(input: ReconcileOrderFillProgressInput): Promise<ReconcileOrderFillProgressOutput>;
}
