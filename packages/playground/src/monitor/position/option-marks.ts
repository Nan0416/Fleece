/**
 * The quote and delta of the contracts a strategy holds.
 */
import type { AlpacaMarketDataRestClient, OccSymbol, OptionSnapshot } from '@fleece/marketdata';
import { Decimal } from '@fleece/utilities';

export interface OptionQuote {
  /** Per share. Zero when nobody is bidding, which a far out-of-the-money long often is. */
  readonly bid: Decimal;
  readonly ask: Decimal;
}

export interface OptionMark {
  /** Absent when the contract has no ask, since then there is no price to close it at. */
  readonly quote?: OptionQuote;
  /** Alpaca's, per share. */
  readonly delta?: number;
}

/** By OCC symbol. A contract Alpaca has no snapshot for has no entry. */
export type OptionMarks = ReadonlyMap<string, OptionMark>;

export type OptionSnapshotReader = Pick<AlpacaMarketDataRestClient, 'optionSnapshots'>;

/** One request for all of `contracts`. */
export async function fetchOptionMarks(client: OptionSnapshotReader, contracts: ReadonlyArray<OccSymbol>): Promise<OptionMarks> {
  const { snapshots } = await client.optionSnapshots({ symbols: contracts.map((contract) => contract.symbol) });
  const marks = new Map<string, OptionMark>();
  for (const [symbol, snapshot] of snapshots) {
    marks.set(symbol, toMark(snapshot));
  }
  return marks;
}

function toMark(snapshot: OptionSnapshot): OptionMark {
  const quote = snapshot.lq;
  return {
    quote: quote !== undefined && quote.ap > 0 ? { bid: Decimal.of(quote.bp), ask: Decimal.of(quote.ap) } : undefined,
    delta: snapshot.greeks?.delta,
  };
}
