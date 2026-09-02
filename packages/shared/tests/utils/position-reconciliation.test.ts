import { reconcilePosition } from '../../src/utils/position-reconciliation';

describe('reconcilePosition', () => {
  describe('opening a position', () => {
    it('takes its cost basis from the trade that opened it', () => {
      const result = reconcilePosition({ positionSize: 0, positionUnitCost: 0, transactionSize: 10, transactionUnitCost: 150 });
      expect(result.positionSize).toBe(10);
      expect(result.positionUnitCost).toBe(150);
    });

    it('realises nothing, which is distinct from realising zero', () => {
      const result = reconcilePosition({ positionSize: 0, positionUnitCost: 0, transactionSize: 10, transactionUnitCost: 150 });
      expect(result.transactionProfit).toBeUndefined();
    });

    it('consumes buying power equal to the notional', () => {
      const result = reconcilePosition({ positionSize: 0, positionUnitCost: 0, transactionSize: 10, transactionUnitCost: 150 });
      expect(result.buyingPowerDelta).toBe(-1500);
    });

    it('consumes buying power to open a short, just as it does to open a long', () => {
      const result = reconcilePosition({ positionSize: 0, positionUnitCost: 0, transactionSize: -10, transactionUnitCost: 150 });
      expect(result.positionSize).toBe(-10);
      expect(result.positionUnitCost).toBe(150);
      expect(result.buyingPowerDelta).toBe(-1500);
    });
  });

  describe('adding to a position', () => {
    it('weights the new cost basis by size, not by trade count', () => {
      const result = reconcilePosition({ positionSize: 10, positionUnitCost: 100, transactionSize: 30, transactionUnitCost: 200 });
      expect(result.positionSize).toBe(40);
      expect(result.positionUnitCost).toBe(175);
    });

    it('realises nothing', () => {
      const result = reconcilePosition({ positionSize: 10, positionUnitCost: 100, transactionSize: 10, transactionUnitCost: 200 });
      expect(result.transactionProfit).toBeUndefined();
    });

    it('averages a short the same way a long is averaged', () => {
      const result = reconcilePosition({ positionSize: -10, positionUnitCost: 100, transactionSize: -30, transactionUnitCost: 200 });
      expect(result.positionSize).toBe(-40);
      expect(result.positionUnitCost).toBe(175);
    });
  });

  describe('reducing a position', () => {
    it('realises the spread against the cost basis, on the shares sold only', () => {
      const result = reconcilePosition({ positionSize: 10, positionUnitCost: 100, transactionSize: -4, transactionUnitCost: 150 });
      expect(result.transactionProfit).toBe(200);
    });

    it('leaves the cost basis of what remains untouched, which is what makes it average cost', () => {
      const result = reconcilePosition({ positionSize: 10, positionUnitCost: 100, transactionSize: -4, transactionUnitCost: 150 });
      expect(result.positionSize).toBe(6);
      expect(result.positionUnitCost).toBe(100);
    });

    it('realises a loss as a negative number', () => {
      const result = reconcilePosition({ positionSize: 10, positionUnitCost: 100, transactionSize: -4, transactionUnitCost: 80 });
      expect(result.transactionProfit).toBe(-80);
    });

    it('profits on a short when the price falls', () => {
      const result = reconcilePosition({ positionSize: -10, positionUnitCost: 100, transactionSize: 4, transactionUnitCost: 80 });
      expect(result.transactionProfit).toBe(80);
      expect(result.positionSize).toBe(-6);
      expect(result.positionUnitCost).toBe(100);
    });

    it('releases buying power equal to the notional', () => {
      const result = reconcilePosition({ positionSize: 10, positionUnitCost: 100, transactionSize: -4, transactionUnitCost: 150 });
      expect(result.buyingPowerDelta).toBe(600);
    });

    it('reports a break-even close as exactly zero, not as nothing realised', () => {
      // The legacy line was `transactionProfit ? round(...) : undefined`, so a close at
      // the cost basis fell through the truthiness check and was recorded as if the
      // trade had realised nothing at all.
      const result = reconcilePosition({ positionSize: 10, positionUnitCost: 100, transactionSize: -4, transactionUnitCost: 100 });
      expect(result.transactionProfit).toBe(0);
    });
  });

  describe('closing a position exactly', () => {
    it('resets the cost basis, so the next trade opens rather than averages', () => {
      const result = reconcilePosition({ positionSize: 10, positionUnitCost: 100, transactionSize: -10, transactionUnitCost: 150 });
      expect(result.positionSize).toBe(0);
      expect(result.positionUnitCost).toBe(0);
      expect(result.transactionProfit).toBe(500);
    });
  });

  describe('a trade that carries the position through zero', () => {
    it('realises against the old basis only for the shares that were held', () => {
      // Long 10 at 100, sell 15 at 150: 10 shares realise 50 each, and nothing is
      // realised on the 5 that open the short.
      const result = reconcilePosition({ positionSize: 10, positionUnitCost: 100, transactionSize: -15, transactionUnitCost: 150 });
      expect(result.transactionProfit).toBe(500);
    });

    it('opens the remainder at the trade price rather than averaging across the flip', () => {
      const result = reconcilePosition({ positionSize: 10, positionUnitCost: 100, transactionSize: -15, transactionUnitCost: 150 });
      expect(result.positionSize).toBe(-5);
      expect(result.positionUnitCost).toBe(150);
    });

    it('flips a short to a long on the same terms', () => {
      const result = reconcilePosition({ positionSize: -10, positionUnitCost: 100, transactionSize: 15, transactionUnitCost: 80 });
      expect(result.transactionProfit).toBe(200);
      expect(result.positionSize).toBe(5);
      expect(result.positionUnitCost).toBe(80);
    });

    it('nets the buying power of the close against the open', () => {
      // Releases 10 * 150 closing the long, then consumes 5 * 150 opening the short.
      const result = reconcilePosition({ positionSize: 10, positionUnitCost: 100, transactionSize: -15, transactionUnitCost: 150 });
      expect(result.buyingPowerDelta).toBe(750);
    });
  });

  describe('rounding', () => {
    it('keeps a cost basis that does not divide evenly to four decimals', () => {
      const result = reconcilePosition({ positionSize: 3, positionUnitCost: 10, transactionSize: 4, transactionUnitCost: 20 });
      // (3*10 + 4*20) / 7 = 15.714285...
      expect(result.positionUnitCost).toBe(15.7143);
    });

    it('does not accumulate drift across a long sequence of averaging trades', () => {
      let size = 0;
      let unitCost = 0;
      for (let i = 0; i < 200; i += 1) {
        const result = reconcilePosition({ positionSize: size, positionUnitCost: unitCost, transactionSize: 1, transactionUnitCost: 10.1 });
        size = result.positionSize;
        unitCost = result.positionUnitCost;
      }
      expect(size).toBe(200);
      expect(unitCost).toBe(10.1);
    });
  });
});
