# Fleece

A virtual-account ledger over a real broker account. Every order goes through one
Alpaca account, but each strategy trades under its own virtual account, so per-strategy
P&L falls out of a single brokerage statement. Node 22, TypeScript, PostgreSQL.

## Shape

An npm-workspaces monorepo, nine packages under `packages/`:

| Package | What it is |
| --- | --- |
| `shared` | Domain models, API contracts, errors, utilities. Imports nothing of ours |
| `core` | The ledger: account facade, data access, schema migrations. The only writer |
| `service` | The HTTP API over the ledger |
| `client` | Typed client for that API |
| `alpaca` | Alpaca REST and WebSocket clients, wire models, the correlation codec. Equities and options, single-leg and spreads |
| `broker` | Places orders, in layers: correlation, announcement, handles. Reservations are optional, and refuse what they cannot price |
| `marketdata` | Polygon client for splits and dividends |
| `tracking-service` | Turns broker order events into ledger entries, and takes claims about whose an order is |
| `corporate-actions` | Records the dividends each account is owed |

Dependencies point one way: `service`/`tracking-service`/`corporate-actions` → `core` →
`shared`; `tracking-service` → `alpaca`; `broker` → `alpaca` and `client`;
`corporate-actions` → `marketdata`; `client` → `shared`.

There is no CLI. Each runnable package has a `src/main.ts` that reads its configuration
from the environment and starts; nothing parses arguments.

`broker` has no consumer inside Fleece yet. It is groundwork for porting the execution
service, and the reason it exists now is that its reservation accounting is the piece
the legacy got most carefully right. It is built in layers over `@fleece/alpaca`, a folder
each: `l1/` encodes the virtual account, `l2/` claims the order for it, `l3/` hands back
the handles, and `reservations/` sits beside them because L3 runs with or without it.
[packages/broker/README.md](./packages/broker/README.md) has the table and the reasoning.

Inside `core`: `services` answer requests and hold the rules → `data` talks to
Postgres. Inside `service`: `routes` parse and delegate to a `core` service.

Schema lives in `packages/core/migrations/` as numbered SQL files, applied on startup.
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

Each of those builds first and then runs a `dist/main.js`, and that is the only way to
run one. Node 22 strips TypeScript types but resolves relative imports as ESM specifiers,
so `node packages/service/src/main.ts` fails on the first `./server` it meets — the
packages compile to CommonJS, which is what makes `dist/main.js` work.

Everything is configured from the environment; see `dev.md`. There are no command-line
flags to learn. `npm run build:all` additionally type-checks `packages/playground`, which
the default build and CI both leave out — its scripts import a gitignored `credentials.ts`
holding real broker keys, so it compiles on a laptop and nowhere else.

## Tests

`packages/<pkg>/tests/` mirrors that package's `src/`, so `src/data/pg-ledger-dao.ts`
is tested by `tests/data/pg-ledger-dao.test.ts`. Helpers and fakes live beside the
tests that use them, named anything but `*.test.ts`.

`npm test` skips `packages/core/tests/data-integration/` — the suites needing a real
PostgreSQL — unless `FLEECE_TEST_DATABASE_URL` points at a throwaway database.
Everything else runs against fakes and needs nothing installed.

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
