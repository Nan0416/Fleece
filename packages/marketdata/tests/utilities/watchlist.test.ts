import { WATCHLIST, type WatchedFund } from '../../src/utilities/watchlist';

describe('watchlist', () => {
  it('lists every symbol once', () => {
    const symbols = WATCHLIST.map((entry) => entry.symbol);
    const repeated = symbols.filter((symbol, index) => symbols.indexOf(symbol) !== index);

    expect(repeated).toEqual([]);
  });

  it('measures every leveraged fund against an unleveraged fund on the list that tracks the same index', () => {
    const funds = new Map(WATCHLIST.filter((entry): entry is WatchedFund => entry.kind === 'fund').map((fund) => [fund.symbol, fund]));
    const orphaned = WATCHLIST.flatMap((entry) =>
      entry.kind === 'leveraged-fund' && funds.get(entry.proxy)?.tracks !== entry.tracks ? [`${entry.symbol} -> ${entry.proxy}`] : [],
    );

    expect(orphaned).toEqual([]);
  });
});
