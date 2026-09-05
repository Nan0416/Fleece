import { Decimal } from '../utils/decimal';
import { AssetClass } from './asset-class';

/**
 * `traderq` is not an external venue: it is the counterparty stamped on the two
 * synthetic orders a position transfer writes, one on each side of the move.
 */
export type Broker = 'alpaca' | 'traderq';

/**
 * The status a broker last reported.
 *
 * Typed as a union here but stored as free text with **no CHECK constraint**, and that
 * is deliberate: a status this list has not caught up with must be recorded, not
 * rejected. A rejected row is a fill that never lands, which is the one failure this
 * system exists to prevent.
 */
export type BrokerOrderStatus =
  | 'held'
  | 'accepted'
  | 'pending_new'
  | 'new'
  | 'partially_filled'
  | 'pending_cancel'
  | 'pending_replace'
  | 'filled'
  | 'canceled'
  | 'done_for_day'
  | 'expired'
  | 'replaced'
  | 'rejected';

export type BrokerOrderType = 'market' | 'limit' | 'stop_limit' | 'stop';
export type BrokerOrderSide = 'buy' | 'sell';
export type BrokerOrderTimeInForce = 'day' | 'gtc' | 'opg' | 'cls' | 'ioc' | 'fok';
export type BrokerOrderClass = 'regular' | 'oco' | 'oto' | 'bracket' | 'mleg';

/**
 * Whether a leg opens exposure or closes it. Options carry it; equities do not.
 *
 * Nothing accounts from it — direction comes from the signed quantity, so a
 * `buy_to_close` is a positive size exactly as a `buy_to_open` is. It is kept because
 * it is the only field separating closing a short call from opening a long one, which
 * is the difference between two strategies that otherwise read identically.
 */
export type BrokerPositionIntent = 'buy_to_open' | 'buy_to_close' | 'sell_to_open' | 'sell_to_close';

/**
 * An order is finished when it reaches one of these: no further event will arrive,
 * so any per-order state the injector is holding can be released.
 */
export const TERMINAL_BROKER_ORDER_STATUSES: ReadonlyArray<string> = ['filled', 'canceled', 'expired', 'replaced', 'rejected', 'done_for_day'];

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_BROKER_ORDER_STATUSES.includes(status);
}

/**
 * One order at one broker, tied to the virtual account it trades for.
 *
 * **A leg is one of these, not a child row of one.** A leg of a spread, a bracket or an
 * OTO is a real order at the broker with its own id, instrument, status and fills, so it
 * gets its own row and names its parent in `parentBrokerOrderId`.
 *
 * `parentBrokerOrderId` has an index and **no foreign key**. The converter emits a
 * composite parent before its legs, so the row it names normally exists — but a leg
 * reaching us without its parent, for any reason at all, must still land. A foreign key
 * turns "the parent row is missing" into "the leg is rejected", and a rejected leg is a
 * fill the ledger never learns about.
 *
 * **`accountId` is written once and never changed.** Everything the order produces —
 * transactions, its position, its realised profit, its fill-progress counter — is keyed
 * by it, so moving the order alone strands all of them and makes the next cumulative
 * report book the whole fill again under the new account. An order genuinely in the
 * wrong account is corrected by transferring the *position*, which moves the cost basis
 * and leaves an audit trail on both sides.
 *
 * How the account was decided is not stored. An order Fleece placed says so itself in
 * the `client_order_id` kept verbatim in `broker_order_record`; a leg inherits its
 * parent's, which `parentBrokerOrderId` already records; and an order nobody claimed is
 * one booked to a configured catch-all account, which is a fact about that account
 * rather than about every order pointing at it.
 *
 * `symbol` is absent only on a composite parent that trades no instrument of its own.
 * No such row is written today, for the reason above; the column allows it so that
 * recording one later is a decision rather than a migration, and so that the empty-string
 * sentinel the legacy used has nowhere to come back.
 */
export interface BrokerOrder {
  readonly brokerOrderId: string;
  /** Set on a leg, naming the composite order it belongs to. Groups only — may name no row here. */
  readonly parentBrokerOrderId?: string;
  readonly accountId: string;
  readonly broker: Broker;
  readonly brokerAccountId: string;

  /**
   * Absent only on a composite parent, which trades no instrument of its own.
   *
   * Its absence is what marks a row whose quantities and prices mean something
   * different from every other row's — see `qty`, `limitPrice` and `filledAvgPrice`
   * below. `orderClass === 'mleg' && symbol === undefined` is the condition.
   */
  readonly symbol?: string;
  readonly assetClass: AssetClass;
  /** Units of the underlying per contract, as used when booking this order's fills. */
  readonly multiplier: Decimal;

  readonly status: string;
  readonly orderClass: BrokerOrderClass;
  readonly orderType: BrokerOrderType;
  /** Absent on a composite parent, which has no direction of its own. */
  readonly side?: BrokerOrderSide;
  /** Options only. */
  readonly positionIntent?: BrokerPositionIntent;
  readonly timeInForce: BrokerOrderTimeInForce;
  readonly extendedHours: boolean;

  /**
   * Signed: negative for a sell. Counts contracts for an option — and **spreads** on a
   * composite parent, which is one of the two places a parent row's numbers mean
   * something other than what the same column means everywhere else.
   */
  readonly qty: Decimal;
  /** A leg's share of its parent's quantity. Multi-leg legs only. */
  readonly ratioQty?: Decimal;
  /**
   * On a composite parent this is the **signed net** price of the package — negative
   * for a credit received, positive for a debit paid — where on every other row a price
   * is unsigned. It is the number the spread was actually traded at, and it exists
   * nowhere else: the legs price themselves at nothing.
   *
   * Nothing accounts from it. A parent books no fill, and its legs carry the real
   * instruments at real prices.
   */
  readonly limitPrice?: Decimal;
  readonly stopPrice?: Decimal;

  /**
   * What the **broker** last reported filled, in the broker's own units — contracts for
   * an option, and a premium per share rather than a cost per contract.
   *
   * Not what the ledger has booked. That is `OrderFillProgress`, in ledger units, and
   * the two are deliberately different numbers with different names so that nothing
   * accounts from this one.
   *
   * `filledAvgPrice` on a composite parent is a signed net, exactly as `limitPrice` is.
   */
  readonly filledQty: Decimal;
  readonly filledAvgPrice?: Decimal;

  readonly submittedAt?: number;
  readonly filledAt?: number;
  readonly createdAt: number;
  readonly lastUpdatedAt: number;
}

/**
 * How much of one broker order the **ledger** has actually booked, and for how much.
 *
 * This is the idempotency state for `applyCumulativeFill`. Brokers report cumulative
 * progress rather than deltas — every event says "N filled so far at average P" — so
 * turning an event into a transaction means subtracting what is already recorded, and a
 * report that adds nothing must be a no-op.
 *
 * It was previously summed from `ledger_transaction` on every fill, which made drift
 * impossible because the counter and the record were the same thing. Storing it trades
 * that for a second thing that must agree, and is safe only under one rule: **it is
 * written in the same database transaction as the transaction row it counts, by the one
 * function that writes them.** The summed form survives as a reconciliation query, which
 * costs nothing when nothing is wrong and is the only thing that will say when it is.
 *
 * Keyed by account and symbol as well as reference id, exactly as the old sum was
 * grouped, so a reference id that somehow reached two positions cannot merge them.
 */
export interface OrderFillProgress {
  /** The broker order id, matching `Transaction.referenceId`. */
  readonly referenceId: string;
  readonly accountId: string;
  readonly symbol: string;
  /** Signed total the ledger has booked, in ledger units. */
  readonly appliedSize: Decimal;
  /** Signed dollars the ledger has booked against it. */
  readonly appliedTotalCost: Decimal;
  readonly createdAt: number;
  readonly lastUpdatedAt: number;
}

/**
 * The raw event a broker sent about an order, kept verbatim so the full story of an
 * execution can be replayed. Many records share one `brokerOrderId`.
 *
 * Concrete shapes — an Alpaca order, or the synthetic record a transfer writes —
 * extend this. Only `id` is common, and only `id` is ever read back generically.
 */
export interface BrokerOrderRecord {
  readonly id: string;
}

/** The synthetic record written to each side of a position transfer. */
export interface TransferOrderRecord extends BrokerOrderRecord {
  readonly id: string;
  readonly accountId: string;
  readonly counterpartAccountId: string;
  readonly status: 'filled';
  readonly symbol: string;
  readonly assetClass: AssetClass;
  /** Negative on the sending side, positive on the receiving side. */
  readonly size: Decimal;
  readonly filledSize: Decimal;
  readonly filledTotalCost: Decimal;
  readonly createdAt: string;
  readonly filledAt: string;
}
