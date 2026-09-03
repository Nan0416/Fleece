# Open items

Things that need a decision from you, or that you should know are true before
trusting this system with money. Everything here was surfaced while porting; none
of it is a bug report against the port itself, and none of it blocks running the
ledger today.

Ordered by what a wrong answer costs. `md/PORTING.md` records what *changed* from the
legacy; this records what is still open.

---

## 1. Leg orders are attributed to the wrong account

**Severity: high — produces a wrong number, silently.**

`OrderTrackingFacade.track` is implemented and tested but nothing can call it. Its
transport in the legacy was a message stream — `TrackingProcessor` bound to `PUT /track`
on a `lite-server` listening on the `OrderTracking.{STAGE}` topic — and that layer
belongs to the platform this port leaves behind.

It is the **only** mechanism by which the leg of a bracket, OTO or OCO order gets
attributed. Alpaca creates legs itself and assigns them client order ids of its own, so
the correlation encoded into the parent cannot reach them. Without a tracking request a
leg's events sit in the injector's holding pen for `FLEECE_UNRESOLVED_ORDER_TIMEOUT_MS`
and are then booked to the catch-all account — so the strategy that placed the order
shows the entry and not the exit, and the catch-all shows an exit belonging to nobody.

Nothing is wrong *today*, because the only thing that would send a tracking request is
`order-execution-service`, which is not ported either. This becomes real the day it is.

The sending half now exists: `@fleece/broker` calls `OrderTrackingClient` after every
placement, and `NoopOrderTrackingClient` warns on every call rather than staying quiet.

| Option | Trade-off |
| --- | --- |
| HTTP listener on the injector process | Closest to the legacy shape. Injector grows a server and a port |
| `PUT /track` on the API, pre-creating the `broker_order` row at `pending_new` | No new process surface, and see below |
| Adopt a pub/sub hub | Truest to the original; you chose standalone for now |

**Recommendation: the second.** An association is "broker order X belongs to account A,
group G", which is *identical* to a `broker_order` row minus a status. Pre-creating that
row means the injector's existing `existing?.accountId` lookup resolves it with no new
code path, the in-memory `associations` map disappears, and item 5 below goes away too.
The cost is a row for an order the broker might reject, sitting visibly at `pending_new`.

---

## 2. A fill is dropped if its order group has been deleted

**Severity: high — produces a wrong number, silently.**

If an event arrives naming a group that no longer exists,
`BrokerOrderService.createBrokerOrder` throws `NotFoundError`, `AsyncQueue` catches it,
logs at error and moves on — and **the fill is never recorded**.

The realistic route is deleting an order group while its orders are still live: the
delete cascades away the broker orders, and the next event for one of them tries to
create it fresh against a group that is gone.

It needs an unusual operator action to trigger, but "a fill silently does not get
recorded" is the exact failure this system exists to prevent, and the current behaviour
is a log line nobody is watching.

| Option | Trade-off |
| --- | --- |
| Refuse to delete a group with non-terminal orders | Simple; the operator has to close the group first |
| Record the order as an orphan instead of dropping it | The fill lands, attribution is wrong but visible via `broker-order orphans` |
| Both | Refuse the delete, and orphan anything that slips through |

**Recommendation: both.** They address different halves — one stops the cause, the other
stops the loss.

---

## 3. Money is stored as `DOUBLE PRECISION`

**Severity: medium — a considered choice you should get a say on.**

Prices and sizes are `DOUBLE PRECISION`, not `NUMERIC`. The reasoning, from
`migrations/001_initial.sql`: all arithmetic happens in TypeScript against IEEE doubles
and is bounded by `roundPrice`, exactly as it did under Mongo, so `NUMERIC` would give
exact *storage* of an inexact *computation* while adding a string conversion to every
read.

That holds while the arithmetic stays in TypeScript. It stops holding the moment
anything sums in SQL — a reporting query totalling realised profit over a year would
accumulate error `NUMERIC` would not.

**Recommendation: leave it, and revisit before writing the first aggregate query.** It is
a migration plus a row-parser change, not a redesign, and doing it speculatively costs
precision-free reads for no gain today.

Dates are ISO `TEXT` rather than `DATE` for a different and firmer reason: they are
market calendar dates, and a `DATE` column comes back through node-postgres as a JS
`Date` at local midnight, which is the previous day for anyone west of UTC. That one I
would not revisit.

---

## 4. A market order with no price estimate reserves nothing

**Severity: medium — inherited from the legacy, preserved deliberately.**

`MarketOrderRequest.unitPrice` is optional, and when it is absent the reservation holds
zero buying power. Two concurrent market buys can then both pass `test()` and the
account is oversubscribed — which surfaces as the broker rejecting the second, or worse,
accepting both.

The legacy had the same gap. It is preserved rather than fixed because the fix is a
judgment call: refusing the order outright is safest but breaks any caller that places
market orders without a quote to hand, and estimating a price inside the broker means
guessing.

The tracker logs a warning naming the order whenever it happens.

| Option | Trade-off |
| --- | --- |
| Make `unitPrice` required on market orders | Safest; callers must have a quote |
| Fetch a quote when it is missing | Adds a market-data dependency and latency to the order path |
| Reserve against a configured worst-case multiple of the last known price | No new dependency; the multiple is a guess |

**Recommendation: make it required** when you port the execution service — it always has
a price in hand at that point, so the constraint costs nothing there.

---

## 5. The injector forgets its pending attributions on restart

**Severity: medium.**

`OrderTrackingFacade` holds two `Map`s in memory: `associations` (tracking requests for
orders not yet seen) and `held` (events waiting for an account). A restart loses both. A
tracking request that arrived just before a restart is gone, and its order will be booked
to the catch-all.

The legacy had the same property. Fixing item 1 with the second option fixes this too,
which is the main argument for that option.

---

## 6. An externally placed order first seen as `filled` never reaches the broker tracker

**Severity: low-medium, and one of two places the same trade-off appears.**

`SymbolPositionTracker.track` ignores a terminal event that has no reservation, because
the common cause is a very late duplicate of something the REST backfill already applied
— and applying it twice would double the position.

The cost is that an order placed by hand on the broker's website which we first see as
`filled` is not reflected in the tracker's view of the account. The ledger still records
it (the injector's path is separate and books it to the catch-all account), so this is
tracker drift, not a wrong ledger. It self-corrects on the next restart, when the tracker
re-seeds from the broker.

The same trade-off appears in `adoptPendingOrder`, which treats an unknown order's
already-filled quantity as a baseline: correct for an order open before startup, and an
under-count for one whose early events were all missed. Both choose under-counting over
double-counting, deliberately, and both are documented at their call sites.

**Recommendation: leave both.** Reconciling the tracker against the broker periodically
would close them properly, and is worth more than patching either in isolation.

---

## 7. Nothing runs the tests

**Severity: medium — cheap to fix.**

There is no `.github/` directory, so PR #1 merged with **zero checks**. 266 tests exist
and nothing runs them but you, by hand.

**Recommendation: add a workflow** running `npm run build`, `npm run lint`,
`npm run format:lint` and `npm test`, with a PostgreSQL service container and
`FLEECE_TEST_DATABASE_URL` set so the 24 integration suites actually run — they are the
ones covering the locking and idempotency, and they are exactly the tests that skip
silently when nobody configures them.

---

## 8. Operational prerequisites nothing enforces

**Severity: low, but each is a confusing first five minutes.**

- **The default accounts must exist** before the injector can book an unclaimed order.
  `FLEECE_DEFAULT_PAPER_ACCOUNT_ID` and `FLEECE_DEFAULT_LIVE_ACCOUNT_ID` default to
  `0000000001` and `0000000002`, and nothing creates them. If they are missing, the
  injector logs an error per orphan and drops it. `dev.md` says to create them; the
  injector could check at startup instead.
- **The API is unauthenticated and accepts any origin** unless `FLEECE_TOKEN` and
  `FLEECE_CORS_ORIGINS` are set. Both warn on every start. Fine on a laptop; not fine
  anywhere a browser you do not control can reach it.
- **Nothing expires.** The legacy carried ten-year Mongo TTL indexes on broker orders,
  their records and order groups. Postgres has no equivalent and no retention job was
  written, on the grounds that a ten-year window is not a policy anything depends on.
  `broker_order_record` is the one that grows without bound — one row per broker event.

---

## 9. Not ported

Recorded so their absence reads as a decision:

- **The order router** (`broker-clients/order-router-impl.ts` and its selectors, ~250
  lines) chooses which broker account an order goes to. Only matters with more than one
  account, and the piece most likely to change when the execution service lands.
- **Splits in the daily job.** Applying one is not idempotent and the job cannot tell a
  split it has already applied from one it has not — the legacy had the code commented
  out under "todo: make it idempotent". Applied by hand through `PUT /position/split`.
- **OCO and OTOCO orders.** The legacy `Broker` interface declared them; nothing ever
  implemented them.
- **`reservationId` is decoded and ignored.** It is the placing process's own bookkeeping
  and the ledger has no use for it, but the field is kept so the wire format is
  documented and the execution service can encode it.
- **Nothing is published to npm**, and there is no release process. mini-cloud publishes
  `shared` and `reporter` and tags releases; if anything here is ever imported by a
  launched program, it will need the same.

---

## 10. Housekeeping

- **The legacy repos are still under `allworldautomation`**, not `Nan0416`. 43 are cloned
  to `/Users/nan/workplace/alpaca-legacy/`, and `md/PORTING.md` refers to them by org.
  Those references will need updating once the migration finishes.
- **`port/accounts-service` still exists** on the remote and locally, merged.
