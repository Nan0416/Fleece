# @fleece/broker

Places orders at a broker account, in three layers over `@fleece/alpaca`. Each adds a
single thing to the one below, and each can be left out.

| Layer | Class | Adds |
| --- | --- | --- |
| **L0** | `AlpacaRestClient` (`@fleece/alpaca`) | Alpaca's API, one to one |
| **L1** | `L1BrokerOrderClient` | The virtual account, encoded into `client_order_id` |
| **L2** | `L2BrokerOrderClient` | A claim to the tracking service that the order is that account's |
| **L3** | `L3BrokerOrderClient` | Signed decimals, live handles, event delivery |
| — | `AccountReservations` | Holds buying power and shares around a placement |

```
src/
  l1/            broker-order-client.ts     the interface L1 and L2 both implement
                 l1-broker-order-client.ts
  l2/            l2-broker-order-client.ts
                 order-tracking-client.ts
  l3/            l3-broker-order-client.ts  the facade
                 broker.ts, requests.ts, order-obj.ts   its vocabulary
                 order-handle.ts, multi-leg-order-handle.ts, event-dispatcher.ts
  reservations/  not a layer — see below
  errors.ts      the package's error vocabulary, thrown from more than one layer
```

**Every type lives with the layer that owns it.** There is no `models/` folder, and that
is the point: an interface shared between layers cannot say which one it belongs to, so
the boundary stops being visible in the tree. `BrokerOrderClient` sits in `l1/` because
L1 defines it and L2 implements it; `requests.ts` sits in `l3/` because nothing below L3
knows what a market order is.

**Dependencies run one way**: `l3 → l1`, `l2 → l1`, `l3 → reservations`, and nothing
points back. Assembly is the one thing that sees all of them, in
`create-alpaca-broker-order-client.ts`.

## Why each layer exists

**L1 — an order that says whose it is.** Alpaca echoes `client_order_id` back on every
event, so it is the only place an order can carry a statement about itself that survives
a restart, a dropped socket and a REST backfill. An order placed without a virtual
account is one the injector books to the catch-all account, so L1 refuses one.
`reservationId` is an *input* here: this layer takes no hold and knows nothing about what
one would cost.

**L2 — a second answer to the same question.** It sends `PUT /track` to
`@fleece/tracking-service`, holding `@fleece/client`'s `TrackingClient` directly —
`OrderTrackingClient` is `Pick<TrackingClient, 'trackBrokerOrders'>`, a narrowed view of
the real thing rather than an interface of our own, so nothing adapts between them and
the compiler notices if they drift apart. For orders placed
through this package it adds little today: the converter gives every nested leg its
parent's correlation, and at Alpaca every leg arrives nested. It earns its place as the
contract for callers that hold their own broker client, as insurance if a correlation ever
fails to round-trip, and as the path a leg arriving unnested would need. Failure is
logged, never thrown — the shares are moving whether or not anything has been told whose
they are. Give it `NoopOrderTrackingClient`, or leave the layer out, and orders are still
placed and still attributed.

**L3 — Fleece's vocabulary, and a handle.** Signed `Decimal` sizes, one request for a
spread rather than four, and an object that keeps receiving events until the order is
done.

**Reservations — deliberately not a layer.** Many strategies share one real account, so a
hold taken before the request goes out is what stops them each reading the same buying
power and the account being oversold. But the requirement for a short option is margin
against an unbounded loss, and a spread's is the width rather than the sum of its legs.
Neither is modelled, so the tracker **refuses** the first and L3 places the second with
**nothing held**. Keeping this beside the layers rather than among them is what makes that
expressible instead of a special case buried in the placement path — and it takes a
`ReservationRequest`, never an order request, so it never learns what a market order is.
See `md/OPEN-ITEMS.md` item 2b.

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
