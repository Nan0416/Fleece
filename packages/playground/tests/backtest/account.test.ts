import { Decimal, type DecimalInput } from '@fleece/utilities';

import { BacktestAccountImpl, type RealizedPL, type Transaction } from '../../src/backtest/account';

const CALL = 'AAPL260918C00230000';
const START = 10_000;
const T0 = 1_700_000_000_000;
const MINUTE = 60_000;

function account(): BacktestAccountImpl {
  return new BacktestAccountImpl(START, T0, MINUTE);
}

/** Steps the clock one tick on and trades at the instant it lands on. */
async function trade(book: BacktestAccountImpl, symbol: string, size: DecimalInput, price: DecimalInput): Promise<Transaction> {
  await book.forward();
  return book.record({ symbol, size, price, timestamp: book.timestamp() });
}

function totalRealized(rows: ReadonlyArray<RealizedPL>): number {
  return rows.reduce((total, row) => total + row.realizedPL, 0);
}

describe('BacktestAccountImpl', () => {
  describe('the clock', () => {
    it('starts on the beginning timestamp and advances one fidelity per step', async () => {
      const book = account();
      expect(book.timestamp()).toBe(T0);

      await book.forward();
      expect(book.timestamp()).toBe(T0 + MINUTE);

      await book.forward();
      await book.forward();
      expect(book.timestamp()).toBe(T0 + 3 * MINUTE);
    });

    it('refuses a trade stamped anywhere but the instant it is standing on', async () => {
      const book = account();
      await book.forward();
      const now = book.timestamp();

      expect(() => book.record({ symbol: 'AAPL', size: 1, price: 10, timestamp: now - MINUTE })).toThrow(/clock is on/);
      expect(() => book.record({ symbol: 'AAPL', size: 1, price: 10, timestamp: now + MINUTE })).toThrow(/clock is on/);
      expect(() => book.record({ symbol: 'AAPL', size: 1, price: 10, timestamp: now })).not.toThrow();
    });

    it('refuses a fidelity that would stall or rewind the clock', () => {
      expect(() => new BacktestAccountImpl(START, T0, 0)).toThrow(/positive whole number/);
      expect(() => new BacktestAccountImpl(START, T0, -MINUTE)).toThrow(/positive whole number/);
      expect(() => new BacktestAccountImpl(START, T0, 0.5)).toThrow(/positive whole number/);
    });

    it('lets several trades land on one instant, which is what a spread is', async () => {
      const book = account();
      await book.forward();
      const now = book.timestamp();

      book.record({ symbol: 'AAPL', size: 1, price: 10, timestamp: now });
      book.record({ symbol: 'MSFT', size: 1, price: 20, timestamp: now });

      expect(book.symbols()).toEqual(['AAPL', 'MSFT']);
      expect(book.cash.toString()).toBe('9970');
    });
  });

  describe('bookkeeping', () => {
    it('closes the oldest lot first and leaves the newer one untouched', async () => {
      const book = account();
      await trade(book, 'AAPL', 10, 50);
      await trade(book, 'AAPL', 10, 60);

      const sale = await trade(book, 'AAPL', -4, 70);

      expect(sale.realizedPL?.toString()).toBe('80'); // (70 - 50) x 4, not (70 - 55) x 4
      // 6 left of the 50 lot and all 10 of the 60 lot, so the blend is 56.25 rather than 55.
      expect(book.positions()).toEqual([{ symbol: 'AAPL', size: 16, averagePrice: 56.25 }]);
    });

    it('walks on to the next lot when the first one is not enough', async () => {
      const book = account();
      await trade(book, 'AAPL', 10, 50);
      await trade(book, 'AAPL', 10, 60);

      const sale = await trade(book, 'AAPL', -16, 70);

      expect(sale.realizedPL?.toString()).toBe('260'); // (70 - 50) x 10 + (70 - 60) x 6
      expect(book.positions()).toEqual([{ symbol: 'AAPL', size: 4, averagePrice: 60 }]);
    });

    it('realizes only the closing half of a trade that carries the position through zero', async () => {
      const book = account();
      await trade(book, 'AAPL', 10, 50);

      const flip = await trade(book, 'AAPL', -15, 60);

      expect(flip.realizedPL?.toString()).toBe('100'); // the 10 that closed, never the 5 that opened
      expect(book.positions()).toEqual([{ symbol: 'AAPL', size: -5, averagePrice: 60 }]);
      expect(book.cash.toString()).toBe('10400');
    });

    it('reports a break-even close as zero realized, not as nothing realized', async () => {
      const book = account();
      const opening = await trade(book, 'AAPL', 10, 50);
      const closing = await trade(book, 'AAPL', -10, 50);

      expect(opening.realizedPL).toBeUndefined();
      expect(closing.realizedPL?.toString()).toBe('0');
      expect(book.realizedPLs()).toEqual([{ symbol: 'AAPL', realizedPL: 0 }]);
    });

    it('leaves a symbol it has only ever opened out of the realized rows entirely', async () => {
      const book = account();
      await trade(book, 'AAPL', 10, 50);

      expect(book.realizedPLs()).toEqual([]);
      expect(book.symbols()).toEqual(['AAPL']);
    });

    it('raises cash on a short sale and realizes a gain when the cover is cheaper', async () => {
      const book = account();
      await trade(book, 'AAPL', -10, 50);
      expect(book.cash.toString()).toBe('10500');

      const cover = await trade(book, 'AAPL', 4, 45);

      expect(cover.realizedPL?.toString()).toBe('20');
      expect(book.positions()).toEqual([{ symbol: 'AAPL', size: -6, averagePrice: 50 }]);
    });

    it('prices an option contract at a hundred times the premium it was given', async () => {
      const book = account();
      await trade(book, CALL, 2, '3.85');

      expect(book.cash.toString()).toBe('9230'); // 10_000 - 770, not 10_000 - 7.70
      // Per share, the unit it was traded in — not the 385 a contract cost.
      expect(book.positions()).toEqual([{ symbol: CALL, size: 2, averagePrice: 3.85 }]);

      const sale = await trade(book, CALL, -2, '5.00');

      expect(sale.realizedPL?.toString()).toBe('230'); // (5.00 - 3.85) x 2 x 100, exactly
    });

    it('drops a symbol from the positions once it is flat but keeps what it realized', async () => {
      const book = account();
      await trade(book, 'AAPL', 10, '50.1');
      await trade(book, CALL, 3, '1.07');
      await trade(book, 'AAPL', -10, '52.3');

      expect(book.positions()).toEqual([{ symbol: CALL, size: 3, averagePrice: 1.07 }]);
      expect(book.realizedPLs()).toEqual([{ symbol: 'AAPL', realizedPL: 22 }]);
    });

    it('leaves cash at the starting cash plus realized profit once every position is closed', async () => {
      const book = account();
      await trade(book, 'AAPL', 10, '50.1');
      await trade(book, CALL, 3, '1.07');
      await trade(book, 'AAPL', -10, '52.3');
      await trade(book, CALL, -3, '0.94');

      expect(book.positions()).toEqual([]);
      expect(totalRealized(book.realizedPLs())).toBe(-17); // +22 on the stock, -39 on the calls
      expect(book.cash.toString()).toBe('9983');
    });

    it('conserves the basis when a position opened once is closed in two pieces', async () => {
      const book = account();
      // A price with more decimals than the apportionment can carry, so it has to round
      // and the remainder has to absorb what it gave up.
      const opening = await trade(book, 'AAPL', 3, '0.3333333333333333');
      const first = await trade(book, 'AAPL', -1, '0.5');
      const second = await trade(book, 'AAPL', -2, '0.5');

      const realized = (first.realizedPL ?? Decimal.ZERO).add(second.realizedPL ?? Decimal.ZERO);
      const roundTrip = first.totalCost.add(second.totalCost).neg().sub(opening.totalCost);

      expect(realized.toString()).toBe(roundTrip.toString()); // what the two sales made, to the last digit
      expect(book.cash.toString()).toBe(book.initialCashPosition.add(realized).toString());
      expect(book.positions()).toEqual([]);
    });

    it('reports one realized row per symbol, and none for a symbol never traded', async () => {
      const book = account();
      await trade(book, 'AAPL', 1, 10);
      await trade(book, 'AAPL', -1, 12);
      await trade(book, 'MSFT', 1, 10);
      await trade(book, 'MSFT', -1, 9);

      expect(book.realizedPLs()).toEqual([
        { symbol: 'AAPL', realizedPL: 2 },
        { symbol: 'MSFT', realizedPL: -1 },
      ]);
      expect(totalRealized(book.realizedPLs())).toBe(1);
      expect(book.symbols()).toEqual(['AAPL', 'MSFT']);
    });

    it('reports nothing rather than throwing before anything has been traded', () => {
      const book = account();

      expect(book.symbols()).toEqual([]);
      expect(book.positions()).toEqual([]);
      expect(book.realizedPLs()).toEqual([]);
      expect(book.cash.toString()).toBe('10000');
    });

    it('hands back a fresh array each call, so a caller cannot reach in and edit the book', async () => {
      const book = account();
      await trade(book, 'AAPL', 10, 50);

      expect(book.positions()).not.toBe(book.positions());
      expect(book.symbols()).not.toBe(book.symbols());
    });
  });
});
