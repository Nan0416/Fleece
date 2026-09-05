# Developing Fleece

## Setup

Node 22 and a PostgreSQL you can throw away.

```bash
nvm use                 # reads .nvmrc
npm install
createdb fleece_beta
npm run build
npm start               # migrates on the way up
```

## Everyday commands

| Command | What it does |
| --- | --- |
| `npm start` | Build, migrate, then serve the API on :3100 |
| `npm run start:injector` | Build, then run the injector |
| `npm run corporate-actions` | Build, then run the dividend job once |
| `npm run build:all` | Type-check every package, `broker` included |
| `npm test` | Unit tests; integration suites skip without a database |
| `npm run lint` / `lint:fix` | ESLint |
| `npm run format:lint` / `format:fix` | Prettier |
| `npm run clean` | Remove `dist/` and build info |

There are no command-line flags. Every process reads its configuration from the
environment, so `FLEECE_PORT=4000 npm start` is how you change a port — one place a
setting can come from, rather than two with a precedence rule between them.

Node 22 runs TypeScript directly, so the build is skippable:

```bash
node packages/service/src/main.ts           # the API, no build
node packages/injector/src/main.ts          # the injector, no build
```

That is also how to run something one-off: write a script with the values in it and run
it with `node`. `packages/playground/` exists for exactly that and is kept out of the
build so a half-finished experiment cannot break it.

`npm run build` deliberately leaves out `broker`, which does not compile against the
ledger redesign yet — see `md/OPEN-ITEMS.md` item 0. `npm run build:all` includes it, so
the gap is visible rather than forgotten.

## Running all three processes

```bash
npm start                     # terminal 1: the API
npm run start:injector        # terminal 2: the injector
npm run corporate-actions     # terminal 3: the dividend job, once
```

All three want `FLEECE_DATABASE_URL` pointing at the same database. That is the design,
not an accident — see the concurrency note in [README.md](./README.md).

## Environment variables

Every value has a default except the two credentials that must not have one, so
importing a package never throws for missing configuration.

### Shared

| Variable | Default | Meaning |
| --- | --- | --- |
| `FLEECE_STAGE` | `beta` | `beta` or `prod`; only used to derive the default database name |
| `FLEECE_DATABASE_URL` | `postgres://localhost:5432/fleece_<stage>` | Where the ledger lives |
| `FLEECE_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

### The API (`packages/service/src/main.ts`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `FLEECE_PORT` | `3100` | Port to listen on |
| `FLEECE_HOST` | `127.0.0.1` | Address to bind. Loopback by default: this service moves positions |
| `FLEECE_TOKEN` | *(unset)* | Bearer token callers must present. Unset disables authentication, and says so on every start |
| `FLEECE_CORS_ORIGINS` | `*` | Comma-separated origins. Setting it *replaces* the default rather than adding to it |

### The injector (`packages/injector/src/main.ts`)

The first broker account uses unsuffixed names; further accounts are numbered from 2,
so the usual single-account setup needs no numbering.

| Variable | Default | Meaning |
| --- | --- | --- |
| `FLEECE_ALPACA_ACCOUNT_ID` | *(unset)* | Alpaca account number. Without it the injector runs and does nothing, and warns |
| `FLEECE_ALPACA_KEY` | **required** | Alpaca API key id |
| `FLEECE_ALPACA_SECRET` | **required** | Alpaca API secret |
| `FLEECE_ALPACA_LIVE` | `false` | `true` connects to the live endpoints. Logged as a warning on start |
| `FLEECE_ALPACA_2_*` | *(unset)* | A second broker account, and so on |
| `FLEECE_DEFAULT_PAPER_ACCOUNT_ID` | `0000000001` | Virtual account for unclaimed paper orders |
| `FLEECE_DEFAULT_LIVE_ACCOUNT_ID` | `0000000002` | Virtual account for unclaimed live orders |
| `FLEECE_UNRESOLVED_ORDER_TIMEOUT_MS` | `60000` | How long to wait for a strategy to claim an order before booking it to the default account |
| `FLEECE_INJECTOR_MIGRATE` | `false` | Apply migrations from the injector. Normally left to the API, which starts first |

Both default accounts must exist before the injector can book anything to them, and
nothing creates them — see `md/OPEN-ITEMS.md` item 8. With the API running:

```bash
curl -s -X POST localhost:3100/account -H 'content-type: application/json' \
  -d '{"accountId":"0000000001","name":"Unclaimed Paper","accountType":"paper"}'
curl -s -X POST localhost:3100/account -H 'content-type: application/json' \
  -d '{"accountId":"0000000002","name":"Unclaimed Live","accountType":"live"}'
```

An order that lands in one of these stays there: a broker order's virtual account is
written once. These accounts are also what "orphan" means — `GET /broker-orders?accountId=0000000001`
is the list worth watching.

### The dividend job (`packages/corporate-actions/src/main.ts`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `FLEECE_POLYGON_API_KEY` | **required** | Polygon API key. No default: a job that runs to completion having recorded nothing looks like success |

### The CLI

| Variable | Default | Meaning |
| --- | --- | --- |
| `FLEECE_SERVICE_URL` | `http://127.0.0.1:3100` | Which API to talk to. `--service` overrides it |
| `FLEECE_TOKEN` | *(unset)* | Bearer token. `--token` overrides it |

### Tests

| Variable | Default | Meaning |
| --- | --- | --- |
| `FLEECE_TEST_DATABASE_URL` | *(unset)* | A throwaway database. Unset skips `packages/core/tests/data-integration/` |

```bash
createdb fleece_test
FLEECE_TEST_DATABASE_URL=postgres://localhost:5432/fleece_test npm test
```

Every table is truncated between tests, so do not point this at anything you want to
keep.

## Migrations

Numbered SQL files in `packages/core/migrations/`, applied in ascending numeric order,
each in its own transaction together with its bookkeeping row. Never edit one that has
shipped — add the next number. The runner rejects a filename it cannot parse and two
files sharing a sequence number, because both of those otherwise produce a schema that
differs between machines rather than an error.

## Adding an endpoint

1. Add the `Request`/`Response` pair to `packages/shared/src/api/`.
2. Add the method to the relevant service in `packages/core/src/services/`.
3. Parse the request in `packages/service/src/utils/request-parsing.ts`.
4. Bind the route in `packages/service/src/routes/`.
5. Add the method to `packages/client/src/fleece-client.ts`, reviving the response with
   the helpers in `packages/shared/src/api/wire.ts`.

Steps 1 and 5 are what keep the client and service from drifting: both compile against
the same interfaces, so a contract change is a build failure rather than a runtime 400.

**Decimals cross the wire as strings, in both directions.** A JSON number is a double,
so accepting one would discard exactly the precision the ledger is built to keep — the
service refuses a number where a decimal is expected and says to send a string instead.
On the way back, a response therefore does not have the shape its `Response` type
describes, and no cast can give it one; that is what the revivers are for, and why the
client has no `as` at its boundary any more.

## Where the legacy source is

The pre-rewrite system is 38 repositories cloned to `/Users/nan/workplace/alpaca-legacy/`.
They are the only specification for behaviour not yet ported. See
[md/PORTING.md](./md/PORTING.md).
