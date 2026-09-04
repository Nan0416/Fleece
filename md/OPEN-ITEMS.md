# Open items

Things that need a decision from you, or that you should know are true before
trusting this system with money. Everything here was surfaced while porting; none
of it is a bug report against the port itself, and none of it blocks running the
ledger today.

Ordered by what a wrong answer costs. `md/PORTING.md` records what *changed* from the
legacy; this records what is still open.

---

## 1. Leg orders are attributed from the parent, not from a tracking request

**Severity: medium — was high; the common path is now covered, and what remains is a
judgement rather than a gap.**

**This item changed when multi-leg support landed.** The converter now *flattens* a
composite order: one Alpaca payload becomes one event per order it describes, each leg
naming its parent in `parentBrokerOrderId`, and **every leg inherits the parent's
correlation** — account, group and reservation. A leg therefore arrives already
attributed, gets its own `broker_order` row, and never reaches the holding pen.

A multi-leg parent is dropped rather than converted, so a spread produces rows for its
contracts and none for itself. `parentBrokerOrderId` on those legs therefore names an id
the ledger holds no row for — it groups the legs, it does not resolve.

That covers bracket, OTO and OCO legs too, not just spreads, because legs reach us
nested in practice: the websocket sends no separate event for an OTO's exit leg at all,
and both the REST placement response and `AlpacaActiveSynchronization`'s poll return it
inside its parent.

What this is: a decision that a leg belongs to whoever placed its parent. For a spread
that is a fact — the legs are the spread and cannot be traded apart from it. For a
bracket or an OTO it is an assumption, and a correct one for every order
`@fleece/broker` places, since `placeOto` announces entry and exit under the same
account. It would be wrong only if something upstream placed a composite order whose
legs belong to different virtual accounts, which nothing does.

**What is still open.** `OrderTrackingFacade.track` remains implemented and uncallable —
its transport was a message stream (`TrackingProcessor` bound to `PUT /track` on a
`lite-server` on the `OrderTracking.{STAGE}` topic) that belongs to the platform this
port leaves behind. It still matters for an order Fleece never placed and that Alpaca
reports standalone, which lands in the holding pen for
`FLEECE_UNRESOLVED_ORDER_TIMEOUT_MS` and is then booked to the catch-all account.

The sending half exists: `@fleece/broker` calls `OrderTrackingClient` after every
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

## 2b. Options reach the ledger, but not `@fleece/broker`

**Severity: high if anything places an option through `@fleece/broker` — it would
oversubscribe the account by a factor of 100.**

Numbered `2b` so the existing items keep their numbers; by cost it belongs here.

`@fleece/alpaca` now models option and multi-leg orders, `HttpAlpacaRestClient` can
place a spread, and the injector books each leg with the size scaled by
`OPTION_CONTRACT_MULTIPLIER`. What is *not* done:

- **Reservations are share-shaped.** `SymbolPositionTracker.reserve` holds
  `|size| * unitPrice`, so one contract at 3.85 holds $3.85 against a purchase that
  costs $385. Nothing in Fleece places options through `@fleece/broker` yet, and this is
  the reason not to start. A short option is worse than 100x wrong, not merely 100x: its
  requirement is margin, not premium, and a spread's is the width of the spread rather
  than the sum of its legs.
- **`Broker.order` has no multi-leg request.** `@fleece/alpaca` can place one; the
  reservation model above is what has to exist first.
- **Leg events now reach the tracker.** `AlpacaBroker.consume` dispatches and tracks
  every event the converter returns, legs included, so `SymbolPositionTracker` will start
  keeping entries for option symbols at contract scale — one contract at 3.85, not 100
  units at 3.85. Deliberate: special-casing legs away here would make the class look
  option-aware while its reservations still are not.
- **Startup seeding does not know about spreads.** `AlpacaBroker.init` seeds the tracker
  from `listOrders({ status: 'open' })` and calls `toPendingOrder` on every result. An
  open multi-leg parent has an empty symbol and no side, so it seeds an entry keyed on
  `''` with a negative size — the same shape of bug the injector's `applySpreadFill`
  exists to prevent, in the package that has no consumer yet. Fixing it in isolation
  would make `@fleece/broker` look option-safe while its reservations still are not,
  which is why it is written down rather than patched.
- **Adjusted contracts are assumed to be 100.** A split or a merger can leave a contract
  delivering something other than 100 shares. Alpaca reports the real figure on the
  option contract, and `getOptionContract` will fetch it — but the fill path uses the
  constant, because reading it means a lookup per fill and a cache with an invalidation
  story. An adjusted contract booked today is silently wrong by the ratio of its real
  multiplier to 100.
- **Positions read in units of the underlying.** One contract shows as `100`, which is
  what makes `size * price` dollars and equity P&L comparable. Anyone reading a position
  listing sees shares-equivalent, not contracts.

| Option | Trade-off |
| --- | --- |
| Leave `@fleece/broker` equity-only, and say so | Free; the gap stays until the execution service lands |
| Teach the tracker an asset class and a multiplier | Fixes long options; short options still need real margin rules |
| Reserve options against a margin model | Correct, and the largest piece of work here |

**Recommendation: the first, until something actually places an option order.** The
ledger side is what the recorded payloads proved out; the reservation side has no caller
to prove anything against, and guessing at margin rules with nothing exercising them is
how the wrong rule ships unnoticed.

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
- **Option chain browsing.** `getOptionContract` reads one contract by symbol, which is
  what placing and pricing an order needs. Listing a chain — `/v2/options/contracts`
  with its filters and paging — is a market-data concern and belongs with
  `@fleece/marketdata` if anything ever needs it.
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
