import { Decimal, type DecimalInput } from '@fleece/utilities';

import { BacktestAccountImpl, type RealizedPL, type TradeContext, type Transaction } from '../../src/backtest/account';
import { BacktestTime } from '../../src/backtest/time';

const CALL = 'AAPL260918C00230000';
const START = 10_000;
const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const END = T0 + 1_000 * MINUTE;

function opening(commission: DecimalInput = 0): TradeContext {
  return { kind: 'open', commission, capital: 1_000 };
}

function closing(commission: DecimalInput = 0): TradeContext {
  return { kind: 'close', commission, reason: 'test' };
}

interface Driven {
  readonly clock: BacktestTime;
  readonly book: BacktestAccountImpl;
  /** Every transaction the account handed its recorder, in order. */
  readonly recorded: ReadonlyArray<Transaction>;
}

function account(): Driven {
  const clock = new BacktestTime(T0, END, MINUTE);
  const recorded: Transaction[] = [];
  const book = new BacktestAccountImpl({ record: (transaction) => recorded.push(transaction) }, START);
  clock.subscribe(book);
  return { clock, book, recorded };
}

/** Steps the clock one tick on and opens at the instant it lands on. */
async function open({ clock, book }: Driven, symbol: string, size: DecimalInput, price: DecimalInput, commission: DecimalInput = 0): Promise<Transaction> {
  await clock.forward();
  return book.record({ symbol, size, price, timestamp: clock.timestamp }, opening(commission));
}

/** Steps the clock one tick on and closes at the instant it lands on. */
async function close({ clock, book }: Driven, symbol: string, size: DecimalInput, price: DecimalInput, commission: DecimalInput = 0): Promise<Transaction> {
  await clock.forward();
  return book.record({ symbol, size, price, timestamp: clock.timestamp }, closing(commission));
}

function totalRealized(rows: ReadonlyArray<RealizedPL>): number {
  return rows.reduce((total, row) => total + row.realizedPL, 0);
}

describe('BacktestAccountImpl', () => {
  describe('as a time subscriber', () => {
    it('gives each account an id of its own, so two of them both get told', async () => {
      const clock = new BacktestTime(T0, END, MINUTE);
      const first = new BacktestAccountImpl({ record: () => {} }, START);
      const second = new BacktestAccountImpl({ record: () => {} }, START);

      expect(first.timeSubscriberId).not.toBe(second.timeSubscriberId);

      clock.subscribe(first);
      clock.subscribe(second);
      await clock.forward();

      const now = clock.timestamp;
      expect(() => first.record({ symbol: 'AAPL', size: 1, price: 10, timestamp: now }, opening())).not.toThrow();
      expect(() => second.record({ symbol: 'AAPL', size: 1, price: 10, timestamp: now }, opening())).not.toThrow();
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

      expect(() => book.record({ symbol: 'AAPL', size: 1, price: 10, timestamp: now - MINUTE }, opening())).toThrow(/clock is on/);
      expect(() => book.record({ symbol: 'AAPL', size: 1, price: 10, timestamp: now + MINUTE }, opening())).toThrow(/clock is on/);
      expect(() => book.record({ symbol: 'AAPL', size: 1, price: 10, timestamp: now }, opening())).not.toThrow();
    });

    it('lets several trades land on one instant, which is what a spread is', async () => {
      const { clock, book } = account();
      await clock.forward();
      const now = clock.timestamp;

      book.record({ symbol: 'AAPL', size: 1, price: 10, timestamp: now }, opening());
      book.record({ symbol: 'MSFT', size: 1, price: 20, timestamp: now }, opening());

      expect(book.symbols()).toEqual(['AAPL', 'MSFT']);
      expect(book.cash.toString()).toBe('9970');
    });
  });

  describe('bookkeeping', () => {
    it('closes the oldest lot first and leaves the newer one untouched', async () => {
      const driven = account();
      const { book } = driven;
      await open(driven, 'AAPL', 10, 50);
      await open(driven, 'AAPL', 10, 60);

      const sale = await close(driven, 'AAPL', -4, 70);

      expect(sale.realizedPL?.toString()).toBe('80'); // (70 - 50) x 4, not (70 - 55) x 4
      // 6 left of the 50 lot and all 10 of the 60 lot, so the blend is 56.25 rather than 55.
      expect(book.positions()).toEqual([{ symbol: 'AAPL', size: 16, averagePrice: 56.25 }]);
    });

    it('walks on to the next lot when the first one is not enough', async () => {
      const driven = account();
      const { book } = driven;
      await open(driven, 'AAPL', 10, 50);
      await open(driven, 'AAPL', 10, 60);

      const sale = await close(driven, 'AAPL', -16, 70);

      expect(sale.realizedPL?.toString()).toBe('260'); // (70 - 50) x 10 + (70 - 60) x 6
      expect(book.positions()).toEqual([{ symbol: 'AAPL', size: 4, averagePrice: 60 }]);
    });

    it('reports a break-even close as zero realized, not as nothing realized', async () => {
      const driven = account();
      const { book } = driven;
      const opened = await open(driven, 'AAPL', 10, 50);
      const closed = await close(driven, 'AAPL', -10, 50);

      expect(opened.realizedPL).toBeUndefined();
      expect(closed.realizedPL?.toString()).toBe('0');
      expect(book.realizedPLs()).toEqual([{ symbol: 'AAPL', realizedPL: 0 }]);
    });

    it('leaves a symbol it has only ever opened out of the realized rows entirely', async () => {
      const driven = account();
      const { book } = driven;
      await open(driven, 'AAPL', 10, 50);

      expect(book.realizedPLs()).toEqual([]);
      expect(book.symbols()).toEqual(['AAPL']);
    });

    it('raises cash on a short sale and realizes a gain when the cover is cheaper', async () => {
      const driven = account();
      const { book } = driven;
      await open(driven, 'AAPL', -10, 50);
      expect(book.cash.toString()).toBe('10500');

      const cover = await close(driven, 'AAPL', 4, 45);

      expect(cover.realizedPL?.toString()).toBe('20');
      expect(book.positions()).toEqual([{ symbol: 'AAPL', size: -6, averagePrice: 50 }]);
    });

    it('prices an option contract at a hundred times the premium it was given', async () => {
      const driven = account();
      const { book } = driven;
      await open(driven, CALL, 2, '3.85');

      expect(book.cash.toString()).toBe('9230'); // 10_000 - 770, not 10_000 - 7.70
      // Per share, the unit it was traded in — not the 385 a contract cost.
      expect(book.positions()).toEqual([{ symbol: CALL, size: 2, averagePrice: 3.85 }]);

      const sale = await close(driven, CALL, -2, '5.00');

      expect(sale.realizedPL?.toString()).toBe('230'); // (5.00 - 3.85) x 2 x 100, exactly
    });

    it('drops a symbol from the positions once it is flat but keeps what it realized', async () => {
      const driven = account();
      const { book } = driven;
      await open(driven, 'AAPL', 10, '50.1');
      await open(driven, CALL, 3, '1.07');
      await close(driven, 'AAPL', -10, '52.3');

      expect(book.positions()).toEqual([{ symbol: CALL, size: 3, averagePrice: 1.07 }]);
      expect(book.realizedPLs()).toEqual([{ symbol: 'AAPL', realizedPL: 22 }]);
    });

    it('leaves cash at the starting cash plus realized profit once every position is closed', async () => {
      const driven = account();
      const { book } = driven;
      await open(driven, 'AAPL', 10, '50.1', 1);
      await open(driven, CALL, 3, '1.07', '1.95');
      await close(driven, 'AAPL', -10, '52.3', 1);
      await close(driven, CALL, -3, '0.94', '1.95');

      expect(book.positions()).toEqual([]);
      expect(totalRealized(book.realizedPLs())).toBe(-22.9); // +22 on the stock, -39 on the calls, -5.90 to the broker
      expect(book.cash.toString()).toBe('9977.1');
    });

    it('conserves the basis when a position opened once is closed in two pieces', async () => {
      const driven = account();
      const { book } = driven;
      // A price with more decimals than the apportionment can carry, so it has to round
      // and the remainder has to absorb what it gave up.
      const opened = await open(driven, 'AAPL', 3, '0.3333333333333333', '0.07');
      const first = await close(driven, 'AAPL', -1, '0.5', '0.03');
      const second = await close(driven, 'AAPL', -2, '0.5', '0.03');

      const realized = (first.realizedPL ?? Decimal.ZERO).add(second.realizedPL ?? Decimal.ZERO);
      const roundTrip = first.totalCost.add(second.totalCost).neg().sub(opened.totalCost);

      expect(realized.toString()).toBe(roundTrip.toString()); // what the two sales made, to the last digit
      expect(book.cash.toString()).toBe(book.initialCashPosition.add(realized).toString());
      expect(book.positions()).toEqual([]);
    });

    it('reports one realized row per symbol, and none for a symbol never traded', async () => {
      const driven = account();
      const { book } = driven;
      await open(driven, 'AAPL', 1, 10);
      await close(driven, 'AAPL', -1, 12);
      await open(driven, 'MSFT', 1, 10);
      await close(driven, 'MSFT', -1, 9);

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
      await open(driven, 'AAPL', 10, 50);

      expect(book.positions()).not.toBe(book.positions());
      expect(book.symbols()).not.toBe(book.symbols());
    });
  });

  describe('commission', () => {
    it('comes out of cash on every fill, and out of what the position realizes once it closes', async () => {
      const driven = account();
      const { book } = driven;
      const sold = await open(driven, CALL, -1, '2.95', '0.65');

      expect(sold.commission.toString()).toBe('0.65');
      expect(sold.totalCost.toString()).toBe('-294.35');
      expect(book.cash.toString()).toBe('10294.35');
      // Per share, with the commission in the basis: 294.35 over 100 shares.
      expect(book.positions()).toEqual([{ symbol: CALL, size: -1, averagePrice: 2.9435 }]);

      const bought = await close(driven, CALL, 1, '1.40', '0.65');

      expect(bought.realizedPL?.toString()).toBe('153.7'); // 295 - 140 - 1.30
      expect(book.cash.toString()).toBe('10153.7');
    });

    it('charges each piece of a position closed in two its share of the opening commission, and all of its own', async () => {
      const driven = account();
      await open(driven, 'AAPL', 10, 50, 10);

      const first = await close(driven, 'AAPL', -4, 60, 1);
      const second = await close(driven, 'AAPL', -6, 60, 1);

      expect(first.realizedPL?.toString()).toBe('35'); // 240 - 4/10 of 510 - 1
      expect(second.realizedPL?.toString()).toBe('53'); // 360 - 6/10 of 510 - 1
    });

    it('refuses a negative commission', async () => {
      const { clock, book } = account();
      await clock.forward();
      expect(() => book.record({ symbol: 'AAPL', size: 1, price: 10, timestamp: clock.timestamp }, opening(-1))).toThrow(/never received/);
    });
  });

  describe('what a trade says it is', () => {
    it('refuses a trade that would carry a position through zero, before booking any of it', async () => {
      const driven = account();
      const { clock, book, recorded } = driven;
      await open(driven, 'AAPL', 10, 50);
      await clock.forward();

      expect(() => book.record({ symbol: 'AAPL', size: -15, price: 60, timestamp: clock.timestamp }, closing())).toThrow(/through zero/);
      expect(() => book.record({ symbol: 'AAPL', size: -15, price: 60, timestamp: clock.timestamp }, opening())).toThrow(/through zero/);
      expect(book.positions()).toEqual([{ symbol: 'AAPL', size: 10, averagePrice: 50 }]);
      expect(book.cash.toString()).toBe('9500');
      expect(recorded).toHaveLength(1);
    });

    it('takes the same flip as a close and then an open, each paying its own commission', async () => {
      const driven = account();
      const { clock, book } = driven;
      await open(driven, 'AAPL', 10, 50);
      await clock.forward();
      const now = clock.timestamp;

      const closed = book.record({ symbol: 'AAPL', size: -10, price: 60, timestamp: now }, closing(1));
      book.record({ symbol: 'AAPL', size: -5, price: 60, timestamp: now }, opening(1));

      expect(closed.realizedPL?.toString()).toBe('99');
      expect(book.positions()).toEqual([{ symbol: 'AAPL', size: -5, averagePrice: 59.8 }]);
      expect(book.cash.toString()).toBe('10398');
    });

    it('refuses an open that reduces a position and a close that does not', async () => {
      const driven = account();
      const { clock, book } = driven;
      await clock.forward();
      const now = clock.timestamp;

      expect(() => book.record({ symbol: 'AAPL', size: 5, price: 10, timestamp: now }, closing())).toThrow(/Record it as an open/);
      book.record({ symbol: 'AAPL', size: 10, price: 10, timestamp: now }, opening());
      expect(() => book.record({ symbol: 'AAPL', size: -4, price: 10, timestamp: now }, opening())).toThrow(/Record it as a close/);
      expect(() => book.record({ symbol: 'AAPL', size: 5, price: 10, timestamp: now }, closing())).toThrow(/Record it as an open/);
    });

    it('refuses a trade with no size', async () => {
      const { clock, book } = account();
      await clock.forward();
      expect(() => book.record({ symbol: 'AAPL', size: 0, price: 10, timestamp: clock.timestamp }, opening())).toThrow(/no size/);
    });

    it('hands the recorder every transaction it books, in order, with the context it was given', async () => {
      const driven = account();
      const opened = await open(driven, CALL, -1, '2.95', '0.65');
      const closed = await close(driven, CALL, 1, '1.40', '0.65');

      expect(driven.recorded).toEqual([opened, closed]);
      expect(closed).toMatchObject({ symbol: CALL, context: { kind: 'close', reason: 'test' } });
    });
  });
});
