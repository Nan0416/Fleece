# @fleece/broker

Places orders at a broker account, in four layers. Each one adds a single thing to the
one below and can be left out.

| | What it adds | Where |
| --- | --- | --- |
| **L0** | Alpaca's API, one to one | `@fleece/alpaca` |
| **L1** | The virtual account, encoded into `client_order_id` | `placement/correlated-order-placer.ts` |
| **L2** | A claim to the tracking service that the order belongs to that account | `placement/announcing-order-placer.ts` |
| **L3** | Signed decimals, live handles, event delivery | `orders/alpaca-broker.ts` |
| ⊥ | Holds buying power and shares around a placement | `reservations/` |

L1 and L2 share the `OrderPlacer` interface, so L2 is a wrapper you install rather than a
step inside L1. Reservations are a collaborator of L3 rather than a layer, because a hold
is decided from Fleece's vocabulary — a signed size, an asset class, a multiplier — and
pushing those down into L1 would make the layer that is meant to be one-to-one with the
broker know about contracts.

`createAlpacaBroker` assembles the standard stack. Anything else is built by hand.

## Why each layer exists

**L1 — an order that says whose it is.** Alpaca echoes `client_order_id` back on every
event, so it is the only place an order can carry a statement about itself that survives
a restart, a dropped socket and a REST backfill. An order placed without a virtual
account is one the injector books to the catch-all account, so L1 refuses one.
`reservationId` is an *input* here: this layer takes no hold and knows nothing about what
one would cost.

**L2 — a second answer to the same question.** For orders placed through this package it
adds little today: the converter gives every nested leg its parent's correlation, and at
Alpaca every leg arrives nested. It earns its place as the contract for callers that hold
their own broker client, as insurance if a correlation ever fails to round-trip, and as
the path a leg arriving unnested would need. Failure is logged, never thrown — the shares
are moving whether or not anything has been told whose they are.

**L3 — Fleece's vocabulary, and a handle.** Signed `Decimal` sizes, one request for a
spread rather than four, and an object that keeps receiving events until the order is
done.

**Reservations — optional on purpose.** Many strategies share one real account, so a hold
taken before the request goes out is what stops them each reading the same buying power
and the account being oversold. But the requirement for a short option is margin against
an unbounded loss, and a spread's is the width rather than the sum of its legs. Neither is
modelled, so the tracker **refuses** the first and **holds nothing** for the second — and
because reservations are a separate object, that is expressible rather than a special case
buried in the placement path. See `md/OPEN-ITEMS.md` item 2b.

## The shape of a spread

One handle for the placement, with read-only views of its contracts:

```
MultiLegOrderObj              the order: the id a placement returns and a cancel names,
  cancel()                    carrying the package's signed net price and nothing else
  legs: OrderLegView[]        the contracts: instrument, ratio, fills — and no cancel,
                              because Alpaca will not cancel one leg of a spread
```

The same shape the ledger stores (`broker_order` gives a spread a row for the parent and
one per contract), so "did what I placed get booked?" is a comparison rather than a
translation.

An OTO is the other case and keeps its own shape — `{ entryOrder, exitOrder }`, two peers,
both cancellable — because an OTO's exit is a real order in a real instrument that Alpaca
works on its own.

**Events are delivered a payload at a time.** One Alpaca message describes a whole
composite order, and everything in it is applied before the handler runs, so a caller
never sees a parent that has filled beside a contract that has not heard.
