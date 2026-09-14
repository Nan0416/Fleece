import { parseOccSymbol } from '@fleece/marketdata';
import { Decimal, derivePremium, LEDGER_SCALE, sumDecimals, type DecimalInput } from '@fleece/utilities';
import { nanoid } from 'nanoid';

import type { TimeSubscriber } from './time';

/**
 * One open FIFO lot: a signed size and the dollars behind it, with the multiplier and the
 * opening commission already folded in — two contracts entered at 3.85 for $1.30 are a size
 * of 2 against a `totalCost` of 771.30.
 */
export interface Lot {
  readonly size: Decimal;
  readonly totalCost: Decimal;
  readonly entryTime: number;
}

/** Why a trade was made, which only the strategy knows. `record` checks it against what the trade does. */
export type TradeContext = OpeningContext | ClosingContext;

/** A trade that starts a position or adds to one. */
export interface OpeningContext {
  readonly kind: 'open';
  /** Dollars paid for the fill. Never negative. */
  readonly commission: DecimalInput;
  /** Dollars the position ties up, which its return is measured against: strike × 100 for a cash-secured put. */
  readonly capital: DecimalInput;
  /** Whatever the strategy wants on the report's line for the position, in the order given. */
  readonly notes?: Readonly<Record<string, string>>;
}

/** A trade that reduces a position, part way or to flat. */
export interface ClosingContext {
  readonly kind: 'close';
  /** Dollars paid for the fill. Never negative. */
  readonly commission: DecimalInput;
  /** Why the strategy closed, as it should read in the report. */
  readonly reason: string;
}

export interface Transaction {
  readonly symbol: string;
  readonly size: Decimal;
  /** The price the strategy named, per share — so the per-share premium for an option. */
  readonly price: Decimal;
  /** Dollars paid for the fill, already inside `totalCost`. */
  readonly commission: Decimal;
  /** Dollars this transaction cost the account, commission included: cash falls by exactly this. */
  readonly totalCost: Decimal;
  readonly time: number;
  /**
   * Only exists for a close. Net of both commissions: this one's, and the opening one's share
   * of the basis the close retired. Zero is a break-even close, not absence.
   */
  readonly realizedPL?: Decimal;
  readonly context: TradeContext;
}

export interface Trade {
  readonly symbol: string; // stock symbol or option OCC
  readonly size: DecimalInput;
  readonly timestamp: number;
  readonly price: DecimalInput; // we trade the external given price.
}

export interface Position {
  readonly symbol: string;
  /** Per share, opening commission included. */
  readonly averagePrice: number;
  readonly size: number;
}

export interface RealizedPL {
  readonly symbol: string;
  readonly realizedPL: number;
}

/** Told of every transaction the account books, in the order it books them, and of none it refuses. */
export interface TransactionRecorder {
  record(transaction: Transaction): void;
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
  record(trade: Trade, context: TradeContext): Transaction;
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

export function contractMultiplier(symbol: string): Decimal {
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
 * FIFO: a close retires the oldest lots first. A trade is either an open or a close, and says
 * which: one that would carry a position through zero is refused, as a broker refuses it, and
 * is sent as a close and then an open, each with its own commission.
 *
 * Commission is paid on every fill. An open's joins the lot's basis and a close's comes off
 * what it realizes, so once a position is flat its realized P&L is net of both.
 *
 * A `BacktestTime` drives it, and a trade must be stamped with the instant the clock is
 * on — so the clock is the one place the current time comes from. Every transaction booked
 * goes to the recorder it was built with.
 *
 *     const clock = new BacktestTime(t0, t0 + 60 * 60_000, 60_000); // an hour, in one-minute steps
 *     const account = new BacktestAccountImpl(report, 10_000);
 *     clock.subscribe(account);
 *
 *     await clock.forward();
 *     account.record({ symbol: 'AAPL', size: 10, price: 50, timestamp: clock.timestamp }, { kind: 'open', commission: 1, capital: 500 });
 *     await clock.forward();
 *     account.record({ symbol: 'AAPL', size: -10, price: 60, timestamp: clock.timestamp }, { kind: 'close', commission: 1, reason: 'target' });
 *     account.cash.toString(); // '10098' — 10_000 - 501 + 599
 *     account.realizedPLs();   // [{ symbol: 'AAPL', realizedPL: 98 }]
 */
export class BacktestAccountImpl implements BacktestAccount {
  readonly timeSubscriberId: string;
  readonly initialCashPosition: Decimal;

  private cashPosition: Decimal;

  private readonly symbolToLots: Map<string, Lot[]>;
  private readonly symbolToTransactions: Map<string, Transaction[]>;

  private currentTimestamp: number;

  constructor(
    private readonly recorder: TransactionRecorder,
    initialCashPosition: DecimalInput = 0,
  ) {
    this.initialCashPosition = Decimal.of(initialCashPosition);
    this.cashPosition = this.initialCashPosition;
    this.currentTimestamp = 0;

    this.symbolToLots = new Map();
    this.symbolToTransactions = new Map();

    this.timeSubscriberId = 'account' + nanoid();
  }

  async init(timestamp: number) {
    this.currentTimestamp = timestamp;
  }

  async forward(timestamp: number): Promise<void> {
    if (this.currentTimestamp >= timestamp) {
      throw new Error(`The clock moved to ${timestamp}, which is not past the ${this.currentTimestamp} this account is already on. A subscriber is only ever stepped forward.`);
    }
    this.currentTimestamp = timestamp;
    // todo: in the future, we can log the account unrealized PL, etc.
  }

  /** Refuses before booking anything, so a trade it will not take leaves the book as it was. */
  record(trade: Trade, context: TradeContext): Transaction {
    if (this.currentTimestamp !== trade.timestamp) {
      throw new Error(
        `Trade for ${trade.symbol} is stamped ${trade.timestamp} but the account clock is on ${this.currentTimestamp}. Stamp it with timestamp(), and call forward() to move the clock on.`,
      );
    }

    const multiplier = contractMultiplier(trade.symbol);
    const price = Decimal.of(trade.price);
    const size = Decimal.of(trade.size);
    const commission = Decimal.of(context.commission);
    const lots = this.symbolToLots.get(trade.symbol) ?? [];
    requireTradeMatchesContext(trade.symbol, size, sumDecimals(lots.map((lot) => lot.size)), commission, context);

    const totalCost = size.mul(price).mul(multiplier).add(commission);
    let realizedPL: Decimal | undefined;

    if (context.kind === 'open') {
      lots.push({ size, totalCost, entryTime: trade.timestamp });
    } else {
      // Accumulated from zero rather than left undefined, which is what makes a close at
      // exactly the entry price report 0 instead of "realized nothing".
      let realized = Decimal.ZERO;
      let remaining = size;
      while (!remaining.isZero() && lots.length > 0) {
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
        // covered.
        const closedCost = closed.mul(price).mul(multiplier);
        realized = realized.add(closedCost.neg().sub(basisRemoved));

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
      // All of it, however many lots the close spread across: this fill paid it.
      realizedPL = realized.sub(commission);
    }

    this.symbolToLots.set(trade.symbol, lots);
    this.cashPosition = this.cashPosition.sub(totalCost);

    const transaction: Transaction = { symbol: trade.symbol, size, price, commission, totalCost, time: trade.timestamp, realizedPL, context };
    const transactions = this.symbolToTransactions.get(trade.symbol) ?? [];
    transactions.push(transaction);
    this.symbolToTransactions.set(trade.symbol, transactions);
    this.recorder.record(transaction);

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
   * at 3.85 reads 3.85 here rather than the 385 a contract cost — plus the opening
   * commission per share, since that is in the basis.
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

/**
 * That a trade does what its context says. An open must not reduce what is held, a close must
 * reduce it without going past zero, and nothing may do both: the lots of one symbol are
 * always all long or all short, which is what lets a close walk them in order.
 */
function requireTradeMatchesContext(symbol: string, size: Decimal, held: Decimal, commission: Decimal, context: TradeContext): void {
  if (size.isZero()) {
    throw new Error(`A trade for ${symbol} has no size. Record a trade that moves something.`);
  }
  if (commission.isNegative()) {
    throw new Error(`The commission on a trade for ${symbol} is ${commission.toString()}. A commission is paid, never received: pass it as a positive amount.`);
  }

  const reduces = !held.isZero() && held.signum() !== size.signum();
  if (reduces && size.abs().gt(held.abs())) {
    throw new Error(
      `A trade of ${size.toString()} ${symbol} would carry the ${held.toString()} held through zero, which a broker refuses. Close the ${held.toString()} and open ${size.add(held).toString()} as two trades, each with its own commission.`,
    );
  }
  if (context.kind === 'open' && reduces) {
    throw new Error(`${symbol} is held ${held.toString()}, and a trade of ${size.toString()} reduces it. Record it as a close.`);
  }
  if (context.kind === 'close' && !reduces) {
    throw new Error(`${symbol} is held ${held.toString()}, and a trade of ${size.toString()} does not reduce it. Record it as an open.`);
  }
}
