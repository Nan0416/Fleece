import { Decimal } from '@fleece/shared';
import { AccountBrokerTracker } from '../../src/reservations/account-broker-tracker';
import { NotReservableError } from '../../src/models/errors';
import { PendingOrder } from '../../src/models/trackers';
import { SymbolPositionTracker } from '../../src/reservations/symbol-position-tracker';
import { brokerEvent, optionEvent } from '../broker-events';
import { d, shows } from '../decimals';

/**
 * Driven through the account tracker rather than in isolation, because buying power is
 * account-wide and half of what these rules protect.
 */
function harness(buyingPower = 100_000, symbol = 'AAPL'): { account: AccountBrokerTracker; tracker: SymbolPositionTracker } {
  const account = new AccountBrokerTracker({ brokerAccountId: 'PAPER001', now: () => 1_000 });
  account.setup(d(buyingPower), []);
  // `test` is what creates the tracker for a symbol never seen; it takes no hold.
  account.test({ symbol, size: d(1), assetClass: 'equity' });
  const tracker = account.positionTracker(symbol);
  if (tracker === undefined) {
    throw new Error('no tracker');
  }
  return { account, tracker };
}

/** An order already open at the broker. Equity unless a multiplier says otherwise. */
function pendingOrder(overrides: Partial<PendingOrder> & { readonly brokerOrderId: string; readonly unfilledSize: Decimal }): PendingOrder {
  return { partialFilledSize: Decimal.ZERO, partialTotalCost: Decimal.ZERO, multiplier: Decimal.ONE, ...overrides };
}

describe('SymbolPositionTracker', () => {
  describe('what the broker will accept', () => {
    it('allows opposing orders to coexist while long', () => {
      // Long 10, open sell 5, then buy 20 — confirmed allowed against the live API.
      const { tracker } = harness();
      tracker.setup(d(10), d(1700));
      tracker.reserve({ symbol: 'AAPL', size: d(-5), assetClass: 'equity', unitPrice: d(180) });
      const result = tracker.test({ symbol: 'AAPL', size: d(20), assetClass: 'equity', unitPrice: d(160) });
      expect({ originalSize: shows(result?.originalSize), newSize: shows(result?.newSize) }).toEqual({ originalSize: '10', newSize: '30' });
    });

    it('allows a sell alongside an open buy while long', () => {
      const { tracker } = harness();
      tracker.setup(d(10), d(1700));
      tracker.reserve({ symbol: 'AAPL', size: d(20), assetClass: 'equity', unitPrice: d(160) });
      expect(tracker.test({ symbol: 'AAPL', size: d(-9), assetClass: 'equity', unitPrice: d(180) })).toBeDefined();
    });

    it('refuses an order that would take the position through zero', () => {
      // Long 10, sell 15 — confirmed refused. To zero is allowed, through it is not.
      const { tracker } = harness();
      tracker.setup(d(10), d(1700));
      expect(tracker.test({ symbol: 'AAPL', size: d(-15), assetClass: 'equity', unitPrice: d(180) })).toBeUndefined();
      expect(tracker.test({ symbol: 'AAPL', size: d(-10), assetClass: 'equity', unitPrice: d(180) })).toBeDefined();
    });

    it('refuses to open a short while a buy is outstanding and the position is flat', () => {
      const { tracker } = harness();
      tracker.setup(Decimal.ZERO, Decimal.ZERO);
      tracker.reserve({ symbol: 'AAPL', size: d(10), assetClass: 'equity', unitPrice: d(160) });
      expect(tracker.test({ symbol: 'AAPL', size: d(-10), assetClass: 'equity', unitPrice: d(180) })).toBeUndefined();
    });

    it('refuses an order the account cannot afford', () => {
      const { tracker } = harness(1_000);
      tracker.setup(Decimal.ZERO, Decimal.ZERO);
      expect(tracker.test({ symbol: 'AAPL', size: d(10), assetClass: 'equity', unitPrice: d(500) })).toBeUndefined();
      expect(tracker.test({ symbol: 'AAPL', size: d(1), assetClass: 'equity', unitPrice: d(500) })).toBeDefined();
    });

    it('does not check buying power on a sell, which raises cash rather than spending it', () => {
      const { tracker } = harness(0);
      tracker.setup(d(10), d(1700));
      expect(tracker.test({ symbol: 'AAPL', size: d(-5), assetClass: 'equity', unitPrice: d(180) })).toBeDefined();
    });

    it('accepts a fractional size, which Alpaca fills', () => {
      const { tracker } = harness();
      tracker.setup(Decimal.ZERO, Decimal.ZERO);
      const result = tracker.test({ symbol: 'AAPL', size: d('0.5'), assetClass: 'equity', unitPrice: d(180) });
      expect(shows(result?.newSize)).toBe('0.5');
    });
  });

  describe('what a reservation holds', () => {
    it('holds shares when reducing, leaving the position untouched', () => {
      const { tracker } = harness();
      tracker.setup(d(10), d(1700));
      tracker.reserve({ symbol: 'AAPL', size: d(-4), assetClass: 'equity', unitPrice: d(180) });
      expect(shows(tracker.positionSize)).toBe('10');
      expect(shows(tracker.freeSize)).toBe('6');
    });

    it('holds buying power when increasing, leaving free size untouched', () => {
      const { account, tracker } = harness(100_000);
      tracker.setup(d(10), d(1700));
      tracker.reserve({ symbol: 'AAPL', size: d(5), assetClass: 'equity', unitPrice: d(200) });
      expect(shows(account.availableBuyingPower)).toBe('99000');
      expect(shows(tracker.freeSize)).toBe('10');
    });

    it('holds a contract at its premium times the multiplier, not at its premium', () => {
      // The whole of open item 2b in one assertion: two contracts quoted at 3.85 cost
      // $770, and holding $7.70 would let the account place a hundred times what it can
      // afford.
      const { account, tracker } = harness(100_000, 'AMZN261016C00280000');
      tracker.setup(Decimal.ZERO, Decimal.ZERO);
      tracker.reserve({ symbol: 'AMZN261016C00280000', size: d(2), assetClass: 'option', unitPrice: d('3.85') });
      expect(shows(account.availableBuyingPower)).toBe('99230');
    });

    it('honours an adjusted contract multiplier over the asset class default', () => {
      const { account, tracker } = harness(100_000, 'AMZN261016C00280000');
      tracker.setup(Decimal.ZERO, Decimal.ZERO);
      tracker.reserve({ symbol: 'AMZN261016C00280000', size: d(1), assetClass: 'option', unitPrice: d('3.85'), multiplier: d(80) });
      expect(shows(account.availableBuyingPower)).toBe('99692');
    });

    it('stops the same shares being sold twice', () => {
      const { tracker } = harness();
      tracker.setup(d(10), d(1700));
      tracker.reserve({ symbol: 'AAPL', size: d(-6), assetClass: 'equity', unitPrice: d(180) });
      expect(() => tracker.reserve({ symbol: 'AAPL', size: d(-6), assetClass: 'equity', unitPrice: d(180) })).toThrow(NotReservableError);
      expect(tracker.reserve({ symbol: 'AAPL', size: d(-4), assetClass: 'equity', unitPrice: d(180) })).toEqual(expect.any(String));
    });

    it('stops the same cash being spent twice', () => {
      const { account, tracker } = harness(1_000);
      tracker.setup(Decimal.ZERO, Decimal.ZERO);
      tracker.reserve({ symbol: 'AAPL', size: d(5), assetClass: 'equity', unitPrice: d(200) });
      expect(shows(account.availableBuyingPower)).toBe('0');
      expect(() => tracker.reserve({ symbol: 'AAPL', size: d(1), assetClass: 'equity', unitPrice: d(200) })).toThrow(NotReservableError);
    });

    it('reserves nothing for a buy with no price estimate, and says so', () => {
      const { account, tracker } = harness(1_000);
      tracker.setup(Decimal.ZERO, Decimal.ZERO);
      tracker.reserve({ symbol: 'AAPL', size: d(5), assetClass: 'equity' });
      expect(shows(account.availableBuyingPower)).toBe('1000');
    });
  });

  describe('what it refuses to price', () => {
    it('refuses to open a short option position, whose requirement is margin rather than premium', () => {
      // A naked call's requirement is unbounded, so holding the premium would be a
      // number that looks like an answer. Refusing is the honest one.
      const { tracker } = harness(100_000, 'AMZN261016C00280000');
      tracker.setup(Decimal.ZERO, Decimal.ZERO);
      expect(() => tracker.reserve({ symbol: 'AMZN261016C00280000', size: d(-1), assetClass: 'option', unitPrice: d('3.85') })).toThrow(NotReservableError);
    });

    it('refuses it in `test` too, so nothing is told an order is possible that reserving would reject', () => {
      const { tracker } = harness(100_000, 'AMZN261016C00280000');
      tracker.setup(Decimal.ZERO, Decimal.ZERO);
      expect(tracker.test({ symbol: 'AMZN261016C00280000', size: d(-1), assetClass: 'option', unitPrice: d('3.85') })).toBeUndefined();
    });

    it('refuses it however the order is priced, since an unpriced order holds nothing at all', () => {
      const { tracker } = harness(100_000, 'AMZN261016C00280000');
      tracker.setup(Decimal.ZERO, Decimal.ZERO);
      expect(() => tracker.reserve({ symbol: 'AMZN261016C00280000', size: d(-1), assetClass: 'option' })).toThrow(/margin/);
    });

    it('allows selling contracts it already holds, which hands units back rather than needing margin', () => {
      const { tracker } = harness(100_000, 'AMZN261016C00280000');
      tracker.setup(d(2), d(770));
      tracker.reserve({ symbol: 'AMZN261016C00280000', size: d(-1), assetClass: 'option', unitPrice: d('4.20') });
      expect(shows(tracker.freeSize)).toBe('1');
    });
  });

  describe('cancelling', () => {
    it('gives back held shares', () => {
      const { tracker } = harness();
      tracker.setup(d(10), d(1700));
      const reservationId = tracker.reserve({ symbol: 'AAPL', size: d(-4), assetClass: 'equity', unitPrice: d(180) });
      expect(shows(tracker.freeSize)).toBe('6');
      tracker.cancel(reservationId);
      expect(shows(tracker.freeSize)).toBe('10');
    });

    it('gives back held buying power', () => {
      const { account, tracker } = harness(100_000);
      tracker.setup(Decimal.ZERO, Decimal.ZERO);
      const reservationId = tracker.reserve({ symbol: 'AAPL', size: d(5), assetClass: 'equity', unitPrice: d(200) });
      expect(shows(account.availableBuyingPower)).toBe('99000');
      tracker.cancel(reservationId);
      expect(shows(account.availableBuyingPower)).toBe('100000');
    });

    it('ignores an id it does not know', () => {
      const { tracker } = harness();
      tracker.setup(d(10), d(1700));
      expect(() => tracker.cancel('never-issued')).not.toThrow();
    });
  });

  describe('applying fills', () => {
    it('moves the position and the cost basis', () => {
      const { tracker } = harness();
      tracker.setup(Decimal.ZERO, Decimal.ZERO);
      const reservationId = tracker.reserve({ symbol: 'AAPL', size: d(10), assetClass: 'equity', unitPrice: d(100) });
      tracker.track(brokerEvent({ reservationId, status: 'filled', qty: d(10), filledQty: d(10), filledAvgPrice: d(100) }));
      expect(shows(tracker.positionSize)).toBe('10');
      expect(shows(tracker.totalCost)).toBe('1000');
      expect(shows(tracker.unitCost)).toBe('100');
      expect(shows(tracker.freeSize)).toBe('10');
    });

    it('books an option fill in dollars, the same way the ledger does', () => {
      // Two contracts filled at a premium of 3.85 moved $770. A tracker that booked
      // $7.70 would disagree with the ledger about what the account spent, and would
      // drift from it on every option trade.
      const { account, tracker } = harness(100_000, 'AMZN261016C00280000');
      tracker.setup(Decimal.ZERO, Decimal.ZERO);
      const reservationId = tracker.reserve({ symbol: 'AMZN261016C00280000', size: d(2), assetClass: 'option', unitPrice: d('3.85') });
      tracker.track(optionEvent({ reservationId, status: 'filled', filledQty: d(2), filledAvgPrice: d('3.85') }));

      expect(shows(tracker.positionSize)).toBe('2');
      expect(shows(tracker.totalCost)).toBe('770');
      expect(shows(account.availableBuyingPower)).toBe('99230');
    });

    it('records realised profit when a fill reduces the position', () => {
      const { tracker } = harness();
      tracker.setup(d(10), d(1000));
      const reservationId = tracker.reserve({ symbol: 'AAPL', size: d(-4), assetClass: 'equity', unitPrice: d(150) });
      tracker.track(brokerEvent({ reservationId, side: 'sell', status: 'filled', qty: d(-4), filledQty: d(-4), filledAvgPrice: d(150) }));
      expect(tracker.profits.map((entry) => shows(entry.profit))).toEqual(['200']);
      expect(shows(tracker.positionSize)).toBe('6');
    });

    it('takes a buy out of its own reservation before the account balance', () => {
      // Reserved 1700; filling 4 at 168 costs 672, which the reservation covers in
      // full — so the account balance must not move again.
      const { account, tracker } = harness(100_000);
      tracker.setup(Decimal.ZERO, Decimal.ZERO);
      const reservationId = tracker.reserve({ symbol: 'AAPL', size: d(10), assetClass: 'equity', unitPrice: d(170) });
      expect(shows(account.availableBuyingPower)).toBe('98300');

      tracker.track(brokerEvent({ reservationId, status: 'partially_filled', qty: d(10), filledQty: d(4), filledAvgPrice: d(168) }));
      expect(shows(account.availableBuyingPower)).toBe('98300');
    });

    it('takes a sell out of its own locked shares before the free size', () => {
      const { tracker } = harness();
      tracker.setup(d(10), d(1000));
      const reservationId = tracker.reserve({ symbol: 'AAPL', size: d(-5), assetClass: 'equity', unitPrice: d(150) });
      expect(shows(tracker.freeSize)).toBe('5');

      tracker.track(brokerEvent({ reservationId, side: 'sell', status: 'partially_filled', qty: d(-5), filledQty: d(-3), filledAvgPrice: d(150) }));
      expect(shows(tracker.positionSize)).toBe('7');
      // The 3 came out of the locked 5, so the free size is unchanged.
      expect(shows(tracker.freeSize)).toBe('5');
    });

    it('applies only what is new as an order fills in pieces', () => {
      const { tracker } = harness();
      tracker.setup(Decimal.ZERO, Decimal.ZERO);
      const reservationId = tracker.reserve({ symbol: 'AAPL', size: d(10), assetClass: 'equity', unitPrice: d(100) });
      tracker.track(brokerEvent({ reservationId, status: 'partially_filled', qty: d(10), filledQty: d(4), filledAvgPrice: d(100) }));
      tracker.track(brokerEvent({ reservationId, status: 'filled', qty: d(10), filledQty: d(10), filledAvgPrice: d(106) }));
      expect(shows(tracker.positionSize)).toBe('10');
      expect(shows(tracker.totalCost)).toBe('1060');
    });

    it('applies nothing when the same event arrives twice', () => {
      const { tracker } = harness();
      tracker.setup(Decimal.ZERO, Decimal.ZERO);
      const reservationId = tracker.reserve({ symbol: 'AAPL', size: d(10), assetClass: 'equity', unitPrice: d(100) });
      const event = brokerEvent({ reservationId, status: 'partially_filled', qty: d(10), filledQty: d(4), filledAvgPrice: d(100) });
      tracker.track(event);
      tracker.track(event);
      expect(shows(tracker.positionSize)).toBe('4');
    });

    it('applies nothing when an older event arrives after a newer one', () => {
      const { tracker } = harness();
      tracker.setup(Decimal.ZERO, Decimal.ZERO);
      const reservationId = tracker.reserve({ symbol: 'AAPL', size: d(10), assetClass: 'equity', unitPrice: d(100) });
      tracker.track(brokerEvent({ reservationId, status: 'partially_filled', qty: d(10), filledQty: d(8), filledAvgPrice: d(100) }));
      tracker.track(brokerEvent({ reservationId, status: 'partially_filled', qty: d(10), filledQty: d(4), filledAvgPrice: d(100) }));
      expect(shows(tracker.positionSize)).toBe('8');
    });

    it('conserves the basis exactly when a position is closed out', () => {
      // The invariant the ledger asserts, asserted here too: what leaves the position
      // plus what is realised is exactly what was in it, with no residue rounded away.
      const { tracker } = harness();
      tracker.setup(d(3), d('412.63'));
      const reservationId = tracker.reserve({ symbol: 'AAPL', size: d(-3), assetClass: 'equity', unitPrice: d('140.01') });
      tracker.track(brokerEvent({ reservationId, side: 'sell', status: 'filled', qty: d(-3), filledQty: d(-3), filledAvgPrice: d('140.01') }));

      expect(shows(tracker.positionSize)).toBe('0');
      expect(shows(tracker.totalCost)).toBe('0');
      expect(tracker.profits.map((entry) => shows(entry.profit))).toEqual(['7.4']);
    });
  });

  describe('releasing a reservation on a terminal event', () => {
    it('frees the shares a cancelled sell was holding', () => {
      // Without this the account slowly becomes untradable: every cancelled sell would
      // keep its shares locked forever.
      const { tracker } = harness();
      tracker.setup(d(10), d(1000));
      const reservationId = tracker.reserve({ symbol: 'AAPL', size: d(-5), assetClass: 'equity', unitPrice: d(150) });
      expect(shows(tracker.freeSize)).toBe('5');

      tracker.track(brokerEvent({ reservationId, side: 'sell', status: 'canceled', qty: d(-5), filledQty: Decimal.ZERO }));
      expect(shows(tracker.freeSize)).toBe('10');
      expect(shows(tracker.positionSize)).toBe('10');
    });

    it('frees the buying power a cancelled buy was holding', () => {
      const { account, tracker } = harness(100_000);
      tracker.setup(Decimal.ZERO, Decimal.ZERO);
      const reservationId = tracker.reserve({ symbol: 'AAPL', size: d(10), assetClass: 'equity', unitPrice: d(170) });
      tracker.track(brokerEvent({ reservationId, status: 'canceled', qty: d(10), filledQty: Decimal.ZERO }));
      expect(shows(account.availableBuyingPower)).toBe('100000');
    });

    it('frees only the unused remainder of a partially filled order', () => {
      const { tracker } = harness();
      tracker.setup(d(10), d(1000));
      const reservationId = tracker.reserve({ symbol: 'AAPL', size: d(-5), assetClass: 'equity', unitPrice: d(150) });
      tracker.track(brokerEvent({ reservationId, side: 'sell', status: 'canceled', qty: d(-5), filledQty: d(-3), filledAvgPrice: d(150) }));
      expect(shows(tracker.positionSize)).toBe('7');
      expect(shows(tracker.freeSize)).toBe('7');
    });
  });

  describe('orders it did not place', () => {
    it('treats what an unknown order has already filled as a baseline, not as news', () => {
      // A leg order, or one placed by hand on the broker's website. Its already-filled
      // shares are assumed to be in the position the broker reported at setup, so
      // re-applying them here would count them twice.
      const { tracker } = harness();
      tracker.setup(Decimal.ZERO, Decimal.ZERO);
      tracker.track(brokerEvent({ id: 'external-1', status: 'partially_filled', qty: d(10), filledQty: d(4), filledAvgPrice: d(100) }));
      expect(shows(tracker.positionSize)).toBe('0');
    });

    it('applies everything the order fills after it was adopted', () => {
      const { tracker } = harness();
      tracker.setup(Decimal.ZERO, Decimal.ZERO);
      tracker.track(brokerEvent({ id: 'external-1', status: 'partially_filled', qty: d(10), filledQty: d(4), filledAvgPrice: d(100) }));
      // Cumulative 10 at 106 against a baseline of 4 at 100: 6 new shares for 660.
      tracker.track(brokerEvent({ id: 'external-1', status: 'filled', qty: d(10), filledQty: d(10), filledAvgPrice: d(106) }));
      expect(shows(tracker.positionSize)).toBe('6');
      expect(shows(tracker.totalCost)).toBe('660');
    });

    it('takes the baseline of an adopted option order in dollars too', () => {
      const { tracker } = harness(100_000, 'AMZN261016C00280000');
      tracker.setup(Decimal.ZERO, Decimal.ZERO);
      tracker.track(optionEvent({ id: 'external-option', status: 'partially_filled', qty: d(2), filledQty: d(1), filledAvgPrice: d('3.85') }));
      tracker.track(optionEvent({ id: 'external-option', status: 'filled', qty: d(2), filledQty: d(2), filledAvgPrice: d('3.85') }));
      expect(shows(tracker.positionSize)).toBe('1');
      expect(shows(tracker.totalCost)).toBe('385');
    });

    it('applies every fill of an order first seen before it filled', () => {
      // The ordinary case for a leg order: the first sighting is `new`, so the baseline
      // is zero and nothing is missed.
      const { tracker } = harness();
      tracker.setup(Decimal.ZERO, Decimal.ZERO);
      tracker.track(brokerEvent({ id: 'leg-1', status: 'new', qty: d(10), filledQty: Decimal.ZERO }));
      tracker.track(brokerEvent({ id: 'leg-1', status: 'filled', qty: d(10), filledQty: d(10), filledAvgPrice: d(100) }));
      expect(shows(tracker.positionSize)).toBe('10');
      expect(shows(tracker.totalCost)).toBe('1000');
    });

    it('ignores a terminal event for an order whose reservation is already gone', () => {
      // The REST backfill applied the fill; the websocket delivers it minutes later.
      const { tracker } = harness();
      tracker.setup(Decimal.ZERO, Decimal.ZERO);
      const reservationId = tracker.reserve({ symbol: 'AAPL', size: d(10), assetClass: 'equity', unitPrice: d(100) });
      tracker.track(brokerEvent({ reservationId, status: 'filled', qty: d(10), filledQty: d(10), filledAvgPrice: d(100) }));
      expect(shows(tracker.positionSize)).toBe('10');

      tracker.track(brokerEvent({ reservationId, status: 'filled', qty: d(10), filledQty: d(10), filledAvgPrice: d(100) }));
      expect(shows(tracker.positionSize)).toBe('10');
    });

    it('finds a reservation by broker order id when the id predates a restart', () => {
      const { tracker } = harness();
      tracker.setup(d(10), d(1000), [pendingOrder({ brokerOrderId: 'order-from-before', unfilledSize: d(-5) })]);
      expect(shows(tracker.freeSize)).toBe('5');

      // The event still carries the reservation id issued before the restart, which
      // this process never saw; the fallback keys on the broker order id.
      tracker.track(
        brokerEvent({ id: 'order-from-before', reservationId: 'issued-before-restart', side: 'sell', status: 'filled', qty: d(-5), filledQty: d(-5), filledAvgPrice: d(150) }),
      );
      expect(shows(tracker.positionSize)).toBe('5');
      expect(shows(tracker.freeSize)).toBe('5');
    });
  });

  describe('setup from the broker view', () => {
    it('starts everything free when nothing is open', () => {
      const { tracker } = harness();
      tracker.setup(d(10), d(1700));
      expect(shows(tracker.positionSize)).toBe('10');
      expect(shows(tracker.freeSize)).toBe('10');
      expect(shows(tracker.unitCost)).toBe('170');
    });

    it('locks shares already committed to an open sell', () => {
      const { tracker } = harness();
      tracker.setup(d(20), d(3400), [pendingOrder({ brokerOrderId: 'open-sell', unfilledSize: d(-5) })]);
      expect(shows(tracker.positionSize)).toBe('20');
      expect(shows(tracker.freeSize)).toBe('15');
    });

    it('holds buying power for an open limit buy', () => {
      const { account, tracker } = harness(100_000);
      tracker.setup(Decimal.ZERO, Decimal.ZERO, [pendingOrder({ brokerOrderId: 'open-buy', unfilledSize: d(10), limitPrice: d(150) })]);
      expect(shows(account.availableBuyingPower)).toBe('98500');
    });

    it('holds an open option order at its premium times the multiplier', () => {
      const { account, tracker } = harness(100_000, 'AMZN261016C00280000');
      tracker.setup(Decimal.ZERO, Decimal.ZERO, [pendingOrder({ brokerOrderId: 'open-buy', unfilledSize: d(2), limitPrice: d('3.85'), multiplier: d(100) })]);
      expect(shows(account.availableBuyingPower)).toBe('99230');
    });

    it('refuses to be set up twice', () => {
      const { tracker } = harness();
      tracker.setup(d(10), d(1700));
      expect(() => tracker.setup(d(10), d(1700))).toThrow();
    });
  });
});
