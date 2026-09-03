import { HistoricalPosition, InternalServiceError, Position, Profit, reconcilePosition, roundPrice, Transaction } from '@fleece/shared';
import { Pool, PoolClient } from 'pg';
import {
  AppendTransactionInput,
  AppendTransactionOutput,
  ApplyCumulativeFillInput,
  ApplyCumulativeFillOutput,
  ApplyFillInput,
  ApplyFillOutput,
  ApplyStockSplitInput,
  ApplyStockSplitOutput,
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
  TransferPositionInput,
  TransferPositionOutput,
  TransferSide,
} from './ledger-dao';

interface PositionRow {
  readonly account_id: string;
  readonly symbol: string;
  readonly size: number;
  readonly avg_price: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface ProfitRow {
  readonly account_id: string;
  readonly symbol: string;
  readonly profit: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface TransactionRow {
  readonly reference_id: string;
  readonly account_id: string;
  readonly symbol: string;
  readonly occurred_at: Date;
  readonly avg_price: number;
  readonly size: number;
  readonly profit: number | null;
  readonly roi: number | null;
  readonly cumulative_size: number;
  readonly cumulative_profit: number;
  readonly cumulative_avg_price: number | null;
}

function toPosition(row: PositionRow): Position {
  return {
    accountId: row.account_id,
    symbol: row.symbol,
    size: row.size,
    avgPrice: row.avg_price,
    createdAt: row.created_at.getTime(),
    lastUpdatedAt: row.updated_at.getTime(),
  };
}

function toProfit(row: ProfitRow): Profit {
  return {
    accountId: row.account_id,
    symbol: row.symbol,
    profit: row.profit,
    createdAt: row.created_at.getTime(),
    lastUpdatedAt: row.updated_at.getTime(),
  };
}

function toTransaction(row: TransactionRow): Transaction {
  return {
    referenceId: row.reference_id,
    accountId: row.account_id,
    symbol: row.symbol,
    timestamp: row.occurred_at.getTime(),
    avgPrice: row.avg_price,
    size: row.size,
    profit: row.profit === null ? undefined : row.profit,
    roi: row.roi === null ? undefined : row.roi,
    cumulativeSize: row.cumulative_size,
    cumulativeProfit: row.cumulative_profit,
    cumulativeAvgPrice: row.cumulative_avg_price === null ? undefined : row.cumulative_avg_price,
  };
}

function toHistoricalPosition(row: Pick<TransactionRow, 'account_id' | 'symbol' | 'cumulative_size' | 'occurred_at'>): HistoricalPosition {
  return {
    accountId: row.account_id,
    symbol: row.symbol,
    size: row.cumulative_size,
    updatedAt: row.occurred_at.getTime(),
  };
}

const POSITION_COLUMNS = 'account_id, symbol, size, avg_price, created_at, updated_at';
const PROFIT_COLUMNS = 'account_id, symbol, profit, created_at, updated_at';
const TRANSACTION_COLUMNS = 'reference_id, account_id, symbol, occurred_at, avg_price, size, profit, roi, cumulative_size, cumulative_profit, cumulative_avg_price';

/**
 * Return on a single trade, in basis points.
 *
 * Undefined when the trade realised nothing, and also when the notional is zero — a
 * zero-size fill should never reach here, but dividing by it would store a NaN that
 * every later read has to cope with.
 */
function computeRoi(transactionProfit: number | undefined, transactionUnitCost: number, transactionSize: number): number | undefined {
  if (typeof transactionProfit !== 'number') {
    return undefined;
  }
  const notional = Math.abs(transactionUnitCost * transactionSize);
  if (notional === 0) {
    return undefined;
  }
  return Math.round(((10000 * transactionProfit) / notional) * 100) / 100;
}

export class PgLedgerDao implements LedgerDao {
  constructor(private readonly pool: Pool) {}

  async getPosition(input: GetPositionInput): Promise<GetPositionOutput> {
    const result = await this.pool.query<PositionRow>(`SELECT ${POSITION_COLUMNS} FROM position WHERE account_id = $1 AND symbol = $2`, [input.accountId, input.symbol]);
    const row = result.rows[0];
    return { position: row === undefined ? null : toPosition(row) };
  }

  async listPositions(input: ListPositionsInput): Promise<ListPositionsOutput> {
    const sql = input.includeClosed
      ? `SELECT ${POSITION_COLUMNS} FROM position WHERE account_id = $1 ORDER BY symbol`
      : `SELECT ${POSITION_COLUMNS} FROM position WHERE account_id = $1 AND size <> 0 ORDER BY symbol`;
    const result = await this.pool.query<PositionRow>(sql, [input.accountId]);
    return { positions: result.rows.map(toPosition) };
  }

  /**
   * Projected from the transaction log rather than read from a history table: every
   * transaction stores the position size it left behind, so the history already
   * exists and a second table could only disagree with it.
   */
  async listHistoricalPositions(input: ListHistoricalPositionsInput): Promise<ListHistoricalPositionsOutput> {
    const ascending = input.sort === 'asc';
    const result = await this.pool.query<TransactionRow>(
      `SELECT account_id, symbol, cumulative_size, occurred_at
         FROM ledger_transaction
        WHERE account_id = $1 AND symbol = $2 AND occurred_at ${ascending ? '>=' : '<='} to_timestamp($3 / 1000.0)
        ORDER BY occurred_at ${ascending ? 'ASC' : 'DESC'}, transaction_id ${ascending ? 'ASC' : 'DESC'}
        LIMIT $4`,
      [input.accountId, input.symbol, input.from, input.limit],
    );
    return { positions: result.rows.map(toHistoricalPosition) };
  }

  async getProfit(input: GetProfitInput): Promise<GetProfitOutput> {
    const result = await this.pool.query<ProfitRow>(`SELECT ${PROFIT_COLUMNS} FROM profit WHERE account_id = $1 AND symbol = $2`, [input.accountId, input.symbol]);
    const row = result.rows[0];
    return { profit: row === undefined ? null : toProfit(row) };
  }

  async listProfits(input: ListProfitsInput): Promise<ListProfitsOutput> {
    const result = await this.pool.query<ProfitRow>(`SELECT ${PROFIT_COLUMNS} FROM profit WHERE account_id = $1 ORDER BY symbol`, [input.accountId]);
    return { profits: result.rows.map(toProfit) };
  }

  async listTransactions(input: ListTransactionsInput): Promise<ListTransactionsOutput> {
    const ascending = input.sort === 'asc';
    const comparison = ascending ? '>=' : '<=';
    const direction = ascending ? 'ASC' : 'DESC';
    const parameters: unknown[] = [input.accountId, input.from, input.limit];
    let symbolClause = '';
    if (input.symbol !== undefined) {
      parameters.push(input.symbol);
      symbolClause = ` AND symbol = $${parameters.length}`;
    }
    const result = await this.pool.query<TransactionRow>(
      `SELECT ${TRANSACTION_COLUMNS}
         FROM ledger_transaction
        WHERE account_id = $1 AND occurred_at ${comparison} to_timestamp($2 / 1000.0)${symbolClause}
        ORDER BY occurred_at ${direction}, transaction_id ${direction}
        LIMIT $3`,
      parameters,
    );
    return { transactions: result.rows.map(toTransaction) };
  }

  async listTransactionsByReferenceId(input: ListTransactionsByReferenceIdInput): Promise<ListTransactionsByReferenceIdOutput> {
    const result = await this.pool.query<TransactionRow>(`SELECT ${TRANSACTION_COLUMNS} FROM ledger_transaction WHERE reference_id = $1 ORDER BY occurred_at, transaction_id`, [
      input.referenceId,
    ]);
    return { transactions: result.rows.map(toTransaction) };
  }

  async applyFill(input: ApplyFillInput): Promise<ApplyFillOutput> {
    return await this.inTransaction(async (client) => {
      const current = await this.lockPosition(client, input.accountId, input.symbol);

      const reconciled = reconcilePosition({
        positionSize: current.size,
        positionUnitCost: current.avg_price,
        transactionSize: input.transactionSize,
        transactionUnitCost: input.transactionUnitCost,
      });

      return await this.writeFill(client, {
        referenceId: input.referenceId,
        accountId: input.accountId,
        symbol: input.symbol,
        transactionSize: input.transactionSize,
        transactionUnitCost: input.transactionUnitCost,
        transactionProfit: reconciled.transactionProfit,
        positionSize: reconciled.positionSize,
        positionUnitCost: reconciled.positionUnitCost,
        timestamp: input.timestamp,
      });
    });
  }

  async applyCumulativeFill(input: ApplyCumulativeFillInput): Promise<ApplyCumulativeFillOutput> {
    return await this.inTransaction(async (client) => {
      const current = await this.lockPosition(client, input.accountId, input.symbol);

      // Read under the position lock, so a duplicate arriving at the same moment
      // waits and then sees this one's transaction rather than racing past it.
      const applied = await client.query<{ size: number; total_cost: number }>(
        `SELECT COALESCE(SUM(size), 0) AS size, COALESCE(SUM(size * avg_price), 0) AS total_cost
           FROM ledger_transaction
          WHERE reference_id = $1 AND account_id = $2 AND symbol = $3`,
        [input.referenceId, input.accountId, input.symbol],
      );
      const appliedSize = applied.rows[0].size;
      const appliedTotalCost = applied.rows[0].total_cost;

      const totalCost = input.cumulativeFilledSize * input.cumulativeFilledAvgPrice;
      const deltaSize = input.cumulativeFilledSize - appliedSize;
      const deltaTotalCost = totalCost - appliedTotalCost;

      if (deltaSize === 0) {
        // Nothing new. The common cause is the websocket and the REST backfill both
        // reporting the same fill, which is expected rather than exceptional.
        return { transaction: null };
      }

      const deltaUnitCost = roundPrice(deltaTotalCost / deltaSize, 4);

      const reconciled = reconcilePosition({
        positionSize: current.size,
        positionUnitCost: current.avg_price,
        transactionSize: deltaSize,
        transactionUnitCost: deltaUnitCost,
      });

      const { transaction } = await this.writeFill(client, {
        referenceId: input.referenceId,
        accountId: input.accountId,
        symbol: input.symbol,
        transactionSize: deltaSize,
        transactionUnitCost: deltaUnitCost,
        transactionProfit: reconciled.transactionProfit,
        positionSize: reconciled.positionSize,
        positionUnitCost: reconciled.positionUnitCost,
        timestamp: input.timestamp,
      });
      return { transaction };
    });
  }

  async appendTransaction(input: AppendTransactionInput): Promise<AppendTransactionOutput> {
    return await this.inTransaction(async (client) => {
      await this.lockPosition(client, input.accountId, input.symbol);
      return await this.writeFill(client, input);
    });
  }

  async applyStockSplit(input: ApplyStockSplitInput): Promise<ApplyStockSplitOutput> {
    return await this.inTransaction(async (client) => {
      const existing = await client.query<PositionRow>(`SELECT ${POSITION_COLUMNS} FROM position WHERE account_id = $1 AND symbol = $2 FOR UPDATE`, [
        input.accountId,
        input.symbol,
      ]);
      const row = existing.rows[0];
      if (row === undefined) {
        return { position: null };
      }

      // Rounded in TypeScript rather than by Postgres `round()`: the two disagree on
      // negative halves — Math.round(-2.5) is -2, round(-2.5) is -3 — and a short
      // position landing on one is exactly where a silent divergence would hide.
      // Fractional shares are not supported, so the count is whole.
      const size = Math.round(row.size * input.ratio);
      const avgPrice = roundPrice(row.avg_price / input.ratio, 4);

      const updated = await client.query<PositionRow>(
        `UPDATE position SET size = $3, avg_price = $4, updated_at = now() WHERE account_id = $1 AND symbol = $2 RETURNING ${POSITION_COLUMNS}`,
        [input.accountId, input.symbol, size, avgPrice],
      );
      return { position: toPosition(updated.rows[0]) };
    });
  }

  async transferPosition(input: TransferPositionInput): Promise<TransferPositionOutput> {
    return await this.inTransaction(async (client) => {
      // Both positions are locked up front, and in a fixed order.
      //
      // The order is what prevents a deadlock: two transfers running at once in
      // opposite directions between the same pair of accounts would otherwise each
      // hold the lock the other is waiting for. Sorting by account id means every
      // transaction in the system takes these locks in the same sequence, so one waits
      // instead of both dying. Postgres would detect the cycle and abort a victim
      // rather than hang, but an aborted transfer is still a failed transfer.
      const [first, second] = input.origin.accountId < input.destination.accountId ? [input.origin, input.destination] : [input.destination, input.origin];
      const locked = new Map<string, PositionRow>();
      locked.set(first.accountId, await this.lockPosition(client, first.accountId, input.symbol));
      locked.set(second.accountId, await this.lockPosition(client, second.accountId, input.symbol));

      const applySide = async (side: TransferSide, signedShares: number): Promise<Transaction> => {
        await client.query(
          `INSERT INTO broker_order (broker_order_id, symbol, account_id, broker, broker_account_id, status, group_id)
           VALUES ($1, $2, $3, 'traderq', $4, 'filled', $5)`,
          [side.orderId, input.symbol, side.accountId, input.brokerAccountId, side.groupId],
        );
        await client.query('INSERT INTO broker_order_record (broker_order_id, record) VALUES ($1, $2)', [side.orderId, JSON.stringify(side.record)]);

        const current = locked.get(side.accountId);
        if (current === undefined) {
          throw new InternalServiceError(`The ${input.symbol} position for account ${side.accountId} was not locked before the transfer was applied.`);
        }

        const reconciled = reconcilePosition({
          positionSize: current.size,
          positionUnitCost: current.avg_price,
          transactionSize: signedShares,
          transactionUnitCost: input.unitCost,
        });

        const { transaction } = await this.writeFill(client, {
          referenceId: side.orderId,
          accountId: side.accountId,
          symbol: input.symbol,
          transactionSize: signedShares,
          transactionUnitCost: input.unitCost,
          transactionProfit: reconciled.transactionProfit,
          positionSize: reconciled.positionSize,
          positionUnitCost: reconciled.positionUnitCost,
          timestamp: input.timestamp,
        });
        return transaction;
      };

      const originTransaction = await applySide(input.origin, -1 * input.shares);
      const destinationTransaction = await applySide(input.destination, input.shares);
      return { originTransaction, destinationTransaction };
    });
  }

  /**
   * Takes the row lock that serialises every write to this account's holding in this
   * symbol, creating a flat position first if there is none.
   *
   * The insert is what makes it work for a symbol the account has never traded: there
   * is no row to lock, and `SELECT ... FOR UPDATE` locks nothing at all rather than
   * blocking, so two first fills would both read flat and one would be lost. The
   * conflicting update is a no-op that exists only to take the lock.
   *
   * Everything downstream — the profit total, the transaction's running figures —
   * is only ever written by a caller holding this lock, so nothing else needs one.
   */
  private async lockPosition(client: PoolClient, accountId: string, symbol: string): Promise<PositionRow> {
    const result = await client.query<PositionRow>(
      `INSERT INTO position (account_id, symbol, size, avg_price) VALUES ($1, $2, 0, 0)
       ON CONFLICT (account_id, symbol) DO UPDATE SET updated_at = position.updated_at
       RETURNING ${POSITION_COLUMNS}`,
      [accountId, symbol],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new InternalServiceError(`Locking the ${symbol} position for account ${accountId} returned no row.`);
    }
    return row;
  }

  /** Runs with the position row already locked by the caller. */
  private async writeFill(client: PoolClient, input: AppendTransactionInput): Promise<AppendTransactionOutput> {
    const positionResult = await client.query<PositionRow>(
      `UPDATE position SET size = $3, avg_price = $4, updated_at = now() WHERE account_id = $1 AND symbol = $2 RETURNING ${POSITION_COLUMNS}`,
      [input.accountId, input.symbol, input.positionSize, input.positionUnitCost],
    );

    // Read-modify-write rather than `SET profit = profit + $delta`, and safe because
    // the caller holds the position lock: nothing else writes this account's profit in
    // this symbol without taking it first. Summing in TypeScript also keeps the
    // arithmetic bit-for-bit what it was under Mongo, where `roundPrice` has always
    // decided the precision — Postgres `round(numeric)` breaks ties away from zero
    // where `roundPrice` breaks them upward.
    //
    // A profit row appears only once the symbol has realised something, which is why
    // `getProfit` legitimately returns nothing for an open position that has never
    // been reduced.
    const existing = await client.query<{ profit: number }>('SELECT profit FROM profit WHERE account_id = $1 AND symbol = $2', [input.accountId, input.symbol]);
    let cumulativeProfit = existing.rows[0] === undefined ? 0 : existing.rows[0].profit;
    if (typeof input.transactionProfit === 'number') {
      cumulativeProfit = roundPrice(cumulativeProfit + input.transactionProfit, 4);
      await client.query(
        `INSERT INTO profit (account_id, symbol, profit) VALUES ($1, $2, $3)
         ON CONFLICT (account_id, symbol) DO UPDATE SET profit = EXCLUDED.profit, updated_at = now()`,
        [input.accountId, input.symbol, cumulativeProfit],
      );
    }

    const transactionResult = await client.query<TransactionRow>(
      `INSERT INTO ledger_transaction
         (reference_id, account_id, symbol, occurred_at, avg_price, size, profit, roi, cumulative_size, cumulative_profit, cumulative_avg_price)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${TRANSACTION_COLUMNS}`,
      [
        input.referenceId,
        input.accountId,
        input.symbol,
        input.timestamp,
        input.transactionUnitCost,
        input.transactionSize,
        input.transactionProfit ?? null,
        computeRoi(input.transactionProfit, input.transactionUnitCost, input.transactionSize) ?? null,
        input.positionSize,
        cumulativeProfit,
        input.positionUnitCost,
      ],
    );

    return { position: toPosition(positionResult.rows[0]), transaction: toTransaction(transactionResult.rows[0]) };
  }

  private async inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
