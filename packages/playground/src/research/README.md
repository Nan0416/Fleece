# Research helpers

Four functions for asking what an option chain was doing on a day that has already
happened, and one Black-Scholes engine for asking what that implies.

```ts
import { findGreek, findPrice, loadContracts, loadTradingMinuteBars } from './research';

const contracts = await loadContracts('2025-03-03', 'SPY', 'call', 40);
const minutes = await loadTradingMinuteBars('2025-03-03', 'SPY', contracts, { carryForward: true });
const minute = findPrice(easternClock.timestamp('2025-03-03', '10:00:00'), minutes);
const risk = findGreek(minute, 0.043, 0.012);
```

`npm run option-research -w @fleece/playground` runs exactly that and prints what it found.

## What each one does

| Function | Answers |
| --- | --- |
| `loadContracts(date, underlying, type, days)` | Every contract of that type at the expiration nearest `days` out **that was tradable on `date`** |
| `loadTradingMinuteBars(date, underlying, contracts, options?)` | One `MarketMinute` per minute of the regular session: the underlying's close and every contract that printed |
| `findPrice(timestamp, minutes)` | The last minute at or before that instant |
| `findGreek(minute, riskFreeRate, dividendYield?)` | Implied volatility and greeks for every contract in that minute a volatility can be solved for |

## Three things that will surprise you

**A contract listing is not a listing date.** Alpaca publishes no date on which a contract
became tradable, so "expires 40 days out" and "existed on the day you are standing on" are
different questions. SPY's April 14th 2025 calls were in the contract listing as far back
as you like; their first print was March 31st. `loadContracts` therefore checks each
candidate expiration against the tape for that session and takes the nearest one that
actually traded — which for March 3rd is April 11th, not April 14th.

**A chain is mostly silent.** Of the 291 SPY calls expiring 2025-04-11, 83 printed at all
on 2025-03-03, and at any given minute around 46 have a price. `optionPrices` holds only
what printed. Pass `carryForward: true` to hold each contract's last close forward, and
read `at` on the result to see how stale it is.

**These are trade prints, not quotes.** Adjacent strikes solve to volatilities several
points apart because their last trades happened at different moments against a moving
spot. For a smooth surface you want quote midpoints, which is a different endpoint and a
different helper.

## Cache

Everything fetched is written under `packages/playground/data/research/`, gitignored, and
only for dates that have finished — a session still running is a session whose bars are
still arriving. Delete the directory to refetch.
