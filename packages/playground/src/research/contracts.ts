/**
 * Which contracts to look at, on a day that has already happened.
 */
import { requireOccSymbol, type OccSymbol, type OptionContract, type OptionType } from '@fleece/marketdata';
import { easternClock } from '@fleece/utilities';

import { marketDataClient } from './client';

const CHAIN_PAGE = 10_000;

/**
 * The contracts of one type that **actually traded on `date`**, at the earliest
 * expiration at or after `nearestExpirationAfterDays` days out that traded at all.
 * `expirationWindowDays` says how far past that target to keep looking.
 *
 * Traded, rather than listed, because the two are not the same question and Alpaca only
 * answers the second. It publishes no listing date, so a contract that had not expired by
 * the target may still not have existed on the day you are standing on: SPY's April 14th
 * 2025 calls were in the contract listing all along, and their first print was March 31st.
 * Taking the listing at its word hands back a chain and not one price.
 *
 * So each candidate expiration is checked against that session's tape, earliest first,
 * and the first one with any prints wins — and what comes back is the contracts from it
 * that printed, not the whole chain around them. A strike nobody traded is not a strike
 * you could have traded.
 *
 * Nothing is cached. Each call asks Alpaca again.
 *
 * Empty means no expiration in the window traded that day: a holiday, a date before
 * Alpaca's option history begins in February 2024, an underlying with no options, or a
 * window too short to reach one that was listed.
 *
 * **Adjusted contracts are left out.** A root that is not the underlying — `1AAPL`, which
 * is how Alpaca writes one — is a contract some corporate action re-issued, and it does
 * not deliver 100 shares. Priced alongside everyone else it quietly produces the wrong
 * greeks, and it is not what "the 40-day calls" means.
 */
export async function loadContracts(
  date: string,
  underlying: string,
  type: OptionType,
  nearestExpirationAfterDays: number,
  expirationWindowDays: number,
): Promise<ReadonlyArray<OccSymbol>> {
  const ticker = underlying.trim().toUpperCase();
  const target = easternClock.shiftDate(date, nearestExpirationAfterDays);
  const byExpiration = await candidates(ticker, type, target, easternClock.shiftDate(target, expirationWindowDays));

  // Ascending, which with a window that only runs forward is also nearest-first.
  for (const expiration of [...byExpiration.keys()].sort()) {
    const traded = await tradedOn(byExpiration.get(expiration) ?? [], date);
    if (traded.length > 0) {
      return traded.map((symbol) => requireOccSymbol(symbol, 'read a contract from the listing'));
    }
  }
  return [];
}

/**
 * Both halves of the listing, because neither alone is right: a target well in the past
 * is all expired contracts, but one a few days back can still reach expirations that
 * have not happened yet.
 */
async function candidates(ticker: string, type: OptionType, from: string, to: string): Promise<ReadonlyMap<string, ReadonlyArray<OptionContract>>> {
  const client = marketDataClient();
  const byExpiration = new Map<string, OptionContract[]>();

  for (const status of ['active', 'inactive'] as const) {
    const { contracts } = await client.listOptionContracts({
      underlying: ticker,
      type,
      status,
      expirationFrom: from,
      expirationTo: to,
      limit: CHAIN_PAGE,
    });
    for (const contract of contracts) {
      if (contract.contract.root !== ticker) {
        continue;
      }
      const chain = byExpiration.get(contract.contract.expiration);
      if (chain === undefined) {
        byExpiration.set(contract.contract.expiration, [contract]);
      } else {
        chain.push(contract);
      }
    }
  }
  return byExpiration;
}

/**
 * The contracts of one chain that printed that day, in strike order.
 *
 * Daily bars rather than minute ones: the question is which contracts traded at all, and
 * one bar per contract answers it for the price of a small response.
 */
async function tradedOn(chain: ReadonlyArray<OptionContract>, date: string): Promise<ReadonlyArray<string>> {
  if (chain.length === 0) {
    return [];
  }
  const { bars } = await marketDataClient().optionBarsBySymbol({
    symbols: chain.map((contract) => contract.S),
    from: date,
    to: date,
    multiplier: 1,
    timespan: 'day',
  });

  return chain
    .filter((contract) => bars.has(contract.S))
    .sort((left, right) => left.contract.strikeMils - right.contract.strikeMils)
    .map((contract) => contract.S);
}
