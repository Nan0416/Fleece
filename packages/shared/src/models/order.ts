/**
 * `traderq` is not an external venue: it is the counterparty stamped on the two
 * synthetic orders a position transfer writes, one on each side of the move.
 */
export type Broker = 'alpaca' | 'traderq';

export type OrderGroupStatus = 'open' | 'closed';

export type DocumentType = 'execution-configs';

interface BaseDocument {
  readonly type: DocumentType;
  readonly documentId: string;
}

export interface ExecutionConfigsDocument extends BaseDocument {
  readonly type: 'execution-configs';
  readonly configId: string;
  readonly version: number;
  readonly obj: unknown;
}

export type Document = ExecutionConfigsDocument;

/**
 * One upstream intent, which may become several broker orders.
 *
 * The two correlation fields are set by whoever placed the orders and are opaque here:
 *
 * - `correlationType` categorises what kind of thing created the group. The legacy
 *   execution service passed its `orderGuardType` — the name of the advanced order
 *   being run, one of `SimpleOrder`, `StepProfit`, `TakeProfit`, `ReactiveOrder`,
 *   `InstantTransfer`, `ConditionalOrder`, `SwingOrder`, `GridOrder` or
 *   `PortfolioRebalance`. Typed as a plain string rather than that union on purpose:
 *   adding a tenth kind of order is the execution service's business, and should not
 *   require redeploying the ledger.
 * - `correlationId` identifies the individual instance. The legacy execution service
 *   passed its `orderGuardId`, so a group can be found again from outside without
 *   anyone having stored the id this service generated.
 *
 * Note what is *not* here: the strategy that asked for the order. The execution service
 * tracked that separately as `traderClass` and never sent it, so the ledger can say a
 * group was a `GridOrder` but not whose. Answering that means joining back through
 * `correlationId`.
 *
 * **A group is one trading day's worth of one thing.** The execution service creates a
 * fresh order-guard instance per strategy per session — the guards read the market
 * calendar and only evaluate between `marketOpenAt` and `marketCloseAt` — and each one
 * creates its group on startup and calls `closeOrderGroup` when it terminates. So a
 * group's span is a session, `status` is `open` while its guard is alive and `closed`
 * once it has finished, and "everything that strategy did on Tuesday" is a group rather
 * than a query. It is also why a caller listing groups naturally has a date range to
 * hand, which the time-window requirement on that endpoint asks for.
 */
export interface OrderGroup {
  readonly groupId: string;
  readonly correlationId: string;
  readonly correlationType: string;
  /** `open` while the run that created it is alive; `closed` once it has finished. */
  readonly status: OrderGroupStatus;
  readonly accountId: string;
  readonly brokerOrders: ReadonlyArray<BrokerOrder>;
  readonly documents?: ReadonlyArray<Document>;
  readonly createdAt: number;
  readonly lastUpdatedAt: number;
}

/**
 * One order at one broker, tied to the virtual account it trades for.
 *
 * `groupId` is absent for an orphan — an order placed outside the system, typically
 * by hand on the broker's own website, or a leg order whose parent could not be
 * resolved in time. The legacy store spelled that absence as the sentinel string
 * `_OrphanGroup_` and reserved it from callers; here it is simply `undefined`, which
 * is a NULL column and a partial index rather than a value every query must exclude.
 */
export interface BrokerOrder {
  readonly brokerOrderId: string;
  readonly symbol: string;
  readonly accountId: string;
  readonly broker: Broker;
  readonly brokerAccountId: string;
  readonly status: string;
  readonly groupId?: string;
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
  /** Negative on the sending side, positive on the receiving side. */
  readonly size: number;
  readonly filledSize: number;
  readonly filledAvgPrice: number;
  readonly createdAt: string;
  readonly filledAt: string;
}
