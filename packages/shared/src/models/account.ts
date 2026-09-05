import { Decimal } from '../utils/decimal';
import { AssetClass } from './asset-class';

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

/**
 * What one virtual account holds in one symbol.
 *
 * **Stored as a size and the dollars behind it**, never as a unit price. Adding to a
 * position is then addition and closing one out is subtraction, both exact; a unit price
 * would have to be divided out on every write and then used as the input to the next
 * one, which is how a cost basis drifts. `avgPrice` and `premium` below are projections
 * of the two stored columns, computed on the way out.
 *
 * `size` counts the instrument's own units: shares for equity, coins for crypto, and
 * **contracts** for an option — so two contracts read as `2`, not as 200 units of the
 * underlying. The dollars are in `totalCost` regardless, which is what keeps an account
 * holding both stock and options addable.
 */
export interface Position {
  readonly accountId: string;
  readonly symbol: string;
  readonly assetClass: AssetClass;
  /** 0 means flat; negative means a short position. */
  readonly size: Decimal;
  /** Dollars behind the position, signed the same way as `size`. 0 when flat. */
  readonly totalCost: Decimal;
  /** Units of the underlying per unit of `size`. 1 for anything but an option. */
  readonly multiplier: Decimal;
  /**
   * Derived, not stored: `totalCost / size`. The entry cost of the position, not the
   * current market price. Always positive, and 0 when flat.
   *
   * For an option this is the cost per contract. `premium` is the per-share figure the
   * broker quotes.
   */
  readonly avgPrice: Decimal;
  /** Derived, not stored: `totalCost / (size * multiplier)`. Equal to `avgPrice` unless this is an option. */
  readonly premium: Decimal;
  readonly createdAt: number;
  readonly lastUpdatedAt: number;
}

/**
 * A point in a position's history, derived from the transaction log rather than
 * stored: every transaction records the position size it left behind, so the history
 * is a projection of `ledger_transaction.cumulative_size` and never needs its own table.
 */
export interface HistoricalPosition {
  readonly accountId: string;
  readonly symbol: string;
  readonly assetClass: AssetClass;
  readonly size: Decimal;
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
  readonly size: Decimal;
  readonly amountPerShare: Decimal;
  readonly declarationDate: string;
  readonly recordDate: string;
  readonly payDate: string;
  readonly status: DividendStatus;
}

/**
 * One trade against one virtual account. A broker order that fills in several pieces
 * produces one transaction per fill, so `referenceId` — the broker order id — is not
 * unique.
 *
 * Like `Position`, it records a size and the dollars that moved rather than a price.
 * `avgPrice`, `premium` and `roi` are projections computed on read.
 */
export interface Transaction {
  readonly referenceId: string;
  readonly accountId: string;
  readonly symbol: string;
  readonly assetClass: AssetClass;
  readonly timestamp: number;
  /** Negative means sell, positive means buy. */
  readonly size: Decimal;
  /** Dollars this transaction moved, signed the same way as `size`. */
  readonly totalCost: Decimal;
  /**
   * The multiplier used to turn the broker's quoted premium into `totalCost`.
   *
   * Stored rather than assumed so that the premium actually traded is recoverable, and
   * so that an adjusted contract booked under the wrong assumption can be found instead
   * of silently distorting every figure derived from it.
   */
  readonly multiplier: Decimal;
  /** Derived: `totalCost / size`. Cost per contract for an option. */
  readonly avgPrice: Decimal;
  /** Derived: `totalCost / (size * multiplier)`. The premium a broker would quote. */
  readonly premium: Decimal;
  /** Realised profit from this transaction; absent when it only opened or added to a position. */
  readonly profit?: Decimal;
  /** Derived: return on the transaction, in basis points. Absent whenever `profit` is. */
  readonly roi?: Decimal;
  /** The position size this transaction left behind. */
  readonly cumulativeSize: Decimal;
  /** The position total cost this transaction left behind. */
  readonly cumulativeTotalCost: Decimal;
  readonly cumulativeProfit: Decimal;
  /** Derived: the position unit cost this transaction left behind. */
  readonly cumulativeAvgPrice: Decimal;
}

/** Realised profit to date on one symbol in one account. */
export interface Profit {
  readonly accountId: string;
  readonly symbol: string;
  readonly assetClass: AssetClass;
  readonly profit: Decimal;
  readonly createdAt: number;
  readonly lastUpdatedAt: number;
}
