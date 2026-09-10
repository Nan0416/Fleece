# Research helpers

Four functions for asking what an option chain was doing on a day that has already
happened, and one Black-Scholes engine for asking what that implies.

```ts
import { findGreek, findPrice, loadContracts, loadTradingMinuteBars } from './research';

const contracts = await loadContracts('2025-03-03', 'SPY', 'call', 40, 16);
const minutes = await loadTradingMinuteBars('2025-03-03', 'SPY', contracts);
const minute = findPrice(easternClock.timestamp('2025-03-03', '10:00:00'), minutes);
const risk = findGreek(minute, 0.043, 0.012);
```

`npm run option-research -w @fleece/playground` runs exactly that and prints what it found.

## What each one does

| Function | Answers |
| --- | --- |
| `loadContracts(date, underlying, type, days, windowDays)` | The contracts of that type that **traded on `date`**, at the earliest expiration from `days` out through `days + windowDays` that traded at all |
| `loadTradingMinuteBars(date, underlying, contracts)` | One `MarketMinute` per minute of the regular session: the underlying's close and every contract's last close as of that minute |
| `findPrice(timestamp, minutes)` | The last minute at or before that instant |
| `findGreek(minute, riskFreeRate, dividendYield?)` | Implied volatility and greeks for every contract in that minute a volatility can be solved for |

## Three things that will surprise you

**A contract listing is not a listing date.** Alpaca publishes no date on which a contract
became tradable, so "expires 40 days out" and "could be traded on the day you are standing
on" are different questions. SPY's April 14th 2025 calls were in the contract listing as
far back as you like; their first print was March 31st. `loadContracts` therefore searches
forward from the target, checks each candidate expiration against that session's tape, and
takes the first that traded — for March 3rd, April 17th, since neither the 14th nor the
16th had printed yet.

**A chain is mostly silent, so only the traded part comes back.** SPY's April 17th
expiration holds 383 calls; 135 of them printed on March 3rd, and around 90 have a price
in any given minute. `loadContracts` returns the 135, not the 383 — a strike nobody traded
is not a strike you could have traded. Within the session, `optionPrices` carries each
contract's last close forward so a strategy can quote all its legs at one instant — read
`at` to see which minute a price actually came from, because a contract in the wings can
go an hour between prints.

**These are trade prints, not quotes.** Adjacent strikes solve to volatilities several
points apart because their last trades happened at different moments against a moving
spot. For a smooth surface you want quote midpoints, which is a different endpoint and a
different helper.

## Cache

Minute bars are written under `packages/playground/data/research/`, gitignored, and only
for dates that have finished — a session still running is one whose bars are still
arriving. Delete the directory to refetch.

`loadContracts` is **not** cached: every call asks Alpaca again.
