/**
 * Prints the watchlist from `@fleece/marketdata`, one symbol per line.
 *
 *   npm run watchlist -w @fleece/playground
 *
 * A fund has no sector, so its line says what it tracks instead.
 */
import { WATCHLIST, type WatchlistEntry } from '@fleece/marketdata';

function classification(entry: WatchlistEntry): string {
  switch (entry.kind) {
    case 'stock':
      return entry.sector;
    case 'fund':
      return `Fund: ${entry.tracks}`;
    case 'leveraged-fund':
      return `Fund: ${entry.leverage}x ${entry.tracks}`;
  }
}

const symbolWidth = Math.max(...WATCHLIST.map((entry) => entry.symbol.length));
const nameWidth = Math.max(...WATCHLIST.map((entry) => entry.name.length));

for (const entry of WATCHLIST) {
  console.log(`${entry.symbol.padEnd(symbolWidth)}  ${entry.name.padEnd(nameWidth)}  ${classification(entry)}`);
}
