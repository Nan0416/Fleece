# Open items

Things that need a decision from you, or that you should know are true before
trusting this system with money. Everything here was surfaced while porting; none
of it is a bug report against the port itself, and none of it blocks running the
ledger today.

Ordered by what a wrong answer costs. `md/PORTING.md` records what *changed* from the
legacy; this records what is still open.

---

## 0. `@fleece/broker` is ported

**Resolved — `npm run build`, `npm test` and `npm run build:all` are all green, and
`broker` is in every one of them.**

The schema redesign — exact decimals, total-cost accounting, asset classes, legs, stored
fill progress, no order groups — has now landed in `broker` too. Its reservations
account in `Decimal` and in **total cost**, so the one division the legacy did on every
event (dividing a fill's cost back out into a unit price to feed the next one) is gone;
`unitCost` is derived on read and never fed back in.

It was not ported by translating the arithmetic, which item 2b warned against. What
changed instead is where the line falls between what a reservation can price and what it
cannot — see item 2b, which is now about the half that remains.

The CLI was deleted rather than ported. Each runnable package now has a `src/main.ts`
that reads its configuration from the environment; Node 22 runs TypeScript directly, so
an ad-hoc run is a script with the values in it. Nothing was lost but argument parsing.

**The wire format** was the one decision rather than a translation, and it is settled:
decimals cross as **strings** in both directions. The service refuses a JSON number where
a decimal is expected and says to send a string; the client revives responses field by
field with `packages/shared/src/api/wire.ts`, which retired the sanctioned `as` that
guideline 18 used to allow at that boundary.

One boundary still goes through a `number`: `@fleece/alpaca`'s placement inputs take
`size` and `limitPrice` as numbers and write them back out with `toString()`. That
round-trips exactly for any value with fifteen significant digits or fewer, which no
share count or price approaches — but the honest fix is for those inputs to take strings,
and it belongs in that package.

---

## 1. Leg orders are attributed from the parent, not from a claim

**Severity: low — was high, then medium. The common path is covered by the correlation,
the transport for everything else now exists, and what remains is a judgement.**

**This item changed when multi-leg support landed.** The converter now *flattens* a
composite order: one Alpaca payload becomes one event per order it describes, each leg
naming its parent in `parentBrokerOrderId`, and **every leg inherits the parent's
correlation** — the virtual account and the reservation. A leg therefore arrives already
attributed, gets its own `broker_order` row naming that parent, and never reaches
the holding pen.

A composite parent is converted too, ahead of its legs, so a spread produces a row for
itself and one per contract. The parent books no fill — it trades no instrument and its
price is the package's signed net — but it is the id a placement returns, a cancel names
and a tracking request claims, and it carries the net price the spread was actually
traded at, which exists nowhere else.

That covers bracket, OTO and OCO legs too, not just spreads, because legs reach us
nested in practice: the websocket sends no separate event for an OTO's exit leg at all,
and both the REST placement response and `AlpacaActiveSynchronization`'s poll return it
inside its parent.

What this is: a decision that a leg belongs to whoever placed its parent. For a spread
that is a fact — the legs are the spread and cannot be traded apart from it. For a
bracket or an OTO it is an assumption, and a correct one for every order
`@fleece/broker` places, since an OTO placement announces entry and exit under the
same account. It would be wrong only if something upstream placed a composite order whose
legs belong to different virtual accounts, which nothing does.

**The transport now exists.** `PUT /track` on the tracking service is what the legacy
message stream was: `TrackingProcessor` bound to `PUT /track` on a `lite-server` on the
`OrderTracking.{STAGE}` topic, minus the platform. A claim names some broker order ids
and an account; the endpoint parses it and enqueues it onto the same queue the broker's
events use, so an order's events and a claim about that order can never be decided
concurrently. It answers `202`, because at that point the claim is ordered rather than
applied.

Both halves are wired: `L2BrokerOrderClient` claims every id a placement produced, through
`@fleece/client`'s `TrackingClient` passed straight in. `NoopOrderTrackingClient` is what
a process gets when no tracking service is configured — a supported configuration, since
anything placed through `@fleece/broker` carries its account in the correlation anyway.

Of the three options below, this is the first. The second remains the better answer to
item 5 and is now a smaller change than it was: the endpoint exists, and what would
change is what `processTrackingRequest` does with a claim for an order it has not seen —
write a `broker_order` row at `pending_new` instead of remembering it in a map.

| Option | Trade-off |
| --- | --- |
| **HTTP listener on the tracking service** | **Chosen.** Closest to the legacy shape. The process grows a port |
| `PUT /track` on the API, pre-creating the `broker_order` row at `pending_new` | Durable across a restart — see item 5 — at the cost of a row for an order the broker might reject |
| Adopt a pub/sub hub | Truest to the original; you chose standalone |

Note what a durable claim must *not* become: a way to move an order between accounts
later. An order's account is written once, because everything it produces is keyed by it
— see the note on `broker_order` in `001_initial.sql`. The value of writing it early is
that the order is attributed *before* any fill is booked, which is the only moment
attribution is free.

---

## 2. A fill is dropped if its order group has been deleted

**Resolved — order groups no longer exist.**

`BrokerOrderService.createBrokerOrder` used to throw `NotFoundError` when an event named
a group that had been deleted, `AsyncQueue` caught it, logged at error and moved on, and
the fill was never recorded. Deleting a group while its orders were live was the
realistic route in.

The schema redesign removed the `order_group` table, the cascade from it to
`broker_order`, and the correlation columns it carried. There is no longer a row whose
absence can reject a fill. What the group used to answer — which orders belong together
— is `parent_broker_order_id`, which is indexed and deliberately carries **no foreign
key** for exactly this reason: a leg reaching us without its parent must land, and a
foreign key would turn that into a rejected row, reintroducing this bug in a new place.

---

## 2b. Options are priced by `@fleece/broker`, except where they cannot be

**Severity: low — was high. The 100x error is gone, and what is left is refused at the
call rather than approximated.**

**The ledger half was already done**; the reservation half now is too, and the split
between them turned out to be the useful distinction:

- **What a fill cost is knowable, always.** A contract quoted at 3.85 moved $385, and
  `eventContractMultiplier` in `@fleece/shared` is the single place that figure comes
  from — the ledger's fill path and the tracker's both call it. Two copies of that rule
  would be two places for the account's view of itself to diverge from the ledger's.
- **What an order will *require* is knowable only sometimes.** Buying is priced: it costs
  premium times multiplier times contracts. Reducing is priced: it hands units back.
  Writing a short option is not — its requirement is margin against a loss that is
  unbounded for a naked call, and a spread's is the width rather than the sum of its
  legs.

So `SymbolPositionTracker.reserve` holds `|size| x unitPrice x multiplier`, and
**refuses** an order that opens or extends a short position in anything but an equity,
in `test` as well as in `reserve` so nothing is told an order is possible that reserving
would reject. Refusing rather than holding the premium is the point: a premium-shaped
hold on a short call is a number that looks like an answer.

Also fixed here, both of them the same shape of bug — a composite parent has no
instrument, and treating its empty symbol as a value opens a position keyed on nothing:

- **Startup seeding.** `L3BrokerOrderClient.init` now expands open orders through their legs and
  drops composite parents, so an open spread seeds its two contracts rather than one
  position keyed on `''` whose size is signed from a side that means nothing.
- **Event tracking.** `AccountBrokerTracker.track` drops an event with no symbol for the
  same reason. Its legs arrive as events of their own and carry the real dollars; the
  parent's price is the package's signed net and belongs to no position.

**`Broker.order` now places a spread.** It returns one handle for the placement carrying
a read-only view of each contract — the same shape `broker_order` stores, and the only
shape the broker supports, since a leg of a spread cannot be cancelled on its own.
Nothing is held against it: `AccountReservations.hold` returns no reservation for a
spread and says so, and the contracts are named to the tracker at placement so their
fills are still applied. A spread's requirement is the width rather than the sum of its
legs, and no model here computes that.

| What is left | Where it stands |
| --- | --- |
| A short option cannot be reserved | Refused at `reserve`, with a message naming this item |
| A spread is placed with nothing held | Warned at the placement; the account can be oversubscribed by one |
| Adjusted contracts still default to 100 | `ReservationRequest.multiplier` overrides it, and nothing looks one up per fill |

**Recommendation: leave short options refused and spreads unheld until something places
them in anger**, then add a margin model against a caller that can exercise it. Guessing
at margin rules with nothing exercising them is how the wrong rule ships unnoticed. The
layering is what makes that a later addition rather than a rewrite: reservations are a
collaborator of `L3BrokerOrderClient`, not a step inside it, so a model that can price a spread
is a new implementation rather than a change to the placement path.

---

## 3. Money is stored as `DOUBLE PRECISION`

**Resolved — every money and size column is now `NUMERIC(28, 9)`.**

Arithmetic happens in TypeScript against `Decimal` in `@fleece/shared`, a private
`decimal.js` constructor that reads and writes those columns as text so nothing is lost
in either direction. Positions and transactions store **total cost** rather than a unit
price, which removes division from every path but one and makes the conservation
invariant exact; `roundPrice` and its magnitude-driven precision are gone.

`@fleece/broker`'s reservations are converted too: they account in `Decimal` and in
total cost, so the account's view of a position and the ledger's are computed by the same
function from the same numbers.

Dates remain ISO `TEXT` rather than `DATE`, for the unchanged reason: they are market
calendar dates, and a `DATE` column comes back through node-postgres as a JS `Date` at
local midnight, which is the previous day for anyone west of UTC.

---

## 4. A market order with no price estimate reserves nothing

**Severity: medium — inherited from the legacy, preserved deliberately.**

`MarketOrderRequest.unitPrice` is optional, and when it is absent the reservation holds
zero buying power — for an option too, which is the one place this now bites harder than
it did: a short option is refused outright, but an unpriced option *buy* still holds
nothing. Two concurrent market buys can then both pass `test()` and the
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

## 5. The tracking service forgets its pending claims on restart

**Severity: medium, and now reachable — the endpoint that accepts a claim exists, so
this is no longer hypothetical.**

`OrderTrackingFacade` holds two `Map`s in memory: `associations` (claims for orders not
yet seen) and `held` (events waiting for an account). A restart loses both. A claim that
arrived just before a restart is gone, and its order will be booked to the catch-all.

The legacy had the same property. The fix is to write the claim rather than remember it —
option two under item 1 — which is now a change to one method rather than a new endpoint
and a new transport.

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

**Resolved — `.github/workflows/ci.yml` runs on every pull request and every push to
`main`.**

It runs `npm run build`, `npm run lint`, `npm run format:lint` and `npm run test:ci`
against a PostgreSQL service container, in that order. Three details are the point of it
rather than incidental:

- **The build runs first, and is the authority on whether the code compiles.** `npm test`
  is not: ts-jest keys its cache on a file's own content, so a change to a shared package
  leaves every importer cached and suites go green against types that no longer exist.
  `test:ci` also passes `--no-cache`, so neither hazard survives.
- **A skipped suite fails the run.** The integration suites skip themselves without
  `FLEECE_TEST_DATABASE_URL`, and jest reports that as `success: true`. A run that tested
  none of the locking, idempotency or client round-trip behaviour would otherwise be
  indistinguishable from a green one. `scripts/assert-suites-ran.js` reads the JSON jest
  already writes and fails when any suite ran nothing.
- **`@fleece/broker` is in the main job.** It used to have one of its own, allowed to
  fail, because it did not compile against the redesign. It compiles now and is folded
  back in — a permanently red check is one people learn to ignore. `npm run build:all` is
  *not* run here and cannot be: it type-checks `playground` too, whose scripts import a
  gitignored `credentials.ts` holding real broker keys. It is a laptop command.

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
