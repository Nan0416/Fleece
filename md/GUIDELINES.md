# Fleece — engineering guidelines

The conventions this codebase follows, and why. Where a rule exists to prevent a
specific bug, the bug is named — a rule you can't justify is a rule that gets ignored.

Fleece is a ledger. Its failure mode is not a crash but a number that is quietly wrong,
and most of what follows exists because of that.

## Structure

1. **One monorepo, nine packages.** `shared` (models, contracts, utilities), `core`
   (the ledger), `service` (the HTTP API), `client` (typed client), `alpaca` (broker),
   `broker` (order placement), `marketdata` (Polygon), `injector` (broker events in),
   `corporate-actions` (the dividend job). A package exists when something needs to be
   installed separately — `core` is separate from `service` because the injector and
   the dividend job need the ledger without pulling in Express.
1a. **A runnable package has a `src/main.ts` and no arguments.** Configuration comes
   from the environment, so there is one place a setting can come from rather than two
   with a precedence rule between them. There is no CLI: Node runs TypeScript directly,
   so an ad-hoc run is a script with the values in it.
2. **Dependencies point one way**: `service`/`injector`/`corporate-actions` → `core` →
   `shared`; `injector` → `alpaca`; `broker` → `alpaca`; `corporate-actions` →
   `marketdata`; `client` → `shared`. Nothing imports upward, and `shared` imports
   nothing of ours.
3. **Every package declares its dev tooling, at the same range as the root.**
   `typescript` is `^5.7.3` everywhere, so npm resolves one copy and the whole repo
   compiles with one compiler. `npm i -D typescript` in one workspace takes `latest`,
   and npm answers the conflict by nesting a second compiler under that package — where
   it silently wins for every build and editor session in that folder. Check with
   `find . -type d -path '*node_modules/typescript'`: one path.
4. **Layers**: in `core`, `services` answer requests and hold the rules, `data` talks
   to Postgres. In `service`, `routes` parse and delegate. A route never touches a DAO.

## The ledger

5. **Anything that reads a position and writes it back holds the row lock.** Three
   processes write to this database concurrently by design. `lockPosition` creates the
   row if it is missing — `SELECT ... FOR UPDATE` locks nothing at all when there is no
   row, so two first fills would both read flat and one would be lost.
6. **Everything a fill touches commits together.** Position, profit and the transaction
   are one write or none; a crash between them leaves a ledger that does not add up.
   That is why they are one DAO: a transaction cannot span DAOs without handing
   transaction control to the caller, which is how it ends up forgotten.
7. **Applying a broker's fill report is idempotent.** Brokers report cumulative
   progress, not deltas. How much is new comes from `order_fill_progress`, read and
   advanced inside the same database transaction and under the same lock as the
   transaction row it counts — never from a counter held in memory. The legacy in-memory
   counter double-counted a redelivered `filled` event and double-counted everything
   again after a restart mid-order.
7a. **`writeFill` is the only thing that writes a `ledger_transaction`.** That is what
   makes a stored progress counter safe rather than a second version of the legacy bug:
   there is no path that appends a transaction without advancing the counter in the same
   statement pair. A new write path comes through it. `reconcileOrderFillProgress`
   re-derives the counters from the log and reports disagreement — the guarantee that
   came free while the figure was summed on every read, and that has to be asked for now
   that it is stored.
8. **Guards belong in the SQL, not around it.** Where a write must not happen twice,
   the condition goes in the statement — `INSERT ... ON CONFLICT DO UPDATE` records a
   broker order idempotently, so two events for it cannot each decide the row was
   missing. A read-then-write loses that race.
8a. **An order's virtual account is written once.** Nothing offers a way to change it.
   Every `ledger_transaction`, `position`, `profit` row and `order_fill_progress`
   counter it produces is keyed by that account, so moving the order alone strands all
   of them and makes the next cumulative fill report book the whole order again — which
   `reconcileOrderFillProgress` cannot detect, because both accounts stay internally
   consistent. The legacy raised a fatal-error metric on a mismatch rather than fixing
   it up. A mis-booked order is corrected by transferring the **position**, which is
   double-entry and leaves both sides an audit trail.
8b. **Do not store what a stored column already determines.** An order's account was
   briefly accompanied by an `attribution` recording *how* it was decided. Nothing
   branched on it: a leg's account comes from its parent, which `parent_broker_order_id`
   already says; an order Fleece placed says so in the `client_order_id` kept verbatim
   in `broker_order_record`; and an order nobody claimed is one in a configured catch-all
   account, which is a fact about that account. A column repeating any of those is a
   second place for the same fact to be wrong.
9. **Take locks in a fixed order.** A transfer locks both positions sorted by account
   id, so two transfers running in opposite directions between the same pair cannot
   deadlock. Postgres would detect the cycle and abort a victim rather than hang, but
   an aborted transfer is still a failed transfer.
10. **Derive rather than store.** Position history is a projection of
    `ledger_transaction.cumulative_size`; dividend status is a function of four dates
    and today. A stored status is correct the day it is written and wrong every day
    after, because nothing revisits it.
11. **Extract the arithmetic into a pure function.** `position-reconciliation.ts` has
    no store, no clock and no logger, so cost-basis accounting can be tested
    exhaustively without a database. It is the single most important file here.
12. **Money and sizes are `Decimal`, never `number`.** A ledger's failure mode is a
    number that is quietly wrong, and IEEE 754 supplies them: `0.1 + 0.2` is not `0.3`.
    `Decimal` in `@fleece/shared` is a private `decimal.js` constructor — `clone`, not
    `set`, so nothing else in the process can reconfigure the arithmetic — and it
    serialises as a **string**, because a JSON number is a double and would undo all of
    this at the process boundary. `NUMERIC(28, 9)` columns come back as strings for the
    same reason.
12a. **Positions and transactions store total cost, never a unit price.** Adding to a
    position is then addition and closing one out is subtraction, both exact. A stored
    unit price has to be divided out on every write and fed into the next one, which is
    how a cost basis drifts. Average price, premium and ROI are projections computed on
    read, in `derivations.ts`.
12f. **A division names its scale and conserves its residue.** Apportioning a basis
    across a partial sale is the one unavoidable division; wherever it happens, one side
    is rounded and the other is derived from it with a `sub`, never a second division.
    Closing out entirely is special-cased to take the whole basis, because the general
    formula would round a value that is exactly known. What this buys is an invariant
    that holds exactly rather than approximately, and that the tests assert:
    `position.total_cost == sum(transaction.total_cost) + sum(transaction.profit)`.
12g. **Nothing is rounded on the way in.** `Decimal.toString()` collapses negative zero,
    which closing a position at exactly its cost basis produces and which reads as "-0"
    anywhere a number is rendered.

## Reservations

12b. **Reserve before sending, release when the send fails.** Many strategies place
    orders through one real broker account. Without a hold taken before the request goes
    out, each reads the same buying power, each concludes it can afford its order, and
    the account is oversold. The `try`/`catch` around the placement that calls `cancel`
    is not defensive tidiness — without it a run of failed placements silently exhausts
    the account.
12c. **Direction decides what is scarce.** Reducing a position holds *shares*; increasing
    one holds *buying power*. `hasDifferentSign` against the current position is what
    picks, and it returns false against a flat position, so opening always holds cash.
12d. **A fill draws on its own reservation before the account.** An order that reserved
    1700 and fills 672 worth consumes the reservation, not the balance — the balance gave
    that 1700 up at reservation time. Only the excess reaches the account. Getting this
    backwards double-counts every fill.
12e. **Released holds must be given back on any terminal status, not just on a fill.**
    A cancelled sell that keeps its shares locked makes the account progressively
    untradable, and nothing reports it.

## Configuration

13. **One file per package reads `process.env`.** `stage-config.ts` in `service`,
    `injector-config.ts` in `injector`, `corporate-actions-config.ts` in the job.
    Everything else receives configuration through its constructor, which is what makes
    components testable without setting environment variables.
14. **Every setting has a default, except a credential.** Importing a package must
    never throw for missing configuration. `FLEECE_ALPACA_KEY` and
    `FLEECE_POLYGON_API_KEY` are the exceptions: a default would turn "misconfigured"
    into a job that runs to completion having recorded nothing, which looks like
    success.
15. **Command-line overrides are resolved where the config is loaded**, not applied to
    an already-started server, so one place decides flag-over-environment precedence.
16. **The permissive defaults announce themselves at startup.** No token means no
    authentication and `*` means any origin; both log a `warn` on every start, because
    a service that can move positions between accounts should say so where the operator
    is already looking rather than only in a document.

## Types

17. **All interface properties are `readonly`.**
18. **Never use `as`.** Validate at trust boundaries with the assertion helpers in
    `@fleece/shared`. ESLint enforces this; the sanctioned exceptions are the
    client/server type boundary and the two places where a broker's schema meets ours,
    each carrying an inline justification naming what *is* checked.
19. **Prefer explicit narrowing to truthiness.** `typeof x === 'number'`, not `x` — a
    realised profit of 0 is a fact, and treating it as absent is precisely the bug the
    legacy break-even close had.
20. **Named interfaces for structured returns.** No inline `Promise<{ a: string }>`.

## API contracts

21. **One Request and one Response interface per public service method**, both in
    `shared/src/api/`, both used by the service and every caller. Empty ones are `{}`
    on purpose: naming the contract gives it somewhere to grow. Operations that are not
    HTTP endpoints — applying a fill, recording a dividend — declare their pair in
    `core/src/services/` instead, so `client` never imports a type it cannot use.
22. **Never return a bare array.** Wrap it: `{ transactions: [...] }`. An object can
    gain pagination later; an array cannot.
23. **A listing takes `from`, `limit` and `sort`, all required.** Defaulting them
    reintroduces the unbounded scan that the deprecated legacy endpoint was.
24. **A restriction that exists for an index says so.** The "exactly one search
    property, plus a time window" rule on broker orders is not taste: each property has
    an index paired with `created_at`, so one property plus a window is a range scan and
    anything else is a table scan. The error message says which properties to pick from.

## Data layer

25. **DAO interface plus implementation, in separate files**, named for the class:
    `ledger-dao.ts` declares `LedgerDao`, `pg-ledger-dao.ts` implements `PgLedgerDao`.
26. **DAOs define their own input types** — flat, matching columns, not the API shape.
    They *return* the shared domain model rather than a per-DAO copy of it.
27. **Migrations are append-only.** `<sequence>_<name>.sql`, applied in ascending
    numeric order, each in its own transaction together with its bookkeeping row. Never
    edit one that has shipped. The runner rejects an unparseable or duplicated sequence,
    because the two ways to get this silently wrong — `readdirSync` order varying by
    filesystem, and `.sort()` putting `10_` before `2_` — both produce a schema that
    differs between machines rather than an error.

## Errors

28. **Throw a specific `AppError` subclass**, never a bare `Error`, for anything a
    caller could plausibly cause. A bare `Error` means a bug and surfaces as a 500 with
    the detail logged, not returned.
29. **A violated invariant is an `InternalServiceError`, not an `InvalidRequestError`.**
    A CHECK constraint already guarantees the column values, so a row that fails
    `toAccountStatus` means the schema and the code have diverged — which no caller can
    cause and none can fix.
30. **Error messages say what to do next.** "Account MOMENTUM01 already exists. Choose a
    different id, or omit it to have one generated." — not "duplicate key".
31. **Say what will be lost before destroying it.** Deleting a live account names the
    positions, profits and transactions that go with it, so `--force` is an informed
    choice rather than a way past an obstacle.

## Logging

32. **Log at decision points**, not just failures: which account a fill was attributed
    to and why, state transitions, before and after anything crossing the network.
33. **Loggers are named after their class**, which is what makes output greppable when
    the API, injector and job all write at once.
34. **Periodic work logs at `debug`.** The injector's poll runs every second.
35. **Never log a credential or a URL that carries one.** The Polygon key travels in the
    query string, so its failures log the path, not the URL.

## Failure handling

36. **A background loop never lets one failure kill the loop.** Catch, log, continue —
    one symbol failing to look up must not abandon the rest of the dividend run, and one
    unconvertible event must not take down the feed.
37. **Drain before shutting down.** An event accepted but not yet written is a fill
    nothing will report again.
38. **Do not reconnect to a rejected credential.** Bad keys will not fix themselves, and
    retrying hammers the broker with something already refused.
39. **Treat the broker's stream as lossy.** Alpaca does not replay what it dropped
    while a socket was down, and a missing fill is a position that is silently wrong
    from then on. That is what `AlpacaActiveSynchronization` is for.

## Testing

40. **A test name states the property, not the mechanics.** "uses the close of the day
    before the ex-dividend date, not the position today", not "test processDividend".
41. **`tests/` mirrors `src/`.** Files that are not suites — fixtures, fakes, helpers —
    are named anything but `*.test.ts` and sit beside the tests that use them.
42. **`tests/data-integration/` is the exception**, holding suites that need a real
    PostgreSQL. They skip themselves when `FLEECE_TEST_DATABASE_URL` is unset, so a
    directory listing says which tests always run.
42a. **Each integration suite names its own Postgres schema.** Jest runs suites in
    parallel workers, so two of them sharing one database truncate each other's rows
    mid-test — which fails intermittently and for a reason that looks nothing like the
    cause. A `search_path` pointing at one schema gives each suite a private copy of
    every table. Adding a third suite means picking a third name.
43. **Prefer a fake that stores what it is given over a mock that records calls.** The
    order-tracking facade is almost entirely sequencing; a test asserting on call
    arguments restates the implementation and passes just as happily when the order is
    wrong. Fakes implement the real rule wherever a caller depends on it — notably that
    a group is only ever set on an order that has none.
44. **A concurrency test must fail without its guard.** Verify that by removing the
    guard and watching it go red; a test that passes either way is decoration.
45. **Freeze the clock rather than sleeping.** Anything expressed in wall-clock time
    takes a `now` argument or a fixed reference date.

## Style

46. **Always brace `if` bodies.**
47. **`import type` at the top of the file.** Never inline `import('pkg').Type`.
48. **Comments explain why.** The code already says what it does; a comment earns its
    place by recording the reasoning that is not recoverable from reading it. In this
    codebase that most often means naming the wrong number a rule prevents.
