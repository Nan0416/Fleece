import { Decimal } from '../../src/utils/decimal';
import { reconcilePosition } from '../../src/utils/position-reconciliation';

const d = (value: string | number): Decimal => Decimal.of(value);

/** Most cases read more naturally as a size and a price than as a size and a total. */
const cost = (size: string | number, price: string | number): Decimal => d(size).mul(d(price));

describe('reconcilePosition', () => {
  describe('opening a position', () => {
    it('takes its cost basis from the trade that opened it', () => {
      const result = reconcilePosition({ positionSize: d(0), positionTotalCost: d(0), transactionSize: d(10), transactionTotalCost: cost(10, 150) });
      expect(result.positionSize.toString()).toBe('10');
      expect(result.positionTotalCost.toString()).toBe('1500');
    });

    it('realises nothing, which is distinct from realising zero', () => {
      const result = reconcilePosition({ positionSize: d(0), positionTotalCost: d(0), transactionSize: d(10), transactionTotalCost: cost(10, 150) });
      expect(result.transactionProfit).toBeUndefined();
    });

    it('consumes buying power equal to the notional', () => {
      const result = reconcilePosition({ positionSize: d(0), positionTotalCost: d(0), transactionSize: d(10), transactionTotalCost: cost(10, 150) });
      expect(result.buyingPowerDelta.toString()).toBe('-1500');
    });

    it('consumes buying power to open a short, just as it does to open a long', () => {
      const result = reconcilePosition({ positionSize: d(0), positionTotalCost: d(0), transactionSize: d(-10), transactionTotalCost: cost(-10, 150) });
      expect(result.positionSize.toString()).toBe('-10');
      expect(result.positionTotalCost.toString()).toBe('-1500');
      expect(result.buyingPowerDelta.toString()).toBe('-1500');
    });
  });

  describe('adding to a position', () => {
    it('weights the new cost basis by size, not by trade count', () => {
      const result = reconcilePosition({ positionSize: d(10), positionTotalCost: cost(10, 100), transactionSize: d(30), transactionTotalCost: cost(30, 200) });
      expect(result.positionSize.toString()).toBe('40');
      // 1000 + 6000, which is a unit cost of 175 without ever computing one.
      expect(result.positionTotalCost.toString()).toBe('7000');
    });

    it('adds without rounding, however many times it is done', () => {
      // A third of a dollar is not representable in binary and does not terminate in
      // decimal either, so this is the shape that used to accumulate error.
      let size = d(0);
      let totalCost = d(0);
      for (let i = 0; i < 1000; i++) {
        const result = reconcilePosition({ positionSize: size, positionTotalCost: totalCost, transactionSize: d('0.001'), transactionTotalCost: d('0.333333333') });
        size = result.positionSize;
        totalCost = result.positionTotalCost;
      }
      expect(size.toString()).toBe('1');
      expect(totalCost.toString()).toBe('333.333333');
    });

    it('realises nothing', () => {
      const result = reconcilePosition({ positionSize: d(10), positionTotalCost: cost(10, 100), transactionSize: d(10), transactionTotalCost: cost(10, 200) });
      expect(result.transactionProfit).toBeUndefined();
    });
  });

  describe('reducing a position', () => {
    it('leaves the cost basis of what remains untouched, which is what makes it average cost', () => {
      const result = reconcilePosition({ positionSize: d(10), positionTotalCost: cost(10, 100), transactionSize: d(-4), transactionTotalCost: cost(-4, 130) });
      expect(result.positionSize.toString()).toBe('6');
      expect(result.positionTotalCost.toString()).toBe('600');
    });

    it('realises the spread between the basis retired and the proceeds', () => {
      const result = reconcilePosition({ positionSize: d(10), positionTotalCost: cost(10, 100), transactionSize: d(-4), transactionTotalCost: cost(-4, 130) });
      expect(result.transactionProfit?.toString()).toBe('120');
    });

    it('realises a gain on a short covered below its entry', () => {
      const result = reconcilePosition({ positionSize: d(-10), positionTotalCost: cost(-10, 50), transactionSize: d(4), transactionTotalCost: cost(4, 45) });
      expect(result.positionSize.toString()).toBe('-6');
      expect(result.positionTotalCost.toString()).toBe('-300');
      expect(result.transactionProfit?.toString()).toBe('20');
    });

    it('releases buying power rather than consuming it', () => {
      const result = reconcilePosition({ positionSize: d(10), positionTotalCost: cost(10, 100), transactionSize: d(-4), transactionTotalCost: cost(-4, 130) });
      expect(result.buyingPowerDelta.toString()).toBe('520');
    });

    it('reports a break-even close as zero rather than as nothing', () => {
      const result = reconcilePosition({ positionSize: d(4), positionTotalCost: cost(4, 100), transactionSize: d(-4), transactionTotalCost: cost(-4, 100) });
      expect(result.transactionProfit?.toString()).toBe('0');
    });

    it('never reports a realised profit of negative zero', () => {
      const result = reconcilePosition({ positionSize: d(4), positionTotalCost: cost(4, 100), transactionSize: d(-4), transactionTotalCost: cost(-4, 100) });
      expect(result.transactionProfit?.toString()).not.toBe('-0');
    });
  });

  describe('closing a position out entirely', () => {
    it('retires the whole basis exactly, with no division and so no residue', () => {
      // A basis of 1000 over 3 units has no exact unit cost. Closing it must still take
      // all of it: the general apportionment formula would round, and a position closed
      // in full would keep a sliver of basis that nothing holds.
      const result = reconcilePosition({ positionSize: d(3), positionTotalCost: d(1000), transactionSize: d(-3), transactionTotalCost: d(-1200) });
      expect(result.positionSize.toString()).toBe('0');
      expect(result.positionTotalCost.toString()).toBe('0');
      expect(result.transactionProfit?.toString()).toBe('200');
    });
  });

  describe('a position carried through zero', () => {
    it('closes at the old basis and opens the remainder at the trade price', () => {
      // Selling 15 while long 10 is two events: the 10 realise against a basis of 100,
      // and the remaining 5 open a short at 110. Averaging across the flip would give a
      // basis that is neither.
      const result = reconcilePosition({ positionSize: d(10), positionTotalCost: cost(10, 100), transactionSize: d(-15), transactionTotalCost: cost(-15, 110) });
      expect(result.positionSize.toString()).toBe('-5');
      expect(result.positionTotalCost.toString()).toBe('-550');
      expect(result.transactionProfit?.toString()).toBe('100');
    });

    it('splits the trade cost across the two halves without creating or destroying any', () => {
      const transactionTotalCost = cost(-15, '110.37');
      const result = reconcilePosition({ positionSize: d(10), positionTotalCost: cost(10, 100), transactionSize: d(-15), transactionTotalCost });
      // What closed realised against the old basis; what opened became the new one. The
      // two together are exactly the trade, which is what the subtraction guarantees.
      const closedProceeds = result.transactionProfit?.add(d(1000));
      expect(closedProceeds?.add(result.positionTotalCost.neg()).toString()).toBe(transactionTotalCost.neg().toString());
    });
  });

  describe('conservation', () => {
    // position.totalCost == sum(transaction.totalCost) + sum(transaction.profit), exactly.
    // Every trade moves the basis by exactly `totalCost + profit`, so a position is the
    // running sum of its own log and nothing rounds its way out of it.
    const applyAll = (trades: ReadonlyArray<readonly [Decimal, Decimal]>) => {
      let size = d(0);
      let totalCost = d(0);
      let summedCost = d(0);
      let summedProfit = d(0);
      for (const [transactionSize, transactionTotalCost] of trades) {
        const result = reconcilePosition({ positionSize: size, positionTotalCost: totalCost, transactionSize, transactionTotalCost });
        size = result.positionSize;
        totalCost = result.positionTotalCost;
        summedCost = summedCost.add(transactionTotalCost);
        summedProfit = summedProfit.add(result.transactionProfit ?? d(0));
      }
      return { size, totalCost, summedCost, summedProfit };
    };

    it('holds across partial sales out of a basis that does not divide evenly', () => {
      const run = applyAll([
        [d(3), d(1000)],
        [d(-1), d(-340)],
        [d(-1), d(-330)],
      ]);
      expect(run.totalCost.toString()).toBe(run.summedCost.add(run.summedProfit).toString());
    });

    it('holds across fractional sizes', () => {
      const run = applyAll([
        [d('0.3'), d('3.33')],
        [d('-0.1'), d('-1.2')],
        [d('-0.1'), d('-1.1')],
      ]);
      expect(run.totalCost.toString()).toBe(run.summedCost.add(run.summedProfit).toString());
    });

    it('holds across a flip, and leaves nothing behind when the position finally closes', () => {
      const run = applyAll([
        [d(3), d(1000)],
        [d(-7), d('-2400')],
        [d(4), d('1370')],
      ]);
      expect(run.size.toString()).toBe('0');
      expect(run.totalCost.toString()).toBe('0');
      expect(run.summedCost.add(run.summedProfit).toString()).toBe('0');
    });
  });

  describe('instruments other than equity', () => {
    it('accounts an option in contracts and dollars, so nothing has to know about the multiplier', () => {
      // Two contracts at a premium of 3.85 move 770 dollars. The size counts contracts,
      // the cost carries the dollars, and this function never sees a multiplier.
      const result = reconcilePosition({ positionSize: d(0), positionTotalCost: d(0), transactionSize: d(2), transactionTotalCost: d(770) });
      expect(result.positionSize.toString()).toBe('2');
      expect(result.positionTotalCost.toString()).toBe('770');
      expect(result.buyingPowerDelta.toString()).toBe('-770');
    });
  });
});
