# Fleece

A virtual-account ledger over a real broker account. Every order goes through one
Alpaca account, but each strategy trades under its own virtual account, so per-strategy
P&L falls out of a single brokerage statement. Node 22, TypeScript, PostgreSQL.

## Shape

An npm-workspaces monorepo, ten packages under `packages/`:

| Package | What it is |
| --- | --- |
| `shared` | Domain models, API contracts, errors, utilities. Imports nothing of ours |
| `core` | The ledger: account facade, data access, schema migrations. The only writer |
| `service` | The HTTP API over the ledger |
| `client` | Typed client for that API |
| `alpaca` | Alpaca REST and WebSocket clients, wire models, the correlation codec. Equities and options, single-leg and spreads |
| `broker` | Places orders, reserving buying power and shares before they go out. Equities only |
| `marketdata` | Polygon client for splits and dividends |
| `injector` | Turns broker order events into ledger entries |
| `corporate-actions` | Records the dividends each account is owed |
| `cli` | The `fleece` binary |

Dependencies point one way: `cli` → `service`/`injector`/`corporate-actions` → `core` →
`shared`; `injector` → `alpaca`; `broker` → `alpaca`; `corporate-actions` → `marketdata`;
`client` → `shared`.

`broker` has no consumer inside Fleece yet. It is groundwork for porting the execution
service, and the reason it exists now is that its reservation accounting is the piece
the legacy got most carefully right.

Inside `core`: `services` answer requests and hold the rules → `data` talks to
Postgres. Inside `service`: `routes` parse and delegate to a `core` service.

Schema lives in `packages/core/migrations/` as numbered SQL files, applied on startup.
Never edit one that has shipped; add the next number.

## Three processes, one database

`serve`, `injector start` and `corporate-actions run` are separate processes writing to
the same database concurrently, which is the topology the legacy system ran. They do
not coordinate with each other — the ledger's write path takes a row lock on the
position being written, and applying a broker's fill report is idempotent. **Do not add
coordination between the processes; add it to the SQL.**

## Running it

```bash
npm start                              # the API on :3100 (builds + migrates first)
npm run start:injector                 # the injector, in another terminal
npm run cli -- corporate-actions run   # the dividend job, once
```

`start` and `start:injector` rebuild first; skip that with `npm run cli -- serve`.
Flags need a `--` separator: `npm start -- --port 4000`.

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
  trusting this with money. **Read item 1 and 2 before relying on leg attribution or
  deleting an order group, and item 2b before placing an option through `broker`.**
