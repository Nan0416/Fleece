import { Decimal } from '@fleece/shared';
import { AccountBrokerTracker } from '../../src/reservations/account-broker-tracker';
import { brokerEvent } from '../broker-events';
import { d, shows } from '../decimals';

const SHORT_LEG = 'AMZN261016C00280000';
const LONG_LEG = 'AMZN261016C00285000';

function account(buyingPower = 100_000): AccountBrokerTracker {
  const tracker = new AccountBrokerTracker({ brokerAccountId: 'PAPER001', now: () => 1_000 });
  tracker.setup(d(buyingPower), []);
  return tracker;
}

describe('AccountBrokerTracker', () => {
  describe('buying power belongs to the account, not to a symbol', () => {
    it('spends one balance across every symbol', () => {
      const tracker = account(10_000);
      tracker.reserve({ symbol: 'AAPL', size: d(10), assetClass: 'equity', unitPrice: d(500) });
      expect(shows(tracker.availableBuyingPower)).toBe('5000');
      // MSFT has its own position tracker and no buying power of its own.
      expect(tracker.test({ symbol: 'MSFT', size: d(20), assetClass: 'equity', unitPrice: d(500) })).toBeUndefined();
    });

    it('finds the symbol a reservation belongs to from the id alone', () => {
      // The caller holds a reservation id and nothing else, so cancelling has to work
      // without being told which symbol it was for.
      const tracker = account(10_000);
      const reservationId = tracker.reserve({ symbol: 'AAPL', size: d(10), assetClass: 'equity', unitPrice: d(500) });
      tracker.cancel(reservationId);
      expect(shows(tracker.availableBuyingPower)).toBe('10000');
    });
  });

  describe('a spread', () => {
    it('books each contract against itself and the parent against nothing', () => {
      // The parent trades no instrument: its size counts spreads and its price is the
      // package's signed net, `-0.9` for a credit. Booking it would open a position
      // keyed on nothing at a price no contract traded at — and double-count the
      // spread, whose real dollars are on the legs.
      const tracker = account(100_000);

      for (const event of openingEvents()) {
        tracker.track(event);
      }
      for (const event of fillEvents()) {
        tracker.track(event);
      }

      expect(shows(tracker.positionTracker(SHORT_LEG)?.positionSize)).toBe('-1');
      expect(shows(tracker.positionTracker(SHORT_LEG)?.totalCost)).toBe('-385');
      expect(shows(tracker.positionTracker(LONG_LEG)?.positionSize)).toBe('1');
      expect(shows(tracker.positionTracker(LONG_LEG)?.totalCost)).toBe('295');
      // 385 raised by the short and 295 paid for the long, and nothing at all for the
      // parent — which would have booked its own -90 on top had it been tracked.
      expect(shows(tracker.availableBuyingPower)).toBe('99320');
    });
  });
});

/** The parent and its two contracts, as they first arrive. */
function openingEvents(): ReadonlyArray<ReturnType<typeof brokerEvent>> {
  return [
    brokerEvent({ id: 'mleg-parent', symbol: undefined, assetClass: 'option', orderClass: 'mleg', side: undefined, status: 'new', qty: d(1), filledQty: Decimal.ZERO }),
    brokerEvent({
      id: 'mleg-leg-short',
      parentBrokerOrderId: 'mleg-parent',
      symbol: SHORT_LEG,
      assetClass: 'option',
      orderClass: 'mleg',
      side: 'sell',
      status: 'new',
      qty: d(-1),
      filledQty: Decimal.ZERO,
    }),
    brokerEvent({
      id: 'mleg-leg-long',
      parentBrokerOrderId: 'mleg-parent',
      symbol: LONG_LEG,
      assetClass: 'option',
      orderClass: 'mleg',
      side: 'buy',
      status: 'new',
      qty: d(1),
      filledQty: Decimal.ZERO,
    }),
  ];
}

/** The same three, filled. The parent's price is the spread's net credit. */
function fillEvents(): ReadonlyArray<ReturnType<typeof brokerEvent>> {
  return [
    brokerEvent({
      id: 'mleg-parent',
      symbol: undefined,
      assetClass: 'option',
      orderClass: 'mleg',
      side: undefined,
      status: 'filled',
      qty: d(1),
      filledQty: d(1),
      filledAvgPrice: d('-0.9'),
    }),
    brokerEvent({
      id: 'mleg-leg-short',
      parentBrokerOrderId: 'mleg-parent',
      symbol: SHORT_LEG,
      assetClass: 'option',
      orderClass: 'mleg',
      side: 'sell',
      status: 'filled',
      qty: d(-1),
      filledQty: d(-1),
      filledAvgPrice: d('3.85'),
    }),
    brokerEvent({
      id: 'mleg-leg-long',
      parentBrokerOrderId: 'mleg-parent',
      symbol: LONG_LEG,
      assetClass: 'option',
      orderClass: 'mleg',
      side: 'buy',
      status: 'filled',
      qty: d(1),
      filledQty: d(1),
      filledAvgPrice: d('2.95'),
    }),
  ];
}
