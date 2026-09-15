# Research

Strategies researched against the backtest framework in `../backtest/`, and the one helper
they share for reading a chain at a minute. The Black-Scholes engine `findGreek` solves with
lives in `@fleece/marketdata`.

| File | What it is |
| --- | --- |
| `greeks.ts` | `findGreek(minute, riskFreeRate, dividendYield?)`: implied volatility and greeks for every contract in a `MarketMinute` a volatility can be solved for |
| `sell-put.ts`, `sell-put-rules.ts` | The sell-put strategy and its rules; `npm run sell-put -w @fleece/playground` |

A strategy builds the `MarketMinute` from its own market data at the instant its clock is
on — the stock's last minute close, and each contract's last close from
`optionMinuteBars` — with the contracts from `listActiveOptionContracts`:

```ts
const risks = findGreek({ timestamp: now, stockSpotPrice: spot, optionPrices }, 0.043, 0.004);
```

## Two things that will surprise you

**A chain is mostly silent.** Most contracts do not trade in any given minute, so a price
is a contract's last close, not one anyone traded at this minute. Read `at` to see which
minute it came from: a contract in the wings can go an hour between prints, and its
volatility is then solved against a spot it never saw.

**These are trade prints, not quotes.** Adjacent strikes solve to volatilities several
points apart because their last trades happened at different moments against a moving
spot, and a print can be one leg's share of a multi-leg trade rather than a price for the
contract, which is why `findGreek` leaves out a contract whose price has no volatility.
