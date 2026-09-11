# @fleece/playground

Experiment scripts. One file per experiment under `src/`, each with its own npm script.

This package is deliberately outside the product: nothing imports it, and the root
`npm run build` skips it, so a half-finished experiment can never break `serve`, the
injector or the dividend job.

## Setup

Put the keys in the repo-root `.env` — see `.env.example`, and `dev.md` for the table:

```
ALPACA_PAPER_ACCOUNT_ID=...
ALPACA_PAPER_API_KEY=...
ALPACA_PAPER_SECRET_KEY=...
```

That is all of it. `src/credentials.ts` loads `.env` itself, so nothing has to be
exported first, and there is no file to copy before the package compiles.

Add `ALPACA_LIVE_ACCOUNT_ID`, `ALPACA_LIVE_API_KEY` and `ALPACA_LIVE_SECRET_KEY` if you
want the live account. Only the account a script actually names is read, so leaving the
live trio unset costs nothing.


## Scripts

| Command | What it does |
| --- | --- |
| `npm run order-events -w @fleece/playground` | Opens the `trade_updates` stream and prints each order event as JSON. Ctrl-C to stop. |
| `npm run cancel-order -w @fleece/playground -- <brokerOrderId>` | Cancels one order, printing it before and after. |
| `npm run option-chain -w @fleece/playground` | Writes an underlying's near-dated chain — both types, greeks, volatility and quote — to `viz/data/` for the Python renderer to draw. |
| `npm run option-research -w @fleece/playground` | Runs the `src/research/` helpers end to end on one past session and prints the chain, the prices and the greeks. See [src/research/README.md](./src/research/README.md). |

## Credentials: two kinds

Both come from the repo-root `.env` by way of `credentials.ts`, but a script asks for one
or the other and the difference is what it can do.

- **A broker account** — `paperAccount()` or `liveAccount()`, carrying an account id, a
  key and the URLs to reach it. This can place and cancel orders.
- **Market-data keys** — `marketDataKeys()`, the paper pair and nothing else. `option-chain`
  takes these and no account at all, because market data is the one thing a paper key does
  exactly as well as a live one: Alpaca serves the same bars and the same chain to both. A
  script that only draws a picture should never be holding a key that can trade.

The paper pair is deliberately the same pair `npm run test:live` reads. Alpaca issues one
set of paper keys that both trades and serves data, so giving them two names would mean
writing the same secret down twice and rotating it in two places.

## Choosing an account

Each script names its account near the top:

```ts
const account = prepareAccount(paperAccount(), logger); // swap to liveAccount()
```

Swapping is a one-line edit, which is deliberate — reaching real money should take
changing the code, not remembering a flag. **No environment variable can move a script
from paper to live**; the worst a wrong `.env` can do is fail to start.

`paperAccount()` and `liveAccount()` are functions rather than constants so that nothing
is read until a script asks for one: a script that only wants paper does not fail on a
missing live key, and importing the module never throws on an empty `.env` (guideline 14).
An account with no key refuses to build, naming the variable to set. `prepareAccount` then
logs a warning if it is the live one.

`AccountInfo` carries `wsUrl` and `restUrl` separately because Alpaca serves the
websocket and the trading API from different hosts.

Every script rebuilds first. Run `npm run build -w @fleece/playground` on its own to
just typecheck.

## data/

Recorded Alpaca payloads for two-leg AMZN call spreads — the create response and the
`trade_updates` events that followed — across five outcomes: filled, rejected, expired
at end of day, and cancelled.

These are committed fixtures, not scratch output. Anything a script *generates* goes to
`viz/data/`, which is gitignored — keeping the two apart is what makes this folder
evidence rather than a drop box.

They are why Fleece handles multi-leg orders the way it does. These orders come back
with `order_class: "mleg"`, an empty `symbol` and `asset_class` on the parent, and the
real instruments on the legs — and the parent's `side` is `""` here but `"buy"` on the
websocket for the same order, which is the reason nothing signs a spread from it.

`packages/broker/tests/alpaca/mleg-alpaca-orders.ts` reproduces the filled case field for
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

## Charts

A script that ends in a picture stops at the JSON. `viz/` holds the matplotlib that draws
it, and [viz/README.md](../../viz/README.md) has the format and the reasoning — briefly,
fetching is TypeScript's job and drawing is Python's, so one request can be re-drawn all
afternoon.
