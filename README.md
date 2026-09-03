# Fleece

A virtual-account ledger over a real broker account.

Every order Fleece records went through one real Alpaca account. But each trading
strategy holds its own *virtual* account, and every fill is booked to one of them — so
"how is the mean-reversion strategy doing?" has an answer, even though the broker only
ever saw one account with one blended position.

That is the whole idea. Everything else follows from it.

## What it does

- **Books fills to strategies.** An order's virtual account is encoded into Alpaca's
  `client_order_id` when the order is placed, and comes back on every event about it.
  Orders placed by hand on Alpaca's website carry no such marker, so they land in a
  catch-all account rather than being dropped — the shares moved either way.
- **Keeps a cost basis per account.** Average-cost accounting, with realised profit
  recorded on the trade that realised it. A sale that carries a position through zero
  is split into a close and an open, so the resulting cost basis is not an average of
  two unrelated things.
- **Moves positions between accounts.** A transfer books both sides as a matched pair
  of synthetic orders, so each account's cost basis and realised profit move exactly as
  they would for a real fill. Both sides commit together or neither does.
- **Records dividends.** A daily job asks a market-data provider what is being paid,
  and works out what each account held going into the ex-dividend date.
- **Keeps the raw broker events.** Every message Alpaca sent about an order is stored
  verbatim, so an execution can be replayed rather than reconstructed.

## The pieces

Three processes, one PostgreSQL database:

```
                    ┌──────────────────┐
   Alpaca stream ──▶│  fleece injector │──┐
   Alpaca REST   ──▶│                  │  │
                    └──────────────────┘  │
                                          ▼
   Polygon       ──▶┌──────────────────┐ ┌────────────┐
                    │ corporate-actions│▶│ PostgreSQL │
                    └──────────────────┘ └────────────┘
                                          ▲
                    ┌──────────────────┐  │
   HTTP callers  ──▶│   fleece serve   │──┘
   fleece CLI    ──▶│                  │
                    └──────────────────┘
```

- **`fleece serve`** answers questions about the ledger and handles account management
  and transfers.
- **`fleece injector start`** holds a websocket per broker account and records what the
  broker reports. It also polls REST for events the stream dropped, because a missing
  fill is not a gap in a log — it is a position that is silently wrong from then on.
- **`fleece corporate-actions run`** is a daily job that records dividends.

They write concurrently and do not coordinate. Two things make that safe, and both live
in the database rather than in any process:

1. Applying a fill takes a row lock on the position it lands on, so a read-modify-write
   cannot interleave with another process's.
2. A broker's fill report is *cumulative* — the total filled so far, not the increment
   — and the ledger derives how much of it is new from the transactions already
   recorded. Delivering the same report twice changes nothing, and a process restarted
   mid-order picks up exactly where it left off.

## Quick start

```bash
createdb fleece_beta
npm install
npm start                    # API on http://127.0.0.1:3100

npm run cli -- account create --name "Momentum" --type paper
npm run cli -- account list
```

To record real fills, point the injector at an Alpaca account:

```bash
export FLEECE_ALPACA_ACCOUNT_ID=PA3...
export FLEECE_ALPACA_KEY=...
export FLEECE_ALPACA_SECRET=...
npm run start:injector
```

See [dev.md](./dev.md) for every environment variable and the full command list.

## A note on money

The permissive defaults announce themselves at startup: with no `FLEECE_TOKEN` the API
is unauthenticated, and with no `FLEECE_CORS_ORIGINS` it accepts any origin. That is a
reasonable first five minutes on a laptop and a bad idea anywhere a browser you do not
control can reach it. The service warns on every start for that reason.

Deleting anything but a paper account requires `--force`, and the error says what will
be lost. Applying a stock split is not idempotent and says so.

## Status

Ported from a private trading system that ran on MongoDB across many small repositories.
[md/PORTING.md](./md/PORTING.md) records what changed and why — including several
bugs the port fixes.

[md/OPEN-ITEMS.md](./md/OPEN-ITEMS.md) is the shorter and more urgent read: the decisions
still open, and the two places where a wrong answer produces a silently wrong number.

## Licence

MIT.
