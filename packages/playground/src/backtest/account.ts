import { parseOccSymbol } from '@fleece/marketdata';
import { Decimal, derivePremium, LEDGER_SCALE, sumDecimals, type DecimalInput } from '@fleece/utilities';
import { nanoid } from 'nanoid';

import type { TimeSubscriber } from './time';

/**
 * One open FIFO lot: a signed size and the dollars behind it, with the multiplier already
 * folded in — two contracts entered at 3.85 are a size of 2 against a `totalCost` of 770.
 */
export interface Lot {
  readonly size: Decimal;
  readonly totalCost: Decimal;
  readonly entryTime: number;
}

export interface Transaction {
  readonly size: Decimal;
  /** The price the strategy named, per share — so the per-share premium for an option. */
  readonly price: Decimal;
  /** Dollars this transaction moved, signed the same way as `size`. */
  readonly totalCost: Decimal;
  readonly time: number;
  /** Only exists for a transaction that reduced a position. Zero is a break-even close, not absence. */
  readonly realizedPL?: Decimal;
}

export interface Trade {
  readonly symbol: string; // stock symbol or option OCC
  readonly size: DecimalInput;
  readonly timestamp: number;
  readonly price: DecimalInput; // we trade the external given price.
}

export interface Position {
  readonly symbol: string;
  readonly averagePrice: number;
  readonly size: number;
}

export interface RealizedPL {
  readonly symbol: string;
  readonly realizedPL: number;
}

/** The read view, for anything that reports on a run rather than drives one. */
export interface BacktestPortfolio {
  get cash(): Decimal;
  symbols(): ReadonlyArray<string>;
  positions(): ReadonlyArray<Position>;
  realizedPLs(): ReadonlyArray<RealizedPL>;
}

/**
 * The driving view: the clock and the write path on top of the read one. Handing a
 * reporter `BacktestPortfolio` instead is what stops it advancing time by accident.
 */
export interface BacktestAccount extends BacktestPortfolio, TimeSubscriber {
  record(trade: Trade): Transaction;
}

/**
 * A US equity option contract is a claim on 100 shares and its price is quoted per share,
 * so a contract bought at 3.85 moves $385. Without this every option trade books its cash
 * and its P&L a hundred times too small.
 *
 * An adjusted contract — `1AAPL...` — can deliver something other than 100 shares. This
 * treats it as 100 anyway; the real figure only comes from the contract listing.
 */
const OPTION_CONTRACT_MULTIPLIER = Decimal.of(100);

function contractMultiplier(symbol: string): Decimal {
  return parseOccSymbol(symbol) === undefined ? Decimal.ONE : OPTION_CONTRACT_MULTIPLIER;
}

/**
 * The part of `remaining` that this lot can absorb, signed the way the trade is so it
 * cancels against the lot by addition.
 */
function closingSize(lotSize: Decimal, remaining: Decimal): Decimal {
  return lotSize.abs().lt(remaining.abs()) ? lotSize.neg() : remaining;
}

/**
 * Doesn't consider dividend.
 * Assume infinite margin.
 *
 * FIFO: a trade closes the oldest lots of the opposite sign first, and whatever is left
 * over opens a new one at the trade's own price.
 *
 * A `Time` drives it, and a trade must be stamped with the instant the clock is on — so
 * the clock is the one place the current time comes from.
 *
 *     const clock = new Time(t0, 60_000); // one-minute steps
 *     const account = new BacktestAccountImpl(10_000);
 *     clock.subscribe(account);
 *
 *     await clock.forward();
 *     account.record({ symbol: 'AAPL', size: 10, price: 50, timestamp: clock.timestamp() });
 *     await clock.forward();
 *     account.record({ symbol: 'AAPL', size: -15, price: 60, timestamp: clock.timestamp() });
 *     account.cash.toString(); // '10400'  — 10_000 - 500 + 900
 *     account.positions();     // [{ symbol: 'AAPL', size: -5, averagePrice: 60 }]
 *     account.realizedPLs();   // [{ symbol: 'AAPL', realizedPL: 100 }]
 */
export class BacktestAccountImpl implements BacktestAccount {
  readonly timeSubscriberId: string;
  readonly initialCashPosition: Decimal;

  private cashPosition: Decimal;

  private readonly symbolToLots: Map<string, Lot[]>;
  private readonly symbolToTransactions: Map<string, Transaction[]>;

  private currentTimestamp: number;

  constructor(initialCashPosition: DecimalInput) {
    this.initialCashPosition = Decimal.of(initialCashPosition);
    this.cashPosition = this.initialCashPosition;
    this.currentTimestamp = 0;

    this.symbolToLots = new Map();
    this.symbolToTransactions = new Map();

    this.timeSubscriberId = nanoid();
  }

  async forward(timestamp: number): Promise<void> {
    if (this.currentTimestamp >= timestamp) {
      throw new Error(`The clock moved to ${timestamp}, which is not past the ${this.currentTimestamp} this account is already on. A subscriber is only ever stepped forward.`);
    }
    this.currentTimestamp = timestamp;
    // todo: in the future, we can log the account unrealized PL, etc.
  }

  record(trade: Trade): Transaction {
    if (this.currentTimestamp !== trade.timestamp) {
      throw new Error(
        `Trade for ${trade.symbol} is stamped ${trade.timestamp} but the account clock is on ${this.currentTimestamp}. Stamp it with timestamp(), and call forward() to move the clock on.`,
      );
    }

    const multiplier = contractMultiplier(trade.symbol);
    const price = Decimal.of(trade.price);
    const size = Decimal.of(trade.size);
    const lots = this.symbolToLots.get(trade.symbol) ?? [];

    let remaining = size;
    let realizedPL: Decimal | undefined;

    while (!remaining.isZero() && lots.length > 0 && lots[0].size.signum() !== remaining.signum()) {
      const lot = lots[0];
      const closed = closingSize(lot.size, remaining);
      const closesLot = closed.abs().eq(lot.size.abs());

      // Closing a lot out entirely takes the whole basis rather than going through the
      // general formula, which would round a value that is exactly known and leave a
      // residue of basis behind with no lot holding it.
      const basisRemoved = closesLot ? lot.totalCost : lot.totalCost.mul(closed.abs()).div(lot.size.abs(), LEDGER_SCALE);

      // Proceeds less the basis they retired, which is the ledger's own expression: the
      // transaction's cost is signed opposite to the lot it reduces, so negating it turns
      // a sale into the dollars it brought in and the same line covers a short being
      // covered. Accumulating from zero rather than leaving it undefined is what makes a
      // close at exactly the entry price report 0 instead of "realized nothing".
      const closedCost = closed.mul(price).mul(multiplier);
      realizedPL = (realizedPL ?? Decimal.ZERO).add(closedCost.neg().sub(basisRemoved));

      if (closesLot) {
        lots.shift();
      } else {
        // Subtraction, not a second division: whatever rounding the basis above took, the
        // remainder absorbs, so the lot's cost plus the cost removed is exactly the cost
        // there was.
        lots[0] = { ...lot, size: lot.size.add(closed), totalCost: lot.totalCost.sub(basisRemoved) };
      }
      remaining = remaining.sub(closed);
    }

    // A trade that carries the position through zero — selling 15 while long 10 — closes
    // the 10 above and opens a short 5 here, at the price it traded at.
    if (!remaining.isZero()) {
      lots.push({ size: remaining, totalCost: remaining.mul(price).mul(multiplier), entryTime: trade.timestamp });
    }

    const totalCost = size.mul(price).mul(multiplier);
    this.symbolToLots.set(trade.symbol, lots);
    this.cashPosition = this.cashPosition.sub(totalCost);

    const transaction: Transaction = { size, price, totalCost, time: trade.timestamp, realizedPL };
    const transactions = this.symbolToTransactions.get(trade.symbol) ?? [];
    transactions.push(transaction);
    this.symbolToTransactions.set(trade.symbol, transactions);

    return transaction;
  }

  get cash(): Decimal {
    return this.cashPosition;
  }

  /** Every symbol ever traded, open or flat. */
  symbols(): ReadonlyArray<string> {
    return [...this.symbolToTransactions.keys()];
  }

  /**
   * What is still held, oldest symbol first. A symbol traded back to flat is left out —
   * its realized profit survives in `realizedPLs`.
   *
   * `averagePrice` is per share, the unit the trades were priced in, so an option entered
   * at 3.85 reads 3.85 here rather than the 385 a contract cost.
   */
  positions(): ReadonlyArray<Position> {
    const positions: Position[] = [];
    for (const [symbol, lots] of this.symbolToLots) {
      const size = sumDecimals(lots.map((lot) => lot.size));
      if (size.isZero()) {
        continue;
      }
      const totalCost = sumDecimals(lots.map((lot) => lot.totalCost));
      positions.push({ symbol, size: size.toNumber(), averagePrice: derivePremium(totalCost, size, contractMultiplier(symbol)).toNumber() });
    }
    return positions;
  }

  /**
   * One row per symbol that has closed something, so a symbol only ever opened is absent
   * rather than reported as zero — which is a different statement from closing at exactly
   * the entry price, and that one does report zero.
   */
  realizedPLs(): ReadonlyArray<RealizedPL> {
    const realized: RealizedPL[] = [];
    for (const [symbol, transactions] of this.symbolToTransactions) {
      const closed = transactions.flatMap((txn) => (txn.realizedPL === undefined ? [] : [txn.realizedPL]));
      if (closed.length === 0) {
        continue;
      }
      realized.push({ symbol, realizedPL: sumDecimals(closed).toNumber() });
    }
    return realized;
  }
}
