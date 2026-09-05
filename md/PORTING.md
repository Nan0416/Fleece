# Porting notes

Fleece is a rewrite of a private trading system that ran on MongoDB across many small
repositories. This records what changed and why, so a difference from the old
behaviour reads as a decision rather than an accident.

**One thing here is now history twice over.** Order groups were ported faithfully and
then removed in the schema redesign, along with the correlation fields they carried, and
so was the `DOUBLE PRECISION` money the port inherited. Where this document describes
them it is describing the legacy and the port that followed it, not the system as it
stands — see `md/OPEN-ITEMS.md` items 2 and 3, and `packages/core/migrations/`.

The legacy source is cloned to `/Users/nan/workplace/alpaca-legacy/`. The service
itself was thin; the logic lived in packages published to a private registry:

| Legacy | Where it went |
| --- | --- |
| `accounts-service/src/server.ts` | `packages/service/src/routes/` |
| `account-store/src/account-facade-impl.ts` | `packages/core/src/services/` |
| `account-store/src/mongodb-*.ts` | `packages/core/src/data/` |
| `broker-models-utils/position-reconciliation.ts` | `packages/shared/src/utils/position-reconciliation.ts` |
| `broker-models-utils/alpaca-order-converter.ts` | `packages/alpaca/src/{correlation,order-converter}.ts` |
| `order-tracking-core/order-tracking-facade.ts` | `packages/injector/src/order-tracking-facade.ts` |
| `broker-models/` | `packages/broker/src/models/` |
| `broker-clients/alpaca-broker.ts` | `packages/broker/src/alpaca-broker.ts` |
| `broker-clients/multi-session-position-tracker.ts` | `packages/broker/src/symbol-position-tracker.ts` |
| `broker-clients/broker-tracker-impl.ts` | `packages/broker/src/account-broker-tracker.ts` |
| `accounts-service/processors/corporate-action-processor.ts` | `packages/corporate-actions/src/` |

## Bugs the port fixes

**A break-even close was recorded as no profit at all.** The reconciliation ended
`transactionProfit ? round(...) : undefined`, so closing at exactly the cost basis fell
through the truthiness check. The transaction was written with an empty `profit` and
`roi` rather than 0. Now `typeof … === 'number'`.

**A duplicated fill was applied twice.** The injector tracked how much of an order had
already filled in an in-memory `Map`, and deleted the entry when the order reached a
terminal status. A `filled` event delivered by both the websocket and the REST backfill
— which is a normal thing to happen, not an exceptional one — was therefore applied in
full a second time. The same `Map` did not survive a restart, so an injector restarted
between two partial fills re-applied everything the order had filled before it went
down. The already-applied amount is now derived inside the write transaction from the
transactions themselves, making the write idempotent and restart-safe.

**A position transfer could destroy shares.** The two sides were separate writes. A
failure between them debited the origin without crediting the destination. Both sides
now commit in one transaction, and the two position locks are taken in a fixed order so
that two transfers running in opposite directions between the same accounts cannot
deadlock.

**Concurrent fills lost each other.** `internalAppendTransaction` read the profit,
added to it and wrote it back as separate round trips, with three processes doing this
against one database. The write path now takes a row lock on the position, which
serialises everything that follows.

**`listOrderGroups` ignored its `symbol` filter.** It was accepted and validated, then
left out of the query — so narrowing a listing by symbol silently returned everything.
It is now applied as an `EXISTS` against the group's broker orders.

**Deleting an account left dangling rows.** It removed transactions, profits and
positions, but not the order groups and broker orders pointing at it — though its own
doc comment said it removed "order records" too. Foreign keys now cascade, which is
that comment enforced.

**An open limit buy reserved nothing across a restart.** `AlpacaBroker.init` parsed and
validated each open order's `limit_price`, then hard-coded `limitPrice: 0` into the
pending order handed to the tracker. Buying power reserved for an order already working
at the broker was therefore always zero, and the account could be oversubscribed by
exactly the orders it already had out.

**`assertAccountName` let a pipe through.** The pattern `/[^(\w|\s|\(|\))]/` admits a
literal `|` inside the character class, contrary to its own comment ("number, alphabet,
_, space, ()").

**Account ids were slightly biased.** `nanoid` over a 36-character alphabet is fine;
the replacement uses rejection sampling so the first four symbols are not marginally
likelier than the rest.

## Deliberate behaviour changes

**`dec` is now `desc`.** The legacy wire value for descending sort was a misspelling
every caller had to reproduce. This is the only wire-visible rename.

**Responses are objects, never bare arrays.** `GET /accounts` returns
`{ "accounts": [...] }`. An object can gain pagination later; an array cannot.

**The unbounded `listTransactions` is gone.** The legacy service had two: an
`accountId`+`symbol` form that returned everything ever recorded, marked `@deprecated`
in its own source with the note "The api is not scale", and `transactions-v2` carrying
the paged form. The paged form now lives at `/transactions`, so a caller that omits
`from`, `limit` and `sort` gets a 400 rather than a scan of the table.

**`GET /order-group?correlationId=` is gone.** It returned the first match of what is
inherently a list; its own source said "todo: deprecate". Use
`GET /order-groups?correlationId=`.

**The `_OrphanGroup_` sentinel is gone.** An order with no group has a NULL `group_id`,
found through a partial index, rather than a reserved string every query had to exclude
and callers were forbidden from passing.

**Deleting an account cascades.** See above.

## Things deliberately not ported

**The platform underneath.** The legacy service pulled in signed bearer tokens verified
against public keys fetched from S3, a remote policy service, a remote config service,
a metrics pipeline, a task reporter and a message-stream server suite. Fleece has a
single optional bearer token and reads its configuration from the environment. The
`@qinnan/*` packages that provided the rest belong to a platform this port leaves
behind.

**The order-correction layer.** `AlpacaCorrectOrderImpl` synthesised missing `new`
events and deduplicated. The legacy's own final commit on accounts-service removed it
— "avoid using alpaca order correction in order to display the true events received
from broker" — and Fleece deduplicates in two better places anyway: the position
tracker compares against what a session has already applied, and the ledger's fill path
is idempotent.

**Stock splits in the daily job.** `processStockSplit` was already commented out in the
legacy processor under the note "todo: make it idempotent" — applying a split twice
splits the position twice, and the job cannot tell one it has applied from one it has
not. Splits are applied deliberately through `PUT /position/split`, which says as much.

**Mongo TTL indexes.** Broker orders, their records and order groups carried a ten-year
TTL. Postgres has no equivalent, and a ten-year retention window on a system younger
than that is not a policy anything depends on. Add a retention job when the table size
calls for one.

## Vocabulary the legacy left implicit

`OrderGroup` is the renamed `OrderGuard` — the accounts-service README called it "the
advanced order implemented in the order executor service". Its two correlation fields
are set by `order-execution-core`, one per order guard:

```ts
this.groupId = await this.accountClient.createOrderGroup({
  accountId: this.account.accountId,
  correlationType: this.orderGuardType,   // 'ConditionalOrder', 'GridOrder', …
  correlationId: this.orderGuardId,       // that guard instance
});
```

`orderGuardType` is a closed set in `order-execution-types/src/base.ts`: `SimpleOrder`,
`StepProfit`, `TakeProfit`, `ReactiveOrder`, `InstantTransfer`, `ConditionalOrder`,
`SwingOrder`, `GridOrder`, `PortfolioRebalance`.

Worth knowing: the strategy name is *not* in the order group. The execution service
carries it as `traderClass` alongside `orderGuardType` and never passes it on, so the
ledger can say a group was a `GridOrder` but not which strategy wanted one.

A group covers **one trading session**. The execution service creates a fresh guard per
strategy per day — guards read the market calendar and evaluate only between
`marketOpenAt` and `marketCloseAt` — and each creates its group on startup and calls
`closeOrderGroup` on termination. So `status` tracks its guard's life, and a group is
"everything that strategy did that day" rather than something you have to assemble.

## Schema notes

**Prices are `DOUBLE PRECISION`, not `NUMERIC`.** All the arithmetic happens in
TypeScript against IEEE doubles and is bounded by `roundPrice`, exactly as it was under
Mongo. `NUMERIC` would give exact storage of an inexact computation while adding a
string conversion to every read. Moving the arithmetic into SQL is the change that
would make `NUMERIC` worth it, and that is a redesign rather than a column type. **This
is worth revisiting** if the ledger ever sums in the database.

**Dates are `TEXT`, not `DATE`.** Ex-dividend, record and pay dates are market calendar
dates rather than instants, and a `DATE` column comes back through node-postgres as a
JS `Date` at local midnight — the previous day for anyone west of UTC. ISO text sorts
correctly and round-trips exactly, and a `CHECK` constraint enforces the format.

**Position history has no table.** Every transaction records the position size it left
behind, so the history is a projection of `ledger_transaction.cumulative_size`. A second
table could only disagree with it.

## Reversed decisions

**The Alpaca client is no longer read-only.** It was, and this document said so: placing
orders belonged to the execution service, and a ledger that could place orders could
disagree with the broker about what it had done. Porting `@fleece/broker` changed that —
the write path (`createMarketOrder`, `createLimitOrder`, `createOtoOrder`, `cancelOrder`)
now lives in `@fleece/alpaca` alongside the reads, because both halves share one
credential, one rate limit and one base URL. Splitting them would mean two clients
competing for the same quota without knowing about each other. The read/write separation
now lives at the package boundary instead: `injector` depends on the reads, `broker` on
the writes, and `AlpacaActiveSynchronization` takes a narrowed `AlpacaOrderReader` so a
reconciliation job cannot trade.

**`AlpacaActiveSynchronization.register` came back.** It was removed as dead code — its
only caller was the order-placement path, which was out of scope. `AlpacaBroker` is that
caller, so it returned, this time with tests.

**`@fleece/broker` is layered, where the legacy `AlpacaBroker` was one class.** The legacy
did the reservation, the correlation, the send, the poller registration, the tracking
request and the event dispatch in one method per order type. Those are now four layers
over `@fleece/alpaca` — see [packages/broker/README.md](../packages/broker/README.md).
The gain is not tidiness: it is that the two pieces nobody can finish today, the
announcement transport and a margin model for options, are each a component you install
rather than a branch inside a method everything else goes through.

## Known gaps

Summarised here; the ones needing a decision are argued out in
[OPEN-ITEMS.md](./OPEN-ITEMS.md).

**Tracking requests have no way in.** `OrderTrackingFacade.track` is implemented and
tested but has no production caller: the legacy transport was a `lite-server` listening
on the `OrderTracking.{STAGE}` message-stream topic, and that layer is not ported. It is
how the legs of a bracket, OTO or OCO order get attributed — Alpaca creates legs itself
with their own client order ids, so the correlation trick cannot reach them. Until a
transport exists, a leg falls through the holding pen and is booked to the default
account after `FLEECE_UNRESOLVED_ORDER_TIMEOUT_MS`. Nothing is broken today, because the
only client that would send one is `order-execution-service`, which is also unported.

The options considered were an HTTP listener on the injector process, a `PUT /track` on
the API that pre-creates the `broker_order` row at `pending_new` (which would also make
the association survive an injector restart, as the current in-memory map does not), or
adopting a pub/sub hub. Deferred until the execution service lands and can pick.

The *sending* half now exists as a layer of its own: `AnnouncingOrderPlacer` wraps the
placer that encodes the correlation and claims every id a placement produced.
`NoopOrderTrackingClient` is what it is given by default, and warns on every call rather
than staying quiet — a fill attributed to the wrong account is invisible where it happens
and only shows up later as a strategy's P&L being wrong.

**The order router is not ported.** `broker-clients/order-router-impl.ts` and its
selectors choose which broker account an order goes to. Only relevant with more than one
account, and the piece most likely to change when the execution service lands.

## Still to port

`order-execution-service`, `backtest-service`, `ticker-service` and `treasury-service`
all exist in the legacy repositories and all imported `@qnquant/account-types`. Whether
they reach the ledger over HTTP or by importing `@fleece/core` is the same decision
made here for the injector, and can be made again per service.
