# Fleece

A virtual-account ledger over a real broker account. Every order goes through one
Alpaca account, but each strategy trades under its own virtual account, so per-strategy
P&L falls out of a single brokerage statement. Node 22, TypeScript, PostgreSQL.

## Shape

An npm-workspaces monorepo, six packages under `packages/` (plus `playground`):

| Package | What it is |
| --- | --- |
| `utilities` | Exact decimals, the clock, logging, environment reading, assertions, error types, the HTTP client seam. Imports nothing of ours |
| `models` | The domain model — accounts, positions, orders, broker events — and in `api/` the request and response contracts written against it |
| `client` | Typed client for the Fleece HTTP API |
| `broker` | Places orders, in layers: correlation, announcement, handles. Reservations are optional, and refuse what they cannot price. `src/alpaca/` is the wire — Alpaca's REST and WebSocket clients, wire models, the correlation codec, equities and options, single-leg and spreads |
| `marketdata` | The market data model, two REST clients over it — Polygon (stock bars, trades, quotes, snapshots, reference data) and Alpaca (the same for stocks, plus option chains, option bars and trades, the exchange calendar, and the condition and exchange dictionaries) — and the US market-hours table. Options are Alpaca-only: Polygon's are a separate subscription. The Alpaca one here is market data; `@fleece/broker` is the trading API |
| `service` | The ledger and the three processes that write to it, a folder each: `core/` (the ledger — account facade, data access, schema migrations; the only writer), `http/` (the plumbing both Express apps are assembled from), `api/` (the HTTP API over it), `tracking/` (turns broker order events into ledger entries, and takes claims about whose an order is), `corporate-actions/` (records the dividends each account is owed) |

Dependencies point one way: `service` → `broker` → `client` → `models` → `utilities`;
`service` → `marketdata` → `utilities`. Nothing imports upward, and `utilities` imports
nothing of ours.

There is no CLI. Each runnable thing has a `main.ts` that reads its configuration from
the environment and starts; nothing parses arguments. `service` has three of them —
`src/api/main.ts`, `src/tracking/main.ts`, `src/corporate-actions/main.ts` — one per
process, rather than one entry point that takes an argument saying which to be.

`broker` has no consumer inside Fleece yet apart from the order feed `tracking/` reads.
It is groundwork for porting the execution service, and the reason it exists now is that
its reservation accounting is the piece the legacy got most carefully right. It is built
in layers over `src/alpaca/`, a folder each: `l1/` encodes the virtual account, `l2/`
claims the order for it, `l3/` hands back the handles, and `reservations/` sits beside
them because L3 runs with or without it.
[packages/broker/README.md](./packages/broker/README.md) has the table and the reasoning.

Inside `service/src/core`: `services` answer requests and hold the rules → `data` talks
to Postgres. Inside `service/src/api`: `routes` parse and delegate to a `core` service.
`service/src/http` holds what the API and the tracking app assemble themselves from —
the app builder, the middleware, the health check — so neither keeps its own copy.

Schema lives in `packages/service/migrations/` as numbered SQL files, applied on startup.
Never edit one that has shipped; add the next number.

## Three processes, one database

The API, the tracking service and the dividend job are separate processes writing to the
same database concurrently, which is the topology the legacy system ran. They do
not coordinate with each other — the ledger's write path takes a row lock on the
position being written, and applying a broker's fill report is idempotent. **Do not add
coordination between the processes; add it to the SQL.**

## Running it

```bash
npm start                     # the API on :3100 (builds + migrates first)
npm run start:tracking-service # the tracking service on :3101, in another terminal
npm run corporate-actions     # the dividend job, once
```

Each of those builds first and then runs a compiled `main.js` — `dist/api/main.js`,
`dist/tracking/main.js`, `dist/corporate-actions/main.js` — and that is the only way to
run one. Node 22 strips TypeScript types but resolves relative imports as ESM specifiers,
so `node packages/service/src/api/main.ts` fails on the first `./server` it meets — the
packages compile to CommonJS, which is what makes the `dist` copy work.

Everything is configured from the environment; see `dev.md`. There are no command-line
flags to learn. `npm run build:all` additionally type-checks `packages/playground`, which
the default build and CI both leave out — it is throwaway scripts nothing imports. Its
credentials come from the environment, so it type-checks anywhere.

## Tests

`packages/<pkg>/tests/` mirrors that package's `src/`, so
`service/src/core/data/pg-ledger-dao.ts` is tested by
`service/tests/core/data/pg-ledger-dao.test.ts`. Helpers and fakes live beside the
tests that use them, named anything but `*.test.ts`.

`npm test` skips every `tests/**/data-integration/` directory — the suites needing a real
PostgreSQL — unless `FLEECE_TEST_DATABASE_URL` points at a throwaway database.
Everything else runs against fakes and needs nothing installed.

`tests/live/` is excluded from `npm test` entirely rather than skipped: those suites call
a real data provider, CI has no key for one, and a suite that skipped itself there would
make the run green having tested nothing. `npm run test:live` runs them, reading `.env`.

`npm run test:coverage` is the coverage gate, and runs from `jest.coverage.config.js` —
the only config carrying thresholds. **It runs the unit suites alone**, `data-integration/`
included in what it excludes. That is deliberate: those suites skip themselves without a
database, so a number taken from the full run means one thing on a machine that has one
and something fifteen points lower on a machine that does not, and a threshold calibrated
against either fails on the other. Pinning the test set is what makes the gate answer a
question about the change rather than about the environment — the same number on a
laptop, in CI, and in whatever CI comes next. It needs nothing installed.

The Postgres DAOs under `core/data/` are therefore barely measured by it. They have a
threshold group of their own rather than an exclusion — the report should say what is
unmeasured, not hide it — and the suites that do test them still run under `npm test`
and `npm run test:ci`, where `scripts/assert-suites-ran.js` turns a silent skip red. It
is coverage that stops depending on a database, not correctness.

The thresholds are a ratchet, not a target: they sit just under what the suite reaches,
so ordinary work does not trip them and a genuine fall does. Raise one when the real
figure moves up; never lower one to make a red build green.

## Conventions

**Read [md/GUIDELINES.md](./md/GUIDELINES.md) before writing code here.** It is the
authority on structure, configuration, types, API contracts, the data layer, errors,
logging, failure handling, testing and style — each rule with the reasoning behind it.

## More

- [README.md](./README.md) — what the product does and how the pieces fit
- [dev.md](./dev.md) — setup, every environment variable, everyday commands
- [md/PORTING.md](./md/PORTING.md) — what changed from the legacy service, and why
- [md/OPEN-ITEMS.md](./md/OPEN-ITEMS.md) — decisions still open, and what to know before
  trusting this with money. **Read item 1 before relying on leg attribution, and item 2b
  before placing an option through `broker`.**
