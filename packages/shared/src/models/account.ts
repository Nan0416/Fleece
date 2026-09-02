/**
 * A virtual account. Every order the system places goes through one real broker
 * account, but each strategy trades under its own virtual account, which is what
 * makes per-strategy P&L possible.
 *
 * `live` and `paper` mirror the broker's own account types. `mirror` is a replicated
 * account for a broker with no API, kept in step by hand.
 */
export type AccountType = 'live' | 'paper' | 'mirror';

export type AccountStatus = 'inactive' | 'active';

export interface Account {
  readonly accountId: string;
  readonly name: string;
  readonly status: AccountStatus;
  readonly accountType: AccountType;
  readonly createdAt: number;
  readonly lastUpdatedAt: number;
}

export interface Position {
  readonly accountId: string;
  readonly symbol: string;
  /** 0 means flat; negative means a short position. */
  readonly size: number;
  /** The entry cost of the position, not the current market price. Always positive. */
  readonly avgPrice: number;
  readonly createdAt: number;
  readonly lastUpdatedAt: number;
}

/**
 * A point in a position's history, derived from the transaction log rather than
 * stored: every transaction records the position size it left behind, so the history
 * is a projection of `transaction.cumulative_size` and never needs its own table.
 */
export interface HistoricalPosition {
  readonly accountId: string;
  readonly symbol: string;
  readonly size: number;
  readonly updatedAt: number;
}

/** Derived from the four dates rather than stored, so it can never go stale. */
export type DividendStatus = 'declared' | 'pending' | 'recorded' | 'paid';

export interface Dividend {
  /** `accountId`, `symbol` and `exDividendDate` together identify a dividend. */
  readonly accountId: string;
  readonly symbol: string;
  readonly exDividendDate: string;
  /**
   * The position held going into the ex-dividend date. Created when the dividend is
   * declared and kept up to date until that date passes; negative for a short.
   */
  readonly size: number;
  readonly amountPerShare: number;
  readonly declarationDate: string;
  readonly recordDate: string;
  readonly payDate: string;
  readonly status: DividendStatus;
}

/**
 * One trade against one virtual account. A broker order that fills in several pieces
 * produces one transaction per fill, so `referenceId` — the broker order id — is not
 * unique.
 */
export interface Transaction {
  readonly referenceId: string;
  readonly accountId: string;
  readonly symbol: string;
  readonly timestamp: number;
  readonly avgPrice: number;
  /** Negative means sell, positive means buy. */
  readonly size: number;
  /** Realised profit from this transaction; absent when the trade only opened or added to a position. */
  readonly profit?: number;
  /** Return on the transaction, in basis points. Absent whenever `profit` is. */
  readonly roi?: number;
  /** The position size this transaction left behind. */
  readonly cumulativeSize: number;
  readonly cumulativeProfit: number;
  /**
   * The position unit cost this transaction left behind. Optional because the field
   * was added in 2023-03 and rows written before then do not carry it.
   */
  readonly cumulativeAvgPrice?: number;
}

/** Realised profit to date on one symbol in one account. */
export interface Profit {
  readonly accountId: string;
  readonly symbol: string;
  readonly profit: number;
  readonly createdAt: number;
  readonly lastUpdatedAt: number;
}
