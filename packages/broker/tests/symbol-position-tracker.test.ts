import { AccountBrokerTracker } from '../src/account-broker-tracker';
import { NotReservableError } from '../src/models/errors';
import { SymbolPositionTracker } from '../src/symbol-position-tracker';
import { brokerEvent } from './broker-events';

/**
 * Driven through the account tracker rather than in isolation, because buying power is
 * account-wide and half of what these rules protect.
 */
function harness(buyingPower = 100_000): { account: AccountBrokerTracker; tracker: SymbolPositionTracker } {
  const account = new AccountBrokerTracker({ brokerAccountId: 'PAPER001', now: () => 1_000 });
  account.setup(buyingPower, []);
  const tracker = account.positionTracker('AAPL') ?? (account.test({ symbol: 'AAPL', size: 1 }), account.positionTracker('AAPL'));
  if (tracker === undefined) {
    throw new Error('no tracker');
  }
  return { account, tracker };
}

describe('SymbolPositionTracker', () => {
  describe('what the broker will accept', () => {
    it('allows opposing orders to coexist while long', () => {
      // Long 10, open sell 5, then buy 20 — confirmed allowed against the live API.
      const { tracker } = harness();
      tracker.setup(10, 170);
      tracker.reserve({ symbol: 'AAPL', size: -5, unitPrice: 180 });
      expect(tracker.test({ symbol: 'AAPL', size: 20, unitPrice: 160 })).toEqual({ originalSize: 10, newSize: 30 });
    });

    it('allows a sell alongside an open buy while long', () => {
      const { tracker } = harness();
      tracker.setup(10, 170);
      tracker.reserve({ symbol: 'AAPL', size: 20, unitPrice: 160 });
      expect(tracker.test({ symbol: 'AAPL', size: -9, unitPrice: 180 })).toBeDefined();
    });

    it('refuses an order that would take the position through zero', () => {
      // Long 10, sell 15 — confirmed refused. To zero is allowed, through it is not.
      const { tracker } = harness();
      tracker.setup(10, 170);
      expect(tracker.test({ symbol: 'AAPL', size: -15, unitPrice: 180 })).toBeUndefined();
      expect(tracker.test({ symbol: 'AAPL', size: -10, unitPrice: 180 })).toBeDefined();
    });

    it('refuses to open a short while a buy is outstanding and the position is flat', () => {
      const { tracker } = harness();
      tracker.setup(0, 0);
      tracker.reserve({ symbol: 'AAPL', size: 10, unitPrice: 160 });
      expect(tracker.test({ symbol: 'AAPL', size: -10, unitPrice: 180 })).toBeUndefined();
    });

    it('refuses an order the account cannot afford', () => {
      const { tracker } = harness(1_000);
      tracker.setup(0, 0);
      expect(tracker.test({ symbol: 'AAPL', size: 10, unitPrice: 500 })).toBeUndefined();
      expect(tracker.test({ symbol: 'AAPL', size: 1, unitPrice: 500 })).toBeDefined();
    });

    it('does not check buying power on a sell, which raises cash rather than spending it', () => {
      const { tracker } = harness(0);
      tracker.setup(10, 170);
      expect(tracker.test({ symbol: 'AAPL', size: -5, unitPrice: 180 })).toBeDefined();
    });
  });

  describe('what a reservation holds', () => {
    it('holds shares when reducing, leaving the position untouched', () => {
      const { tracker } = harness();
      tracker.setup(10, 170);
      tracker.reserve({ symbol: 'AAPL', size: -4, unitPrice: 180 });
      expect(tracker.positionSize).toBe(10);
      expect(tracker.freeSize).toBe(6);
    });

    it('holds buying power when increasing, leaving free size untouched', () => {
      const { account, tracker } = harness(100_000);
      tracker.setup(10, 170);
      tracker.reserve({ symbol: 'AAPL', size: 5, unitPrice: 200 });
      expect(account.availableBuyingPower).toBe(99_000);
      expect(tracker.freeSize).toBe(10);
    });

    it('stops the same shares being sold twice', () => {
      const { tracker } = harness();
      tracker.setup(10, 170);
      tracker.reserve({ symbol: 'AAPL', size: -6, unitPrice: 180 });
      expect(() => tracker.reserve({ symbol: 'AAPL', size: -6, unitPrice: 180 })).toThrow(NotReservableError);
      expect(tracker.reserve({ symbol: 'AAPL', size: -4, unitPrice: 180 })).toEqual(expect.any(String));
    });

    it('stops the same cash being spent twice', () => {
      const { account, tracker } = harness(1_000);
      tracker.setup(0, 0);
      tracker.reserve({ symbol: 'AAPL', size: 5, unitPrice: 200 });
      expect(account.availableBuyingPower).toBe(0);
      expect(() => tracker.reserve({ symbol: 'AAPL', size: 1, unitPrice: 200 })).toThrow(NotReservableError);
    });

    it('reserves nothing for a buy with no price estimate, and says so', () => {
      const { account, tracker } = harness(1_000);
      tracker.setup(0, 0);
      tracker.reserve({ symbol: 'AAPL', size: 5 });
      expect(account.availableBuyingPower).toBe(1_000);
    });
  });

  describe('cancelling', () => {
    it('gives back held shares', () => {
      const { tracker } = harness();
      tracker.setup(10, 170);
      const reservationId = tracker.reserve({ symbol: 'AAPL', size: -4, unitPrice: 180 });
      expect(tracker.freeSize).toBe(6);
      tracker.cancel(reservationId);
      expect(tracker.freeSize).toBe(10);
    });

    it('gives back held buying power', () => {
      const { account, tracker } = harness(100_000);
      tracker.setup(0, 0);
      const reservationId = tracker.reserve({ symbol: 'AAPL', size: 5, unitPrice: 200 });
      expect(account.availableBuyingPower).toBe(99_000);
      tracker.cancel(reservationId);
      expect(account.availableBuyingPower).toBe(100_000);
    });

    it('ignores an id it does not know', () => {
      const { tracker } = harness();
      tracker.setup(10, 170);
      expect(() => tracker.cancel('never-issued')).not.toThrow();
    });
  });

  describe('applying fills', () => {
    it('moves the position and the cost basis', () => {
      const { tracker } = harness();
      tracker.setup(0, 0);
      const reservationId = tracker.reserve({ symbol: 'AAPL', size: 10, unitPrice: 100 });
      tracker.track(brokerEvent({ reservationId, status: 'filled', qty: 10, filledQty: 10, filledAvgPrice: 100 }));
      expect(tracker.positionSize).toBe(10);
      expect(tracker.unitCost).toBe(100);
      expect(tracker.freeSize).toBe(10);
    });

    it('records realised profit when a fill reduces the position', () => {
      const { tracker } = harness();
      tracker.setup(10, 100);
      const reservationId = tracker.reserve({ symbol: 'AAPL', size: -4, unitPrice: 150 });
      tracker.track(brokerEvent({ reservationId, side: 'sell', status: 'filled', qty: -4, filledQty: -4, filledAvgPrice: 150 }));
      expect(tracker.profits.map((entry) => entry.profit)).toEqual([200]);
      expect(tracker.positionSize).toBe(6);
    });

    it('takes a buy out of its own reservation before the account balance', () => {
      // Reserved 1700; filling 4 at 168 costs 672, which the reservation covers in
      // full — so the account balance must not move again.
      const { account, tracker } = harness(100_000);
      tracker.setup(0, 0);
      const reservationId = tracker.reserve({ symbol: 'AAPL', size: 10, unitPrice: 170 });
      expect(account.availableBuyingPower).toBe(98_300);

      tracker.track(brokerEvent({ reservationId, status: 'partially_filled', qty: 10, filledQty: 4, filledAvgPrice: 168 }));
      expect(account.availableBuyingPower).toBe(98_300);
    });

    it('takes a sell out of its own locked shares before the free size', () => {
      const { tracker } = harness();
      tracker.setup(10, 100);
      const reservationId = tracker.reserve({ symbol: 'AAPL', size: -5, unitPrice: 150 });
      expect(tracker.freeSize).toBe(5);

      tracker.track(brokerEvent({ reservationId, side: 'sell', status: 'partially_filled', qty: -5, filledQty: -3, filledAvgPrice: 150 }));
      expect(tracker.positionSize).toBe(7);
      // The 3 came out of the locked 5, so the free size is unchanged.
      expect(tracker.freeSize).toBe(5);
    });

    it('applies only what is new as an order fills in pieces', () => {
      const { tracker } = harness();
      tracker.setup(0, 0);
      const reservationId = tracker.reserve({ symbol: 'AAPL', size: 10, unitPrice: 100 });
      tracker.track(brokerEvent({ reservationId, status: 'partially_filled', qty: 10, filledQty: 4, filledAvgPrice: 100 }));
      tracker.track(brokerEvent({ reservationId, status: 'filled', qty: 10, filledQty: 10, filledAvgPrice: 106 }));
      expect(tracker.positionSize).toBe(10);
      expect(tracker.unitCost).toBe(106);
    });

    it('applies nothing when the same event arrives twice', () => {
      const { tracker } = harness();
      tracker.setup(0, 0);
      const reservationId = tracker.reserve({ symbol: 'AAPL', size: 10, unitPrice: 100 });
      const event = brokerEvent({ reservationId, status: 'partially_filled', qty: 10, filledQty: 4, filledAvgPrice: 100 });
      tracker.track(event);
      tracker.track(event);
      expect(tracker.positionSize).toBe(4);
    });

    it('applies nothing when an older event arrives after a newer one', () => {
      const { tracker } = harness();
      tracker.setup(0, 0);
      const reservationId = tracker.reserve({ symbol: 'AAPL', size: 10, unitPrice: 100 });
      tracker.track(brokerEvent({ reservationId, status: 'partially_filled', qty: 10, filledQty: 8, filledAvgPrice: 100 }));
      tracker.track(brokerEvent({ reservationId, status: 'partially_filled', qty: 10, filledQty: 4, filledAvgPrice: 100 }));
      expect(tracker.positionSize).toBe(8);
    });
  });

  describe('releasing a reservation on a terminal event', () => {
    it('frees the shares a cancelled sell was holding', () => {
      // Without this the account slowly becomes untradable: every cancelled sell would
      // keep its shares locked forever.
      const { tracker } = harness();
      tracker.setup(10, 100);
      const reservationId = tracker.reserve({ symbol: 'AAPL', size: -5, unitPrice: 150 });
      expect(tracker.freeSize).toBe(5);

      tracker.track(brokerEvent({ reservationId, side: 'sell', status: 'canceled', qty: -5, filledQty: 0 }));
      expect(tracker.freeSize).toBe(10);
      expect(tracker.positionSize).toBe(10);
    });

    it('frees the buying power a cancelled buy was holding', () => {
      const { account, tracker } = harness(100_000);
      tracker.setup(0, 0);
      const reservationId = tracker.reserve({ symbol: 'AAPL', size: 10, unitPrice: 170 });
      tracker.track(brokerEvent({ reservationId, status: 'canceled', qty: 10, filledQty: 0 }));
      expect(account.availableBuyingPower).toBe(100_000);
    });

    it('frees only the unused remainder of a partially filled order', () => {
      const { tracker } = harness();
      tracker.setup(10, 100);
      const reservationId = tracker.reserve({ symbol: 'AAPL', size: -5, unitPrice: 150 });
      tracker.track(brokerEvent({ reservationId, side: 'sell', status: 'canceled', qty: -5, filledQty: -3, filledAvgPrice: 150 }));
      expect(tracker.positionSize).toBe(7);
      expect(tracker.freeSize).toBe(7);
    });
  });

  describe('orders it did not place', () => {
    it('treats what an unknown order has already filled as a baseline, not as news', () => {
      // A leg order, or one placed by hand on the broker's website. Its already-filled
      // shares are assumed to be in the position the broker reported at setup, so
      // re-applying them here would count them twice.
      const { tracker } = harness();
      tracker.setup(0, 0);
      tracker.track(brokerEvent({ id: 'external-1', status: 'partially_filled', qty: 10, filledQty: 4, filledAvgPrice: 100 }));
      expect(tracker.positionSize).toBe(0);
    });

    it('applies everything the order fills after it was adopted', () => {
      const { tracker } = harness();
      tracker.setup(0, 0);
      tracker.track(brokerEvent({ id: 'external-1', status: 'partially_filled', qty: 10, filledQty: 4, filledAvgPrice: 100 }));
      // Cumulative 10 at 106 against a baseline of 4 at 100: 6 new shares at 110.
      tracker.track(brokerEvent({ id: 'external-1', status: 'filled', qty: 10, filledQty: 10, filledAvgPrice: 106 }));
      expect(tracker.positionSize).toBe(6);
      expect(tracker.unitCost).toBe(110);
    });

    it('applies every fill of an order first seen before it filled', () => {
      // The ordinary case for a leg order: the first sighting is `new`, so the baseline
      // is zero and nothing is missed.
      const { tracker } = harness();
      tracker.setup(0, 0);
      tracker.track(brokerEvent({ id: 'leg-1', status: 'new', qty: 10, filledQty: 0 }));
      tracker.track(brokerEvent({ id: 'leg-1', status: 'filled', qty: 10, filledQty: 10, filledAvgPrice: 100 }));
      expect(tracker.positionSize).toBe(10);
      expect(tracker.unitCost).toBe(100);
    });

    it('ignores a terminal event for an order whose reservation is already gone', () => {
      // The REST backfill applied the fill; the websocket delivers it minutes later.
      const { tracker } = harness();
      tracker.setup(0, 0);
      const reservationId = tracker.reserve({ symbol: 'AAPL', size: 10, unitPrice: 100 });
      tracker.track(brokerEvent({ reservationId, status: 'filled', qty: 10, filledQty: 10, filledAvgPrice: 100 }));
      expect(tracker.positionSize).toBe(10);

      tracker.track(brokerEvent({ reservationId, status: 'filled', qty: 10, filledQty: 10, filledAvgPrice: 100 }));
      expect(tracker.positionSize).toBe(10);
    });

    it('finds a reservation by broker order id when the id predates a restart', () => {
      const { tracker } = harness();
      tracker.setup(10, 100, [{ brokerOrderId: 'order-from-before', unfilledSize: -5, partialFilledSize: 0, partialTotalCost: 0 }]);
      expect(tracker.freeSize).toBe(5);

      // The event still carries the reservation id issued before the restart, which
      // this process never saw; the fallback keys on the broker order id.
      tracker.track(brokerEvent({ id: 'order-from-before', reservationId: 'issued-before-restart', side: 'sell', status: 'filled', qty: -5, filledQty: -5, filledAvgPrice: 150 }));
      expect(tracker.positionSize).toBe(5);
      expect(tracker.freeSize).toBe(5);
    });
  });

  describe('setup from the broker view', () => {
    it('starts everything free when nothing is open', () => {
      const { tracker } = harness();
      tracker.setup(10, 170);
      expect(tracker.positionSize).toBe(10);
      expect(tracker.freeSize).toBe(10);
      expect(tracker.unitCost).toBe(170);
    });

    it('locks shares already committed to an open sell', () => {
      const { tracker } = harness();
      tracker.setup(20, 170, [{ brokerOrderId: 'open-sell', unfilledSize: -5, partialFilledSize: 0, partialTotalCost: 0 }]);
      expect(tracker.positionSize).toBe(20);
      expect(tracker.freeSize).toBe(15);
    });

    it('holds buying power for an open limit buy', () => {
      const { account, tracker } = harness(100_000);
      tracker.setup(0, 0, [{ brokerOrderId: 'open-buy', unfilledSize: 10, partialFilledSize: 0, partialTotalCost: 0, limitPrice: 150 }]);
      expect(account.availableBuyingPower).toBe(98_500);
    });

    it('refuses to be set up twice', () => {
      const { tracker } = harness();
      tracker.setup(10, 170);
      expect(() => tracker.setup(10, 170)).toThrow();
    });
  });
});
