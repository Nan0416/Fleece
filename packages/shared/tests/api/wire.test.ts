import { InvalidRequestError } from '../../src/errors';
import { reviveBrokerOrder, revivePosition, reviveTransaction } from '../../src/api/wire';
import { Position, Transaction } from '../../src/models/account';
import { BrokerOrder } from '../../src/models/order';
import { Decimal } from '../../src/utils/decimal';

const d = (value: string): Decimal => Decimal.of(value);

/** What the service actually does to a response: `res.json(...)`, then a caller parses it. */
function overTheWire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe('crossing the wire', () => {
  const position: Position = {
    accountId: 'MOMENTUM01',
    symbol: 'AAPL',
    assetClass: 'equity',
    size: d('17.666666667'),
    totalCost: d('1793.166666700'),
    multiplier: Decimal.ONE,
    avgPrice: d('101.500000000'),
    premium: d('101.500000000'),
    createdAt: 1_700_000_000_000,
    lastUpdatedAt: 1_700_000_001_000,
  };

  it('keeps every digit a double could not have held', () => {
    // 1793.1666667 and 17.666666667 are the shapes that make this worth doing: as
    // doubles they are approximations, and a JSON number would ship the approximation.
    const revived = revivePosition(overTheWire(position));
    expect(revived.size.toString()).toBe('17.666666667');
    expect(revived.totalCost.toString()).toBe('1793.1666667');
  });

  it('sends a decimal as a string, never as a JSON number', () => {
    const raw = JSON.parse(JSON.stringify(position));
    expect(typeof raw.size).toBe('string');
    expect(typeof raw.totalCost).toBe('string');
  });

  it('refuses a JSON number on the way back in, rather than accepting the rounding', () => {
    // A caller — or a proxy, or a hand-written client — sending a number has already
    // lost whatever the double could not hold. Taking it would make the loss ours.
    expect(() => revivePosition({ ...JSON.parse(JSON.stringify(position)), size: 17.666666667 })).toThrow(InvalidRequestError);
  });

  it('round-trips an exact value through arithmetic that a double would drift on', () => {
    const revived = revivePosition(overTheWire(position));
    let running = Decimal.ZERO;
    for (let i = 0; i < 3; i++) {
      running = running.add(revived.size);
    }
    expect(running.toString()).toBe('53.000000001');
  });

  describe('a transaction', () => {
    const transaction: Transaction = {
      referenceId: 'order-1',
      accountId: 'MOMENTUM01',
      symbol: 'AAPL',
      assetClass: 'equity',
      timestamp: 1_700_000_000_000,
      size: d('-4'),
      totalCost: d('-440'),
      multiplier: Decimal.ONE,
      avgPrice: d('110'),
      premium: d('110'),
      profit: d('40'),
      roi: d('909.09'),
      cumulativeSize: d('6'),
      cumulativeTotalCost: d('600'),
      cumulativeProfit: d('40'),
      cumulativeAvgPrice: d('100'),
    };

    it('keeps a realised profit of nothing distinct from a realised profit of zero', () => {
      // The legacy conflated them, so a break-even close reported no profit at all.
      // Both have to survive a JSON round trip as themselves.
      const nothing = reviveTransaction(overTheWire({ ...transaction, profit: undefined, roi: undefined }));
      expect(nothing.profit).toBeUndefined();

      const zero = reviveTransaction(overTheWire({ ...transaction, profit: Decimal.ZERO, roi: Decimal.ZERO }));
      expect(zero.profit?.toString()).toBe('0');
    });

    it('keeps a negative size negative, which is the only thing marking a sell', () => {
      expect(reviveTransaction(overTheWire(transaction)).size.toString()).toBe('-4');
    });
  });

  describe('a broker order', () => {
    const parent: BrokerOrder = {
      brokerOrderId: 'mleg-parent-1',
      accountId: 'MOMENTUM01',
      broker: 'alpaca',
      brokerAccountId: 'PA1',
      assetClass: 'option',
      multiplier: d('100'),
      status: 'filled',
      orderClass: 'mleg',
      orderType: 'limit',
      timeInForce: 'day',
      extendedHours: false,
      qty: Decimal.ONE,
      limitPrice: d('-0.85'),
      filledQty: Decimal.ONE,
      filledAvgPrice: d('-0.9'),
      createdAt: 1_700_000_000_000,
      lastUpdatedAt: 1_700_000_000_000,
    };

    it('keeps a composite parent without an instrument, rather than inventing one', () => {
      const revived = reviveBrokerOrder(overTheWire(parent));
      expect(revived.symbol).toBeUndefined();
      expect(revived.side).toBeUndefined();
    });

    it("keeps the sign on a spread's net price, which is what says credit rather than debit", () => {
      const revived = reviveBrokerOrder(overTheWire(parent));
      expect(revived.filledAvgPrice?.toString()).toBe('-0.9');
      expect(revived.limitPrice?.toString()).toBe('-0.85');
    });

    it('carries a status it has never seen through unchanged', () => {
      // Free text on purpose: a broker inventing a status must survive the round trip,
      // not be rejected on the way through.
      const revived = reviveBrokerOrder(overTheWire({ ...parent, status: 'some_status_alpaca_added_last_week' }));
      expect(revived.status).toBe('some_status_alpaca_added_last_week');
    });

    it('names the field that was wrong, not just the object', () => {
      expect(() => reviveBrokerOrder(overTheWire({ ...parent, orderClass: 'spread' }))).toThrow(/brokerOrder\.orderClass/);
    });
  });
});
