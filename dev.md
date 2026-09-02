# Developing Fleece

## Setup

Node 22 and a PostgreSQL you can throw away.

```bash
nvm use                 # reads .nvmrc
npm install
createdb fleece_beta
npm run build
npm run cli -- migrate  # or just `npm start`, which migrates first
```

## Everyday commands

| Command | What it does |
| --- | --- |
| `npm start` | Build, migrate, then serve the API on :3100 |
| `npm run start:injector` | Build, then run the injector |
| `npm run cli -- <args>` | Run the CLI without rebuilding |
| `npm run migrate` | Apply pending migrations and exit |
| `npm test` | Unit tests; integration suites skip without a database |
| `npm run lint` / `lint:fix` | ESLint |
| `npm run format:lint` / `format:fix` | Prettier |
| `npm run clean` | Remove `dist/` and build info |

Flags need a `--` separator, because npm appends arguments to the end of the script
string: `npm start -- --port 4000`.

## Running all three processes

```bash
npm start                                  # terminal 1: the API
npm run start:injector                     # terminal 2: the injector
npm run cli -- corporate-actions run       # terminal 3: the dividend job, once
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

### The API (`fleece serve`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `FLEECE_PORT` | `3100` | Port to listen on |
| `FLEECE_HOST` | `127.0.0.1` | Address to bind. Loopback by default: this service moves positions |
| `FLEECE_TOKEN` | *(unset)* | Bearer token callers must present. Unset disables authentication, and says so on every start |
| `FLEECE_CORS_ORIGINS` | `*` | Comma-separated origins. Setting it *replaces* the default rather than adding to it |

### The injector (`fleece injector start`)

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

Both default accounts must exist before the injector can book anything to them:

```bash
npm run cli -- account create --id 0000000001 --name "Unclaimed Paper" --type paper
npm run cli -- account create --id 0000000002 --name "Unclaimed Live" --type live
```

### The dividend job (`fleece corporate-actions run`)

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
5. Add the method to `packages/client/src/fleece-client.ts`.
6. Add a CLI command in `packages/cli/src/commands/` if a person would want it.

Steps 1 and 5 are what keep the client and service from drifting: both compile against
the same interfaces, so a contract change is a build failure rather than a runtime 400.

## Where the legacy source is

The pre-rewrite system is 38 repositories cloned to `/Users/nan/workplace/alpaca-legacy/`.
They are the only specification for behaviour not yet ported. See
[md/PORTING.md](./md/PORTING.md).
