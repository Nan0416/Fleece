import { Decimal } from '../utils/decimal';

/**
 * What an instrument is. Fleece's own vocabulary rather than any broker's — Alpaca says
 * `us_equity` and `us_option`, and the order converter is the one place that becomes
 * this.
 *
 * It sits on positions, profits and transactions as well as on orders, so that
 * "everything this account holds in options" is a query rather than a scan that parses
 * OCC symbols. It is deliberately **not** part of any primary key: a symbol determines
 * its own asset class — an OCC symbol, `BTC/USD` and `AAPL` cannot collide — so keying
 * on it would permit one symbol to exist twice under two classes, which is a split
 * position no query would notice.
 */
export type AssetClass = 'equity' | 'option' | 'crypto';

export function isAssetClass(value: string): value is AssetClass {
  return value === 'equity' || value === 'option' || value === 'crypto';
}

/**
 * Units of the underlying that one unit of an instrument delivers.
 *
 * A US equity option contract is a claim on 100 shares and brokers quote its premium
 * per share, so a contract filled at 3.85 moved $385. The ledger stores the $385 — sizes
 * count contracts and total cost carries the dollars — which is what lets one virtual
 * account hold both stock and options and still total its realised profit without
 * anything having to remember which rows are which.
 *
 * **This is a default, not a fact.** A split or a merger can leave an adjusted contract
 * delivering something other than 100 shares, and Alpaca reports the real figure on the
 * option contract rather than on the order. Every row that books an option therefore
 * stores the multiplier it actually used, so the premium is recoverable and a contract
 * booked under a wrong assumption is visible rather than silently off by a ratio.
 */
export const OPTION_CONTRACT_MULTIPLIER = 100;

export function defaultContractMultiplier(assetClass: AssetClass): Decimal {
  return assetClass === 'option' ? Decimal.of(OPTION_CONTRACT_MULTIPLIER) : Decimal.ONE;
}
