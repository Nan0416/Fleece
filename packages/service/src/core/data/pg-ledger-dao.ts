import {
  AssetClass,
  Decimal,
  derivePremium,
  deriveRoi,
  deriveUnitCost,
  HistoricalPosition,
  InternalServiceError,
  OrderFillProgress,
  Position,
  Profit,
  reconcilePosition,
  Transaction,
} from '@fleece/shared';
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
  TransferSide,
} from './ledger-dao';
import { toAssetClass, toDecimal, toOptionalDecimal } from './row-parsers';

/**
 * Every NUMERIC column arrives as a **string**. node-postgres does that deliberately —
 * a JS number cannot hold every NUMERIC exactly — and it is the reason these columns
 * are NUMERIC in the first place. Typing the rows this way is what stops a `number`
 * creeping back in.
 */
interface PositionRow {
  readonly account_id: string;
  readonly symbol: string;
  readonly asset_class: string;
  readonly size: string;
  readonly total_cost: string;
  readonly multiplier: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface ProfitRow {
  readonly account_id: string;
  readonly symbol: string;
  readonly asset_class: string;
  readonly profit: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface TransactionRow {
  readonly reference_id: string;
  readonly account_id: string;
  readonly symbol: string;
  readonly asset_class: string;
  readonly occurred_at: Date;
  readonly size: string;
  readonly total_cost: string;
  readonly multiplier: string;
  readonly profit: string | null;
  readonly cumulative_size: string;
  readonly cumulative_total_cost: string;
  readonly cumulative_profit: string;
}

interface FillProgressRow {
  readonly reference_id: string;
  readonly account_id: string;
  readonly symbol: string;
  readonly applied_size: string;
  readonly applied_total_cost: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function toPosition(row: PositionRow): Position {
  const context = `Position ${row.account_id}/${row.symbol}`;
  const size = toDecimal(row.size, `${context} size`);
  const totalCost = toDecimal(row.total_cost, `${context} total_cost`);
  const multiplier = toDecimal(row.multiplier, `${context} multiplier`);
  return {
    accountId: row.account_id,
    symbol: row.symbol,
    assetClass: toAssetClass(row.asset_class, context),
    size,
    totalCost,
    multiplier,
    // Derived on the way out. The one place a unit price is divided, where a rounded
    // answer is shown and never fed back into the accounting.
    avgPrice: deriveUnitCost(totalCost, size),
    premium: derivePremium(totalCost, size, multiplier),
    createdAt: row.created_at.getTime(),
    lastUpdatedAt: row.updated_at.getTime(),
  };
}

function toProfit(row: ProfitRow): Profit {
  const context = `Profit ${row.account_id}/${row.symbol}`;
  return {
    accountId: row.account_id,
    symbol: row.symbol,
    assetClass: toAssetClass(row.asset_class, context),
    profit: toDecimal(row.profit, `${context} profit`),
    createdAt: row.created_at.getTime(),
    lastUpdatedAt: row.updated_at.getTime(),
  };
}

function toTransaction(row: TransactionRow): Transaction {
  const context = `Transaction ${row.reference_id} ${row.account_id}/${row.symbol}`;
  const size = toDecimal(row.size, `${context} size`);
  const totalCost = toDecimal(row.total_cost, `${context} total_cost`);
  const multiplier = toDecimal(row.multiplier, `${context} multiplier`);
  const profit = toOptionalDecimal(row.profit, `${context} profit`);
  const cumulativeSize = toDecimal(row.cumulative_size, `${context} cumulative_size`);
  const cumulativeTotalCost = toDecimal(row.cumulative_total_cost, `${context} cumulative_total_cost`);
  return {
    referenceId: row.reference_id,
    accountId: row.account_id,
    symbol: row.symbol,
    assetClass: toAssetClass(row.asset_class, context),
    timestamp: row.occurred_at.getTime(),
    size,
    totalCost,
    multiplier,
    avgPrice: deriveUnitCost(totalCost, size),
    premium: derivePremium(totalCost, size, multiplier),
    profit,
    roi: deriveRoi(profit, totalCost),
    cumulativeSize,
    cumulativeTotalCost,
    cumulativeProfit: toDecimal(row.cumulative_profit, `${context} cumulative_profit`),
    cumulativeAvgPrice: deriveUnitCost(cumulativeTotalCost, cumulativeSize),
  };
}

function toHistoricalPosition(row: Pick<TransactionRow, 'account_id' | 'symbol' | 'asset_class' | 'cumulative_size' | 'occurred_at'>): HistoricalPosition {
  const context = `Transaction ${row.account_id}/${row.symbol}`;
  return {
    accountId: row.account_id,
    symbol: row.symbol,
    assetClass: toAssetClass(row.asset_class, context),
    size: toDecimal(row.cumulative_size, `${context} cumulative_size`),
    updatedAt: row.occurred_at.getTime(),
  };
}

function toFillProgress(row: FillProgressRow): OrderFillProgress {
  const context = `Fill progress ${row.reference_id} ${row.account_id}/${row.symbol}`;
  return {
    referenceId: row.reference_id,
    accountId: row.account_id,
    symbol: row.symbol,
    appliedSize: toDecimal(row.applied_size, `${context} applied_size`),
    appliedTotalCost: toDecimal(row.applied_total_cost, `${context} applied_total_cost`),
    createdAt: row.created_at.getTime(),
    lastUpdatedAt: row.updated_at.getTime(),
  };
}

const POSITION_COLUMNS = 'account_id, symbol, asset_class, size, total_cost, multiplier, created_at, updated_at';
const PROFIT_COLUMNS = 'account_id, symbol, asset_class, profit, created_at, updated_at';
const TRANSACTION_COLUMNS =
  'reference_id, account_id, symbol, asset_class, occurred_at, size, total_cost, multiplier, profit, cumulative_size, cumulative_total_cost, cumulative_profit';
const FILL_PROGRESS_COLUMNS = 'reference_id, account_id, symbol, applied_size, applied_total_cost, created_at, updated_at';

export class PgLedgerDao implements LedgerDao {
  constructor(private readonly pool: Pool) {}

  async getPosition(input: GetPositionInput): Promise<GetPositionOutput> {
    const result = await this.pool.query<PositionRow>(`SELECT ${POSITION_COLUMNS} FROM position WHERE account_id = $1 AND symbol = $2`, [input.accountId, input.symbol]);
    const row = result.rows[0];
    return { position: row === undefined ? null : toPosition(row) };
  }

  async listPositions(input: ListPositionsInput): Promise<ListPositionsOutput> {
    const parameters: unknown[] = [input.accountId];
    const conditions: string[] = ['account_id = $1'];
    if (!input.includeClosed) {
      conditions.push('size <> 0');
    }
    if (input.assetClass !== undefined) {
      parameters.push(input.assetClass);
      conditions.push(`asset_class = $${parameters.length}`);
    }
    const result = await this.pool.query<PositionRow>(`SELECT ${POSITION_COLUMNS} FROM position WHERE ${conditions.join(' AND ')} ORDER BY symbol`, parameters);
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
      `SELECT account_id, symbol, asset_class, cumulative_size, occurred_at
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
    const parameters: unknown[] = [input.accountId];
    const conditions: string[] = ['account_id = $1'];
    if (input.assetClass !== undefined) {
      parameters.push(input.assetClass);
      conditions.push(`asset_class = $${parameters.length}`);
    }
    const result = await this.pool.query<ProfitRow>(`SELECT ${PROFIT_COLUMNS} FROM profit WHERE ${conditions.join(' AND ')} ORDER BY symbol`, parameters);
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
      const current = await this.lockPosition(client, input.accountId, input.symbol, input.assetClass, input.multiplier);

      const reconciled = reconcilePosition({
        positionSize: toDecimal(current.size, 'position size'),
        positionTotalCost: toDecimal(current.total_cost, 'position total_cost'),
        transactionSize: input.transactionSize,
        transactionTotalCost: input.transactionTotalCost,
      });

      return await this.writeFill(client, {
        ...input,
        transactionProfit: reconciled.transactionProfit,
        positionSize: reconciled.positionSize,
        positionTotalCost: reconciled.positionTotalCost,
      });
    });
  }

  async applyCumulativeFill(input: ApplyCumulativeFillInput): Promise<ApplyCumulativeFillOutput> {
    return await this.inTransaction(async (client) => {
      const current = await this.lockPosition(client, input.accountId, input.symbol, input.assetClass, input.multiplier);

      // Read under the position lock, so a duplicate arriving at the same moment waits
      // and then sees this one's advance rather than racing past it. The position lock
      // is a superset of what is needed — one broker order touches one account and one
      // symbol, so anything serialised on the position is serialised for the order.
      const applied = await client.query<Pick<FillProgressRow, 'applied_size' | 'applied_total_cost'>>(
        `SELECT applied_size, applied_total_cost FROM order_fill_progress WHERE reference_id = $1 AND account_id = $2 AND symbol = $3`,
        [input.referenceId, input.accountId, input.symbol],
      );
      const appliedRow = applied.rows[0];
      const appliedSize = appliedRow === undefined ? Decimal.ZERO : toDecimal(appliedRow.applied_size, 'applied_size');
      const appliedTotalCost = appliedRow === undefined ? Decimal.ZERO : toDecimal(appliedRow.applied_total_cost, 'applied_total_cost');

      const deltaSize = input.cumulativeFilledSize.sub(appliedSize);
      const deltaTotalCost = input.cumulativeFilledTotalCost.sub(appliedTotalCost);

      if (deltaSize.isZero()) {
        // Nothing new. The common cause is the websocket and the REST backfill both
        // reporting the same fill, which is expected rather than exceptional.
        //
        // A report that revises the price without moving the quantity also lands here
        // and is ignored. Booking it would mean a zero-size transaction, which has no
        // basis to move and no position to apportion against; correcting a price after
        // the fact is a different operation from applying a fill.
        return { transaction: null };
      }

      const reconciled = reconcilePosition({
        positionSize: toDecimal(current.size, 'position size'),
        positionTotalCost: toDecimal(current.total_cost, 'position total_cost'),
        transactionSize: deltaSize,
        transactionTotalCost: deltaTotalCost,
      });

      const { transaction } = await this.writeFill(client, {
        referenceId: input.referenceId,
        accountId: input.accountId,
        symbol: input.symbol,
        assetClass: input.assetClass,
        multiplier: input.multiplier,
        transactionSize: deltaSize,
        transactionTotalCost: deltaTotalCost,
        transactionProfit: reconciled.transactionProfit,
        positionSize: reconciled.positionSize,
        positionTotalCost: reconciled.positionTotalCost,
        timestamp: input.timestamp,
      });
      return { transaction };
    });
  }

  async appendTransaction(input: AppendTransactionInput): Promise<AppendTransactionOutput> {
    return await this.inTransaction(async (client) => {
      await this.lockPosition(client, input.accountId, input.symbol, input.assetClass, input.multiplier);
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

      // A split changes how many units the position is counted in. It does not change
      // what was paid, so the total cost is left exactly as it is and the unit cost
      // falls out of the new size — one multiplication, no division, and no chance of
      // a rounded size disagreeing with a rounded price about the ratio.
      //
      // Fractional results are kept rather than rounded away. A reverse split that
      // leaves a fraction of a share is settled in cash by the broker, and that is a
      // transaction rather than a rounding.
      const size = toDecimal(row.size, 'position size').mul(input.ratio);

      const updated = await client.query<PositionRow>(`UPDATE position SET size = $3, updated_at = now() WHERE account_id = $1 AND symbol = $2 RETURNING ${POSITION_COLUMNS}`, [
        input.accountId,
        input.symbol,
        size.toString(),
      ]);
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
      locked.set(first.accountId, await this.lockPosition(client, first.accountId, input.symbol, input.assetClass, input.multiplier));
      locked.set(second.accountId, await this.lockPosition(client, second.accountId, input.symbol, input.assetClass, input.multiplier));

      const applySide = async (side: TransferSide, signedSize: Decimal, signedTotalCost: Decimal): Promise<Transaction> => {
        await client.query(
          `INSERT INTO broker_order
             (broker_order_id, account_id, broker, broker_account_id, symbol, asset_class, multiplier,
              status, order_class, order_type, side, time_in_force, qty, filled_qty, filled_avg_price, filled_at)
           VALUES ($1, $2, 'traderq', $3, $4, $5, $6, 'filled', 'regular', 'market', $7, 'day', $8, $8, $9, to_timestamp($10 / 1000.0))`,
          [
            side.orderId,
            side.accountId,
            input.brokerAccountId,
            input.symbol,
            input.assetClass,
            input.multiplier.toString(),
            signedSize.isNegative() ? 'sell' : 'buy',
            signedSize.toString(),
            // The broker-units price, which is what this column means everywhere else.
            derivePremium(signedTotalCost, signedSize, input.multiplier).toString(),
            input.timestamp,
          ],
        );
        await client.query('INSERT INTO broker_order_record (broker_order_id, record) VALUES ($1, $2)', [side.orderId, JSON.stringify(side.record)]);

        const current = locked.get(side.accountId);
        if (current === undefined) {
          throw new InternalServiceError(`The ${input.symbol} position for account ${side.accountId} was not locked before the transfer was applied.`);
        }

        const reconciled = reconcilePosition({
          positionSize: toDecimal(current.size, 'position size'),
          positionTotalCost: toDecimal(current.total_cost, 'position total_cost'),
          transactionSize: signedSize,
          transactionTotalCost: signedTotalCost,
        });

        const { transaction } = await this.writeFill(client, {
          referenceId: side.orderId,
          accountId: side.accountId,
          symbol: input.symbol,
          assetClass: input.assetClass,
          multiplier: input.multiplier,
          transactionSize: signedSize,
          transactionTotalCost: signedTotalCost,
          transactionProfit: reconciled.transactionProfit,
          positionSize: reconciled.positionSize,
          positionTotalCost: reconciled.positionTotalCost,
          timestamp: input.timestamp,
        });
        return transaction;
      };

      const originTransaction = await applySide(input.origin, input.size.neg(), input.totalCost.neg());
      const destinationTransaction = await applySide(input.destination, input.size, input.totalCost);
      return { originTransaction, destinationTransaction };
    });
  }

  async getOrderFillProgress(input: GetOrderFillProgressInput): Promise<GetOrderFillProgressOutput> {
    const result = await this.pool.query<FillProgressRow>(`SELECT ${FILL_PROGRESS_COLUMNS} FROM order_fill_progress WHERE reference_id = $1 ORDER BY account_id, symbol`, [
      input.referenceId,
    ]);
    return { progress: result.rows.map(toFillProgress) };
  }

  /**
   * Re-derives every counter from the transactions it counts, and reports where the two
   * disagree.
   *
   * This is the check that came free while the applied totals were summed on every
   * fill. Storing them made the write path cheaper and made drift *possible*, so the
   * sum survives here: it costs nothing when nothing is wrong, and it is the only thing
   * that will say so when something is.
   *
   * A FULL OUTER JOIN rather than a left join, because a counter with no transactions
   * behind it and transactions with no counter are both discrepancies, and either would
   * be invisible from one side.
   */
  async reconcileOrderFillProgress(input: ReconcileOrderFillProgressInput): Promise<ReconcileOrderFillProgressOutput> {
    const parameters: unknown[] = [];
    const conditions: string[] = [];
    if (input.referenceId !== undefined) {
      parameters.push(input.referenceId);
      conditions.push(`reference_id = $${parameters.length}`);
    }
    if (input.accountId !== undefined) {
      parameters.push(input.accountId);
      conditions.push(`account_id = $${parameters.length}`);
    }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;

    const result = await this.pool.query<{
      reference_id: string;
      account_id: string;
      symbol: string;
      stored_size: string;
      summed_size: string;
      stored_total_cost: string;
      summed_total_cost: string;
    }>(
      `WITH stored AS (
         SELECT reference_id, account_id, symbol, applied_size, applied_total_cost FROM order_fill_progress ${where}
       ), summed AS (
         SELECT reference_id, account_id, symbol, SUM(size) AS size, SUM(total_cost) AS total_cost
           FROM ledger_transaction ${where}
          GROUP BY reference_id, account_id, symbol
       )
       SELECT COALESCE(stored.reference_id, summed.reference_id) AS reference_id,
              COALESCE(stored.account_id, summed.account_id)     AS account_id,
              COALESCE(stored.symbol, summed.symbol)             AS symbol,
              COALESCE(stored.applied_size, 0)                   AS stored_size,
              COALESCE(summed.size, 0)                           AS summed_size,
              COALESCE(stored.applied_total_cost, 0)             AS stored_total_cost,
              COALESCE(summed.total_cost, 0)                     AS summed_total_cost
         FROM stored
         FULL OUTER JOIN summed
           ON stored.reference_id = summed.reference_id
          AND stored.account_id = summed.account_id
          AND stored.symbol = summed.symbol`,
      // The same placeholders appear in both CTEs and are supplied once: a parameter is
      // bound to the statement, not to an occurrence of it.
      parameters,
    );

    const discrepancies: FillProgressDiscrepancy[] = [];
    for (const row of result.rows) {
      const context = `Fill progress ${row.reference_id} ${row.account_id}/${row.symbol}`;
      const storedSize = toDecimal(row.stored_size, `${context} stored size`);
      const summedSize = toDecimal(row.summed_size, `${context} summed size`);
      const storedTotalCost = toDecimal(row.stored_total_cost, `${context} stored total cost`);
      const summedTotalCost = toDecimal(row.summed_total_cost, `${context} summed total cost`);
      if (!storedSize.eq(summedSize) || !storedTotalCost.eq(summedTotalCost)) {
        discrepancies.push({ referenceId: row.reference_id, accountId: row.account_id, symbol: row.symbol, storedSize, summedSize, storedTotalCost, summedTotalCost });
      }
    }
    return { checked: result.rows.length, discrepancies };
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
   * Everything downstream — the profit total, the transaction's running figures, the
   * order's applied totals — is only ever written by a caller holding this lock, so
   * nothing else needs one.
   */
  private async lockPosition(client: PoolClient, accountId: string, symbol: string, assetClass: AssetClass, multiplier: Decimal): Promise<PositionRow> {
    const result = await client.query<PositionRow>(
      `INSERT INTO position (account_id, symbol, asset_class, size, total_cost, multiplier) VALUES ($1, $2, $3, 0, 0, $4)
       ON CONFLICT (account_id, symbol) DO UPDATE SET updated_at = position.updated_at
       RETURNING ${POSITION_COLUMNS}`,
      [accountId, symbol, assetClass, multiplier.toString()],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new InternalServiceError(`Locking the ${symbol} position for account ${accountId} returned no row.`);
    }
    return row;
  }

  /**
   * Runs with the position row already locked by the caller.
   *
   * This is the **only** function that writes a `ledger_transaction`, and that is what
   * makes the stored fill progress safe: the counter and the row it counts are advanced
   * in one statement pair inside one transaction, so there is no path that writes a
   * transaction without moving the counter. Any new write path must come through here.
   */
  private async writeFill(client: PoolClient, input: AppendTransactionInput): Promise<AppendTransactionOutput> {
    const positionResult = await client.query<PositionRow>(
      `UPDATE position SET size = $3, total_cost = $4, asset_class = $5, multiplier = $6, updated_at = now()
        WHERE account_id = $1 AND symbol = $2 RETURNING ${POSITION_COLUMNS}`,
      [input.accountId, input.symbol, input.positionSize.toString(), input.positionTotalCost.toString(), input.assetClass, input.multiplier.toString()],
    );

    // Read-modify-write rather than `SET profit = profit + $delta`, and safe because
    // the caller holds the position lock: nothing else writes this account's profit in
    // this symbol without taking it first.
    //
    // A profit row appears only once the symbol has realised something, which is why
    // `getProfit` legitimately returns nothing for an open position that has never
    // been reduced.
    const existing = await client.query<{ profit: string }>('SELECT profit FROM profit WHERE account_id = $1 AND symbol = $2', [input.accountId, input.symbol]);
    const existingRow = existing.rows[0];
    let cumulativeProfit = existingRow === undefined ? Decimal.ZERO : toDecimal(existingRow.profit, 'profit');
    if (input.transactionProfit !== undefined) {
      // Exact: adding two decimals never rounds, so this total cannot drift away from
      // the sum of the transactions behind it however many fills it accumulates.
      cumulativeProfit = cumulativeProfit.add(input.transactionProfit);
      await client.query(
        `INSERT INTO profit (account_id, symbol, asset_class, profit) VALUES ($1, $2, $3, $4)
         ON CONFLICT (account_id, symbol) DO UPDATE SET profit = EXCLUDED.profit, asset_class = EXCLUDED.asset_class, updated_at = now()`,
        [input.accountId, input.symbol, input.assetClass, cumulativeProfit.toString()],
      );
    }

    const transactionResult = await client.query<TransactionRow>(
      `INSERT INTO ledger_transaction
         (reference_id, account_id, symbol, asset_class, occurred_at, size, total_cost, multiplier, profit, cumulative_size, cumulative_total_cost, cumulative_profit)
       VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0), $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${TRANSACTION_COLUMNS}`,
      [
        input.referenceId,
        input.accountId,
        input.symbol,
        input.assetClass,
        input.timestamp,
        input.transactionSize.toString(),
        input.transactionTotalCost.toString(),
        input.multiplier.toString(),
        input.transactionProfit === undefined ? null : input.transactionProfit.toString(),
        input.positionSize.toString(),
        input.positionTotalCost.toString(),
        cumulativeProfit.toString(),
      ],
    );

    // Advanced by the same amount the transaction records, in the same transaction.
    // Summed in SQL rather than in TypeScript because NUMERIC addition is exact and
    // therefore gives the identical answer — one of the things the column type bought —
    // and doing it in one statement keeps it impossible to write the transaction and
    // forget the counter.
    await client.query(
      `INSERT INTO order_fill_progress (reference_id, account_id, symbol, applied_size, applied_total_cost)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (reference_id, account_id, symbol) DO UPDATE
         SET applied_size = order_fill_progress.applied_size + EXCLUDED.applied_size,
             applied_total_cost = order_fill_progress.applied_total_cost + EXCLUDED.applied_total_cost,
             updated_at = now()`,
      [input.referenceId, input.accountId, input.symbol, input.transactionSize.toString(), input.transactionTotalCost.toString()],
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
