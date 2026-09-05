import { AccountReservations } from '../../src/reservations/account-reservations';
import { optionEvent } from '../broker-events';
import { alpacaOrder, FakeAlpacaRestClient, multiLegOrder } from '../fake-alpaca';
import { d, shows } from '../decimals';

const account = { accountId: 'PAPER001', live: false };

function harness(): { reservations: AccountReservations; rest: FakeAlpacaRestClient } {
  const rest = new FakeAlpacaRestClient();
  return { reservations: new AccountReservations({ account, reader: rest, now: () => 1_000 }), rest };
}

describe('AccountReservations', () => {
  describe('seeding from the broker view', () => {
    it('takes buying power and positions from the broker itself', async () => {
      // Without this the first order placed after a restart is measured against an
      // account believed to be empty.
      const { reservations, rest } = harness();
      rest.buyingPower = '50000';
      rest.positions = [{ symbol: 'AAPL', asset_id: 'a', asset_class: 'us_equity', qty: '10', avg_entry_price: '170', side: 'long', market_value: '1700', cost_basis: '1700' }];

      await reservations.seed();

      expect(shows(reservations.availableBuyingPower)).toBe('50000');
      expect(shows(reservations.tracker.positionTracker('AAPL')?.positionSize)).toBe('10');
      expect(shows(reservations.tracker.positionTracker('AAPL')?.unitCost)).toBe('170');
    });

    it('takes an option position at the dollars Alpaca already multiplied out', async () => {
      // `cost_basis` is in dollars and `avg_entry_price` is a premium per share. Reading
      // the second and multiplying would be a second place to get the multiplier wrong.
      const { reservations, rest } = harness();
      rest.positions = [
        { symbol: 'AMZN261016C00280000', asset_id: 'a', asset_class: 'us_option', qty: '2', avg_entry_price: '3.85', side: 'long', market_value: '800', cost_basis: '770' },
      ];

      await reservations.seed();

      expect(shows(reservations.tracker.positionTracker('AMZN261016C00280000')?.totalCost)).toBe('770');
    });

    it('locks shares already committed to an order open at the broker', async () => {
      const { reservations, rest } = harness();
      rest.positions = [{ symbol: 'AAPL', asset_id: 'a', asset_class: 'us_equity', qty: '20', avg_entry_price: '170', side: 'long', market_value: '3400', cost_basis: '3400' }];
      rest.openOrders = [alpacaOrder({ id: 'open-sell', side: 'sell', qty: '5', filled_qty: '0' })];

      await reservations.seed();

      expect(shows(reservations.tracker.positionTracker('AAPL')?.freeSize)).toBe('15');
    });

    it('holds buying power for an open limit buy, carrying its limit price through', async () => {
      // The legacy parsed and validated the limit price and then hard-coded 0 into the
      // pending order, so every open limit buy reserved nothing across a restart.
      const { reservations, rest } = harness();
      rest.buyingPower = '100000';
      rest.openOrders = [alpacaOrder({ id: 'open-buy', side: 'buy', qty: '10', filled_qty: '0', order_type: 'limit', type: 'limit', limit_price: '150' })];

      await reservations.seed();

      expect(shows(reservations.availableBuyingPower)).toBe('98500');
    });

    it('seeds an open spread from its contracts, not from the parent that trades none', async () => {
      // The parent has no symbol and a side that means nothing. Seeding from it opens a
      // position keyed on the empty string, signed from that side — a wrong number that
      // looks like a right one.
      const { reservations, rest } = harness();
      rest.openOrders = [multiLegOrder()];

      await reservations.seed();

      expect(reservations.tracker.positionTracker('')).toBeUndefined();
      expect(reservations.tracker.positionTracker('AMZN261016C00280000')).toBeDefined();
      expect(reservations.tracker.positionTracker('AMZN261016C00285000')).toBeDefined();
    });

    it('refuses to start against an account with no buying power', async () => {
      const { reservations, rest } = harness();
      rest.buyingPower = '0';
      await expect(reservations.seed()).rejects.toThrow(/cannot be traded against/);
    });

    it('reports an unreadable number from the broker as the broker being unusable', async () => {
      const { reservations, rest } = harness();
      rest.buyingPower = 'unavailable';
      await expect(reservations.seed()).rejects.toThrow(/which is not a number/);
    });
  });

  describe('holding against a placement', () => {
    it('holds what the order will cost, in dollars', async () => {
      const { reservations } = harness();
      await reservations.seed();

      reservations.hold({ symbol: 'AAPL', size: d(10), assetClass: 'equity', unitPrice: d(100) });
      expect(shows(reservations.availableBuyingPower)).toBe('99000');

      // A contract quoted at 3.85 costs $385, which is the multiplier's whole job.
      reservations.hold({ symbol: 'AMZN261016C00280000', size: d(2), assetClass: 'option', unitPrice: d('3.85') });
      expect(shows(reservations.availableBuyingPower)).toBe('98230');
    });

    it('refuses what it cannot price, rather than holding something plausible', async () => {
      // A short call's requirement is margin against an unbounded loss. Which order
      // types have no reservation to ask for at all — a spread — is L3's business, since
      // this layer never sees an order type.
      const { reservations } = harness();
      await reservations.seed();

      expect(() => reservations.hold({ symbol: 'AMZN261016C00280000', size: d(-1), assetClass: 'option', unitPrice: d('3.85') })).toThrow(/margin/);
    });

    it('gives a hold back when the order never reached the broker', async () => {
      const { reservations } = harness();
      await reservations.seed();

      const reservationId = reservations.hold({ symbol: 'AAPL', size: d(10), assetClass: 'equity', unitPrice: d(100) });
      reservations.release(reservationId);

      expect(shows(reservations.availableBuyingPower)).toBe('100000');
    });

    it('notes an order it holds nothing for, so its fills are still applied', async () => {
      // What a spread needs: nothing held, but the contracts named, or a fill arriving
      // as the first event anyone sees would be ignored as a late duplicate.
      const { reservations } = harness();
      await reservations.seed();

      reservations.expectOrder('AMZN261016C00280000', 'leg-1');
      reservations.track(optionEvent({ id: 'leg-1', symbol: 'AMZN261016C00280000', status: 'filled', qty: d(-1), filledQty: d(-1), filledAvgPrice: d('3.85') }));

      expect(shows(reservations.tracker.positionTracker('AMZN261016C00280000')?.totalCost)).toBe('-385');
    });
  });
});
