# @fleece/playground

Experiment scripts. One file per experiment under `src/`, each with its own npm script.

This package is deliberately outside the product: nothing imports it, and the root
`npm run build` skips it, so a half-finished experiment can never break `serve`, the
injector or the dividend job. It is also the one place in the repo where hardcoding a
credential is allowed — see `src/credentials.ts`, and keep it to paper keys.

## Setup

```bash
cp src/credentials.example.ts src/credentials.ts
```

Then fill in `paperAccountInfo` in your copy — and `liveAccountInfo` too if you want
the live scripts. `src/credentials.ts` is gitignored, so the keys stay local;
`credentials.example.ts` is the committed template and holds only blanks.

Keep the two files' exports in step. The example is what a fresh clone compiles
against — `packages/playground` is in the root `tsconfig.json`, so a missing
`credentials.ts` breaks `tsc -b` for the whole repo, not just this package.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run order-events -w @fleece/playground` | Opens the `trade_updates` stream and prints each order event as JSON. Ctrl-C to stop. |
| `npm run cancel-order -w @fleece/playground -- <brokerOrderId>` | Cancels one order, printing it before and after. |

## Choosing an account

Each script names its account near the top:

```ts
const ACCOUNT = paperAccountInfo; // swap to liveAccountInfo
```

Swapping is a one-line edit, which is deliberate — reaching real money should take
changing the code, not remembering a flag. Whatever it picks, `prepareAccount` checks
the account has a key and logs a warning when it is the live one, and `cancel-order`
asks before it cancels anything live (`--yes` skips the question).

`AccountInfo` carries `wsUrl` and `restUrl` separately because Alpaca serves the
websocket and the trading API from different hosts.

Every script rebuilds first. Run `npm run build -w @fleece/playground` on its own to
just typecheck.

## data/

Recorded Alpaca payloads for two-leg AMZN call spreads — the create response and the
`trade_updates` events that followed — across five outcomes: filled, rejected, expired
at end of day, and cancelled.

They are why Fleece handles multi-leg orders the way it does. These orders come back
with `order_class: "mleg"`, an empty `symbol` and `asset_class` on the parent, and the
real instruments on the legs — and the parent's `side` is `""` here but `"buy"` on the
websocket for the same order, which is the reason nothing signs a spread from it.

`packages/alpaca/tests/mleg-alpaca-orders.ts` reproduces the filled case field for
field as a fixture, because `playground` is outside the build and the product cannot
import from it. Keep the two in step: if Alpaca changes this shape, these files are the
evidence, and they are tedious to reproduce — a rejection and an end-of-day expiry each
need the market in a particular mood.

No credentials or account identifiers are in them; the ids are Alpaca's order and asset
UUIDs.

## Adding one

Drop `src/<name>.ts` in, give it a `main()` that returns a promise, and add
`"<name>": "npm run build && node dist/<name>.js"` to `package.json`. Take the account
through `prepareAccount` from `./account` rather than reading `credentials.ts` fields
directly, so the live warning and the missing-key check come for free. No tests — this
package is not covered by `npm test` and is not meant to be.
