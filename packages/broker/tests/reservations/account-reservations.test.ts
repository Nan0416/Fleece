import { AccountReservations } from '../../src/reservations/account-reservations';
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
    const noEvents = async (): Promise<void> => {};

    it('holds the limit price of a limit order and the estimate of a market one', async () => {
      const { reservations } = harness();
      await reservations.seed();

      reservations.hold({ type: 'limit', symbol: 'AAPL', size: d(10), assetClass: 'equity', limitPrice: d(100), accountId: 'MOMENTUM01', onEvent: noEvents });
      expect(shows(reservations.availableBuyingPower)).toBe('99000');

      reservations.hold({ type: 'market', symbol: 'AAPL', size: d(10), assetClass: 'equity', unitPrice: d(50), accountId: 'MOMENTUM01', onEvent: noEvents });
      expect(shows(reservations.availableBuyingPower)).toBe('98500');
    });

    it('holds nothing for a spread, whose requirement is the width rather than its legs', async () => {
      // Returning no reservation is the honest answer; holding the sum of the legs would
      // be a number that looks like one. It warns as it does so — asserted by reading the
      // log nowhere, because tests here assert on behaviour.
      const { reservations } = harness();
      await reservations.seed();

      const held = reservations.hold({
        type: 'mleg',
        size: d(1),
        legs: [
          { symbol: 'AMZN261016C00280000', ratioQty: d(1), side: 'sell', positionIntent: 'sell_to_open' },
          { symbol: 'AMZN261016C00285000', ratioQty: d(1), side: 'buy', positionIntent: 'buy_to_open' },
        ],
        netLimitPrice: d('-0.85'),
        accountId: 'MOMENTUM01',
        onEvent: async () => {},
      });

      expect(held).toBeUndefined();
      expect(shows(reservations.availableBuyingPower)).toBe('100000');
    });

    it('gives a hold back when the order never reached the broker', async () => {
      const { reservations } = harness();
      await reservations.seed();

      const reservationId = reservations.hold({ type: 'limit', symbol: 'AAPL', size: d(10), assetClass: 'equity', limitPrice: d(100), accountId: 'MOMENTUM01', onEvent: noEvents });
      expect(reservationId).toEqual(expect.any(String));
      reservations.release(reservationId ?? '');

      expect(shows(reservations.availableBuyingPower)).toBe('100000');
    });
  });
});
