import { Decimal, type DecimalInput } from '@fleece/utilities';

import { BacktestAccountImpl, type RealizedPL, type Transaction } from '../../src/backtest/account';
import { Time } from '../../src/backtest/time';

const CALL = 'AAPL260918C00230000';
const START = 10_000;
const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const END = T0 + 1_000 * MINUTE;

interface Driven {
  readonly clock: Time;
  readonly book: BacktestAccountImpl;
}

function account(): Driven {
  const clock = new Time(T0, END, MINUTE);
  const book = new BacktestAccountImpl(START);
  clock.subscribe(book);
  return { clock, book };
}

/** Steps the clock one tick on and trades at the instant it lands on. */
async function trade({ clock, book }: Driven, symbol: string, size: DecimalInput, price: DecimalInput): Promise<Transaction> {
  await clock.forward();
  return book.record({ symbol, size, price, timestamp: clock.timestamp });
}

function totalRealized(rows: ReadonlyArray<RealizedPL>): number {
  return rows.reduce((total, row) => total + row.realizedPL, 0);
}

describe('BacktestAccountImpl', () => {
  describe('as a time subscriber', () => {
    it('gives each account an id of its own, so two of them both get told', async () => {
      const clock = new Time(T0, END, MINUTE);
      const first = new BacktestAccountImpl(START);
      const second = new BacktestAccountImpl(START);

      expect(first.timeSubscriberId).not.toBe(second.timeSubscriberId);

      clock.subscribe(first);
      clock.subscribe(second);
      await clock.forward();

      const now = clock.timestamp;
      expect(() => first.record({ symbol: 'AAPL', size: 1, price: 10, timestamp: now })).not.toThrow();
      expect(() => second.record({ symbol: 'AAPL', size: 1, price: 10, timestamp: now })).not.toThrow();
    });

    it('refuses to be stepped to an instant it is already on or past', async () => {
      const { clock, book } = account();
      await clock.forward();

      await expect(book.forward(clock.timestamp)).rejects.toThrow(/only ever stepped forward/);
      await expect(book.forward(T0)).rejects.toThrow(/only ever stepped forward/);
    });

    it('refuses a trade stamped anywhere but the instant the clock is on', async () => {
      const { clock, book } = account();
      await clock.forward();
      const now = clock.timestamp;

      expect(() => book.record({ symbol: 'AAPL', size: 1, price: 10, timestamp: now - MINUTE })).toThrow(/clock is on/);
      expect(() => book.record({ symbol: 'AAPL', size: 1, price: 10, timestamp: now + MINUTE })).toThrow(/clock is on/);
      expect(() => book.record({ symbol: 'AAPL', size: 1, price: 10, timestamp: now })).not.toThrow();
    });

    it('lets several trades land on one instant, which is what a spread is', async () => {
      const { clock, book } = account();
      await clock.forward();
      const now = clock.timestamp;

      book.record({ symbol: 'AAPL', size: 1, price: 10, timestamp: now });
      book.record({ symbol: 'MSFT', size: 1, price: 20, timestamp: now });

      expect(book.symbols()).toEqual(['AAPL', 'MSFT']);
      expect(book.cash.toString()).toBe('9970');
    });
  });

  describe('bookkeeping', () => {
    it('closes the oldest lot first and leaves the newer one untouched', async () => {
      const driven = account();
      const { book } = driven;
      await trade(driven, 'AAPL', 10, 50);
      await trade(driven, 'AAPL', 10, 60);

      const sale = await trade(driven, 'AAPL', -4, 70);

      expect(sale.realizedPL?.toString()).toBe('80'); // (70 - 50) x 4, not (70 - 55) x 4
      // 6 left of the 50 lot and all 10 of the 60 lot, so the blend is 56.25 rather than 55.
      expect(book.positions()).toEqual([{ symbol: 'AAPL', size: 16, averagePrice: 56.25 }]);
    });

    it('walks on to the next lot when the first one is not enough', async () => {
      const driven = account();
      const { book } = driven;
      await trade(driven, 'AAPL', 10, 50);
      await trade(driven, 'AAPL', 10, 60);

      const sale = await trade(driven, 'AAPL', -16, 70);

      expect(sale.realizedPL?.toString()).toBe('260'); // (70 - 50) x 10 + (70 - 60) x 6
      expect(book.positions()).toEqual([{ symbol: 'AAPL', size: 4, averagePrice: 60 }]);
    });

    it('realizes only the closing half of a trade that carries the position through zero', async () => {
      const driven = account();
      const { book } = driven;
      await trade(driven, 'AAPL', 10, 50);

      const flip = await trade(driven, 'AAPL', -15, 60);

      expect(flip.realizedPL?.toString()).toBe('100'); // the 10 that closed, never the 5 that opened
      expect(book.positions()).toEqual([{ symbol: 'AAPL', size: -5, averagePrice: 60 }]);
      expect(book.cash.toString()).toBe('10400');
    });

    it('reports a break-even close as zero realized, not as nothing realized', async () => {
      const driven = account();
      const { book } = driven;
      const opening = await trade(driven, 'AAPL', 10, 50);
      const closing = await trade(driven, 'AAPL', -10, 50);

      expect(opening.realizedPL).toBeUndefined();
      expect(closing.realizedPL?.toString()).toBe('0');
      expect(book.realizedPLs()).toEqual([{ symbol: 'AAPL', realizedPL: 0 }]);
    });

    it('leaves a symbol it has only ever opened out of the realized rows entirely', async () => {
      const driven = account();
      const { book } = driven;
      await trade(driven, 'AAPL', 10, 50);

      expect(book.realizedPLs()).toEqual([]);
      expect(book.symbols()).toEqual(['AAPL']);
    });

    it('raises cash on a short sale and realizes a gain when the cover is cheaper', async () => {
      const driven = account();
      const { book } = driven;
      await trade(driven, 'AAPL', -10, 50);
      expect(book.cash.toString()).toBe('10500');

      const cover = await trade(driven, 'AAPL', 4, 45);

      expect(cover.realizedPL?.toString()).toBe('20');
      expect(book.positions()).toEqual([{ symbol: 'AAPL', size: -6, averagePrice: 50 }]);
    });

    it('prices an option contract at a hundred times the premium it was given', async () => {
      const driven = account();
      const { book } = driven;
      await trade(driven, CALL, 2, '3.85');

      expect(book.cash.toString()).toBe('9230'); // 10_000 - 770, not 10_000 - 7.70
      // Per share, the unit it was traded in — not the 385 a contract cost.
      expect(book.positions()).toEqual([{ symbol: CALL, size: 2, averagePrice: 3.85 }]);

      const sale = await trade(driven, CALL, -2, '5.00');

      expect(sale.realizedPL?.toString()).toBe('230'); // (5.00 - 3.85) x 2 x 100, exactly
    });

    it('drops a symbol from the positions once it is flat but keeps what it realized', async () => {
      const driven = account();
      const { book } = driven;
      await trade(driven, 'AAPL', 10, '50.1');
      await trade(driven, CALL, 3, '1.07');
      await trade(driven, 'AAPL', -10, '52.3');

      expect(book.positions()).toEqual([{ symbol: CALL, size: 3, averagePrice: 1.07 }]);
      expect(book.realizedPLs()).toEqual([{ symbol: 'AAPL', realizedPL: 22 }]);
    });

    it('leaves cash at the starting cash plus realized profit once every position is closed', async () => {
      const driven = account();
      const { book } = driven;
      await trade(driven, 'AAPL', 10, '50.1');
      await trade(driven, CALL, 3, '1.07');
      await trade(driven, 'AAPL', -10, '52.3');
      await trade(driven, CALL, -3, '0.94');

      expect(book.positions()).toEqual([]);
      expect(totalRealized(book.realizedPLs())).toBe(-17); // +22 on the stock, -39 on the calls
      expect(book.cash.toString()).toBe('9983');
    });

    it('conserves the basis when a position opened once is closed in two pieces', async () => {
      const driven = account();
      const { book } = driven;
      // A price with more decimals than the apportionment can carry, so it has to round
      // and the remainder has to absorb what it gave up.
      const opening = await trade(driven, 'AAPL', 3, '0.3333333333333333');
      const first = await trade(driven, 'AAPL', -1, '0.5');
      const second = await trade(driven, 'AAPL', -2, '0.5');

      const realized = (first.realizedPL ?? Decimal.ZERO).add(second.realizedPL ?? Decimal.ZERO);
      const roundTrip = first.totalCost.add(second.totalCost).neg().sub(opening.totalCost);

      expect(realized.toString()).toBe(roundTrip.toString()); // what the two sales made, to the last digit
      expect(book.cash.toString()).toBe(book.initialCashPosition.add(realized).toString());
      expect(book.positions()).toEqual([]);
    });

    it('reports one realized row per symbol, and none for a symbol never traded', async () => {
      const driven = account();
      const { book } = driven;
      await trade(driven, 'AAPL', 1, 10);
      await trade(driven, 'AAPL', -1, 12);
      await trade(driven, 'MSFT', 1, 10);
      await trade(driven, 'MSFT', -1, 9);

      expect(book.realizedPLs()).toEqual([
        { symbol: 'AAPL', realizedPL: 2 },
        { symbol: 'MSFT', realizedPL: -1 },
      ]);
      expect(totalRealized(book.realizedPLs())).toBe(1);
      expect(book.symbols()).toEqual(['AAPL', 'MSFT']);
    });

    it('reports nothing rather than throwing before anything has been traded', () => {
      const driven = account();
      const { book } = driven;

      expect(book.symbols()).toEqual([]);
      expect(book.positions()).toEqual([]);
      expect(book.realizedPLs()).toEqual([]);
      expect(book.cash.toString()).toBe('10000');
    });

    it('hands back a fresh array each call, so a caller cannot reach in and edit the book', async () => {
      const driven = account();
      const { book } = driven;
      await trade(driven, 'AAPL', 10, 50);

      expect(book.positions()).not.toBe(book.positions());
      expect(book.symbols()).not.toBe(book.symbols());
    });
  });
});
