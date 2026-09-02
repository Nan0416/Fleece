import { Dividend } from '@fleece/shared';
import { Pool } from 'pg';
import { DividendDao, GetDividendInput, GetDividendOutput, ListDividendsInput, ListDividendsOutput, UpsertDividendInput, UpsertDividendOutput } from './dividend-dao';
import { toDividendStatus } from './row-parsers';

interface DividendRow {
  readonly account_id: string;
  readonly symbol: string;
  readonly ex_dividend_date: string;
  readonly size: number;
  readonly amount_per_share: number;
  readonly declaration_date: string;
  readonly record_date: string;
  readonly pay_date: string;
}

function toDividend(row: DividendRow, today: string): Dividend {
  const dates = {
    declarationDate: row.declaration_date,
    exDividendDate: row.ex_dividend_date,
    recordDate: row.record_date,
    payDate: row.pay_date,
  };
  return {
    accountId: row.account_id,
    symbol: row.symbol,
    size: row.size,
    amountPerShare: row.amount_per_share,
    ...dates,
    status: toDividendStatus(dates, today),
  };
}

const SELECT_COLUMNS = 'account_id, symbol, ex_dividend_date, size, amount_per_share, declaration_date, record_date, pay_date';

export class PgDividendDao implements DividendDao {
  constructor(private readonly pool: Pool) {}

  async getDividend(input: GetDividendInput): Promise<GetDividendOutput> {
    const result = await this.pool.query<DividendRow>(`SELECT ${SELECT_COLUMNS} FROM dividend WHERE account_id = $1 AND symbol = $2 AND ex_dividend_date = $3`, [
      input.accountId,
      input.symbol,
      input.exDividendDate,
    ]);
    const row = result.rows[0];
    return { dividend: row === undefined ? null : toDividend(row, input.today) };
  }

  async listDividends(input: ListDividendsInput): Promise<ListDividendsOutput> {
    const result =
      input.symbol === undefined
        ? await this.pool.query<DividendRow>(`SELECT ${SELECT_COLUMNS} FROM dividend WHERE account_id = $1 ORDER BY ex_dividend_date DESC, symbol`, [input.accountId])
        : await this.pool.query<DividendRow>(`SELECT ${SELECT_COLUMNS} FROM dividend WHERE account_id = $1 AND symbol = $2 ORDER BY ex_dividend_date DESC`, [
            input.accountId,
            input.symbol,
          ]);
    return { dividends: result.rows.map((row) => toDividend(row, input.today)) };
  }

  /**
   * A dividend is announced before it is paid, and the position it applies to keeps
   * moving until the ex-dividend date — so the corporate-action job rewrites the same
   * row on every run until that date passes. One upsert, rather than the legacy's
   * read-compare-then-create-or-update, which raced with itself.
   */
  async upsertDividend(input: UpsertDividendInput): Promise<UpsertDividendOutput> {
    const result = await this.pool.query<DividendRow>(
      `INSERT INTO dividend (account_id, symbol, ex_dividend_date, size, amount_per_share, declaration_date, record_date, pay_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (account_id, symbol, ex_dividend_date) DO UPDATE
         SET size = EXCLUDED.size, amount_per_share = EXCLUDED.amount_per_share, declaration_date = EXCLUDED.declaration_date,
             record_date = EXCLUDED.record_date, pay_date = EXCLUDED.pay_date, updated_at = now()
       RETURNING ${SELECT_COLUMNS}`,
      [input.accountId, input.symbol, input.exDividendDate, input.size, input.amountPerShare, input.declarationDate, input.recordDate, input.payDate],
    );
    return { dividend: toDividend(result.rows[0], input.today) };
  }
}
