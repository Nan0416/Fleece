import { Decimal } from '@fleece/utilities';
import { Position, Profit, Transaction } from '@fleece/models';
import {
  ApplyCumulativeFillInput,
  ApplyCumulativeFillOutput,
  ApplyFillInput,
  ApplyFillOutput,
  ApplyStockSplitInput,
  ApplyStockSplitOutput,
  AppendTransactionInput,
  AppendTransactionOutput,
  FillProgressDiscrepancy,
  GetOrderFillProgressInput,
  GetOrderFillProgressOutput,
  GetPositionInput,
  GetPositionOutput,
  GetProfitInput,
  GetProfitOutput,
  LedgerDao,
  ListHistoricalPositionsInput,
  ListHistoricalPositionsOutput,
  ListPositionsInput,
  ListPositionsOutput,
  ListProfitsInput,
  ListProfitsOutput,
  ListTransactionsByReferenceIdInput,
  ListTransactionsByReferenceIdOutput,
  ListTransactionsInput,
  ListTransactionsOutput,
  ReconcileOrderFillProgressInput,
  ReconcileOrderFillProgressOutput,
  TransferPositionInput,
  TransferPositionOutput,
} from '../../../src/core/data/ledger-dao';

const d = (value: string): Decimal => Decimal.of(value);

export function aTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    referenceId: 'order-1',
    accountId: 'MOMENTUM01',
    symbol: 'AAPL',
    assetClass: 'equity',
    timestamp: 1_700_000_000_000,
    size: d('10'),
    totalCost: d('1000'),
    multiplier: Decimal.ONE,
    avgPrice: d('100'),
    premium: d('100'),
    profit: undefined,
    roi: undefined,
    cumulativeSize: d('10'),
    cumulativeTotalCost: d('1000'),
    cumulativeProfit: Decimal.ZERO,
    cumulativeAvgPrice: d('100'),
    ...overrides,
  };
}

export function aPosition(overrides: Partial<Position> = {}): Position {
  return {
    accountId: 'MOMENTUM01',
    symbol: 'AAPL',
    assetClass: 'equity',
    size: d('10'),
    totalCost: d('1000'),
    multiplier: Decimal.ONE,
    avgPrice: d('100'),
    premium: d('100'),
    createdAt: 1,
    lastUpdatedAt: 1,
    ...overrides,
  };
}

/**
 * Records what it was asked for and answers what it is told to.
 *
 * The service's own job is the part above the SQL — refusing a request that cannot be
 * right, and refusing one for an account that does not exist before anything is
 * written — so what these tests need from a DAO is a record of whether it was reached
 * and with what.
 */
export class FakeLedgerDao implements LedgerDao {
  readonly calls: Array<{ readonly method: string; readonly input: unknown }> = [];

  position: Position | null = null;
  profit: Profit | null = null;
  positions: ReadonlyArray<Position> = [];
  transaction: Transaction = aTransaction();
  /** `applyCumulativeFill` answers null when a report added nothing already recorded. */
  cumulativeTransaction: Transaction | null = aTransaction();
  discrepancies: ReadonlyArray<FillProgressDiscrepancy> = [];

  private record<T>(method: string, input: unknown, output: T): T {
    this.calls.push({ method, input });
    return output;
  }

  inputFor(method: string): unknown {
    return this.calls.find((call) => call.method === method)?.input;
  }

  called(method: string): boolean {
    return this.calls.some((call) => call.method === method);
  }

  async getPosition(input: GetPositionInput): Promise<GetPositionOutput> {
    return this.record('getPosition', input, { position: this.position });
  }

  async listPositions(input: ListPositionsInput): Promise<ListPositionsOutput> {
    return this.record('listPositions', input, { positions: this.positions });
  }

  async listHistoricalPositions(input: ListHistoricalPositionsInput): Promise<ListHistoricalPositionsOutput> {
    return this.record('listHistoricalPositions', input, { positions: [] });
  }

  async getProfit(input: GetProfitInput): Promise<GetProfitOutput> {
    return this.record('getProfit', input, { profit: this.profit });
  }

  async listProfits(input: ListProfitsInput): Promise<ListProfitsOutput> {
    return this.record('listProfits', input, { profits: [] });
  }

  async listTransactions(input: ListTransactionsInput): Promise<ListTransactionsOutput> {
    return this.record('listTransactions', input, { transactions: [] });
  }

  async listTransactionsByReferenceId(input: ListTransactionsByReferenceIdInput): Promise<ListTransactionsByReferenceIdOutput> {
    return this.record('listTransactionsByReferenceId', input, { transactions: [] });
  }

  async applyFill(input: ApplyFillInput): Promise<ApplyFillOutput> {
    return this.record('applyFill', input, { position: aPosition(), transaction: this.transaction });
  }

  async applyCumulativeFill(input: ApplyCumulativeFillInput): Promise<ApplyCumulativeFillOutput> {
    return this.record('applyCumulativeFill', input, { position: aPosition(), transaction: this.cumulativeTransaction });
  }

  async appendTransaction(input: AppendTransactionInput): Promise<AppendTransactionOutput> {
    return this.record('appendTransaction', input, { position: aPosition(), transaction: this.transaction });
  }

  async applyStockSplit(input: ApplyStockSplitInput): Promise<ApplyStockSplitOutput> {
    return this.record('applyStockSplit', input, { position: this.position });
  }

  async transferPosition(input: TransferPositionInput): Promise<TransferPositionOutput> {
    return this.record('transferPosition', input, { originTransaction: aTransaction(), destinationTransaction: aTransaction() });
  }

  async getOrderFillProgress(input: GetOrderFillProgressInput): Promise<GetOrderFillProgressOutput> {
    return this.record('getOrderFillProgress', input, { progress: [] });
  }

  async reconcileOrderFillProgress(input: ReconcileOrderFillProgressInput): Promise<ReconcileOrderFillProgressOutput> {
    return this.record('reconcileOrderFillProgress', input, { checked: 1, discrepancies: this.discrepancies });
  }
}
