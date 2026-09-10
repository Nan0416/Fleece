/**
 * Which contracts to look at, on a day that has already happened.
 */
import { requireOccSymbol, type OccSymbol, type OptionContract, type OptionType } from '@fleece/marketdata';
import { easternClock } from '@fleece/utilities';

import { cached, marketDataClient, settled } from './client';

/** How far either side of the target to consider an expiration. */
const EXPIRATION_WINDOW_DAYS = 16;
const CHAIN_PAGE = 10_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Every contract of one type at the expiration nearest `nearestExpirationAfterDays` days
 * after `date` **that was tradable on that date**.
 *
 * The second half is not a refinement, it is the whole problem. Alpaca publishes no
 * listing date, so a contract that had not expired by the target is not the same as one
 * anyone could trade on the day you are standing on. SPY's April 14th 2025 calls existed
 * as far as the contract listing was concerned on March 3rd; their first print was March
 * 31st. Taking the calendar-nearest expiration would have handed back 251 contracts and
 * not one price. So each candidate is checked against the tape for that session, nearest
 * to the target first, and the first one that actually traded wins.
 *
 * Empty means nothing within {@link EXPIRATION_WINDOW_DAYS} of the target traded that
 * day — a holiday, a date before Alpaca's option history begins in February 2024, or an
 * underlying with no options at all.
 *
 * **Adjusted contracts are left out.** A root that is not the underlying — `1AAPL`, which
 * is how Alpaca writes one — is a contract some corporate action re-issued, and it does
 * not deliver 100 shares. Priced alongside everyone else it quietly produces the wrong
 * greeks, and it is not what "the 40-day calls" means.
 */
export async function loadContracts(date: string, underlying: string, type: OptionType, nearestExpirationAfterDays: number): Promise<ReadonlyArray<OccSymbol>> {
  const ticker = underlying.trim().toUpperCase();
  const target = easternClock.shiftDate(date, nearestExpirationAfterDays);

  const symbols = await cached(`chain-${ticker}-${type}-${date}-${nearestExpirationAfterDays}`, settled(date), async () => await pick(date, ticker, type, target));
  return symbols.map((symbol) => requireOccSymbol(symbol, 'read a contract from the listing'));
}

async function pick(date: string, ticker: string, type: OptionType, target: string): Promise<ReadonlyArray<string>> {
  const byExpiration = await candidates(ticker, type, target);
  const nearest = [...byExpiration.keys()].sort((left, right) => {
    const distance = Math.abs(daysBetween(left, target)) - Math.abs(daysBetween(right, target));
    // A tie is one expiry either side of the target; take the later, which has more life
    // left in it than the strategy asked for rather than less.
    return distance !== 0 ? distance : left < right ? 1 : -1;
  });

  for (const expiration of nearest) {
    const chain = byExpiration.get(expiration) ?? [];
    if (await traded(chain, date)) {
      return chain
        .slice()
        .sort((left, right) => left.contract.strikeMils - right.contract.strikeMils)
        .map((contract) => contract.S);
    }
  }
  return [];
}

/**
 * Both halves of the listing, because neither alone is right: a target well in the past
 * is all expired contracts, but one a few days back can still reach expirations that
 * have not happened yet.
 */
async function candidates(ticker: string, type: OptionType, target: string): Promise<ReadonlyMap<string, ReadonlyArray<OptionContract>>> {
  const client = marketDataClient();
  const byExpiration = new Map<string, OptionContract[]>();

  for (const status of ['active', 'inactive'] as const) {
    const { contracts } = await client.listOptionContracts({
      underlying: ticker,
      type,
      status,
      expirationFrom: easternClock.shiftDate(target, -EXPIRATION_WINDOW_DAYS),
      expirationTo: easternClock.shiftDate(target, EXPIRATION_WINDOW_DAYS),
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
 * Daily bars rather than minute ones: the question is only whether this expiration was
 * listed yet, and one bar anywhere in the chain settles it for the price of a small
 * answer.
 */
async function traded(chain: ReadonlyArray<OptionContract>, date: string): Promise<boolean> {
  if (chain.length === 0) {
    return false;
  }
  const { bars } = await marketDataClient().optionBarsBySymbol({
    symbols: chain.map((contract) => contract.S),
    from: date,
    to: date,
    multiplier: 1,
    timespan: 'day',
  });
  return bars.size > 0;
}

function daysBetween(from: string, to: string): number {
  return (easternClock.timestamp(to) - easternClock.timestamp(from)) / MS_PER_DAY;
}
