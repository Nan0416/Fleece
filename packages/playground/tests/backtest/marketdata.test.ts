import { requireOccSymbol, type OccSymbol } from '@fleece/marketdata';
import { easternClock } from '@fleece/utilities';

import { BacktestMarketDataImpl } from '../../src/backtest/marketdata';
import type { OptionsAvailabilitiesHelper } from '../../src/utils/options-availabilities';

const JAN_CALL_200 = requireOccSymbol('AMZN260116C00200000', 'build a fixture');
const JAN_PUT_150 = requireOccSymbol('AMZN260116P00150000', 'build a fixture');
const MAR_CALL_300 = requireOccSymbol('AMZN260320C00300000', 'build a fixture');
const MAR_PUT_100 = requireOccSymbol('AMZN260320P00100000', 'build a fixture');
const CHAIN = [JAN_CALL_200, JAN_PUT_150, MAR_CALL_300, MAR_PUT_100];

const AT = easternClock.timestamp('2025-06-02', '10:00:00');

interface Asked {
  readonly underlying: string;
  readonly timestamp: number;
}

/** Serves a fixed chain and keeps what it was asked, so the instant can be checked too. */
function availabilities(chain: ReadonlyArray<OccSymbol> = CHAIN): { helper: OptionsAvailabilitiesHelper; asked: Asked[] } {
  const asked: Asked[] = [];
  return {
    asked,
    helper: {
      cachePath: '/nowhere',
      save: async () => {},
      availableOptions: async (underlying: string, timestamp: number) => {
        asked.push({ underlying, timestamp });
        return chain;
      },
    },
  };
}

function symbolsOf(contracts: ReadonlyArray<OccSymbol>): string[] {
  return contracts.map((contract) => contract.symbol).sort();
}

describe('BacktestMarketDataImpl', () => {
  describe('listActiveOptionContracts', () => {
    it('hands back everything available when the request names no filter', async () => {
      const { helper } = availabilities();
      const subject = new BacktestMarketDataImpl(helper);
      await subject.init(AT);

      const { contracts } = await subject.listActiveOptionContracts({ underlying: 'AMZN' });

      expect(symbolsOf(contracts)).toEqual(symbolsOf(CHAIN));
    });

    it('asks about the instant the clock is on, not about now', async () => {
      const { helper, asked } = availabilities();
      const subject = new BacktestMarketDataImpl(helper);
      await subject.init(AT);
      await subject.forward(AT + 60_000);

      await subject.listActiveOptionContracts({ underlying: 'AMZN' });

      expect(asked).toEqual([{ underlying: 'AMZN', timestamp: AT + 60_000 }]);
    });

    it('keeps only the type asked for', async () => {
      const { helper } = availabilities();
      const subject = new BacktestMarketDataImpl(helper);
      await subject.init(AT);

      const { contracts } = await subject.listActiveOptionContracts({ underlying: 'AMZN', type: 'put' });

      expect(symbolsOf(contracts)).toEqual(symbolsOf([JAN_PUT_150, MAR_PUT_100]));
    });

    it('keeps only expirations inside the window, both ends inclusive', async () => {
      const { helper } = availabilities();
      const subject = new BacktestMarketDataImpl(helper);
      await subject.init(AT);

      const from = await subject.listActiveOptionContracts({ underlying: 'AMZN', expirationFrom: '2026-02-01' });
      const to = await subject.listActiveOptionContracts({ underlying: 'AMZN', expirationTo: '2026-02-01' });
      const exact = await subject.listActiveOptionContracts({ underlying: 'AMZN', expirationFrom: '2026-01-16', expirationTo: '2026-01-16' });

      expect(symbolsOf(from.contracts)).toEqual(symbolsOf([MAR_CALL_300, MAR_PUT_100]));
      expect(symbolsOf(to.contracts)).toEqual(symbolsOf([JAN_CALL_200, JAN_PUT_150]));
      expect(symbolsOf(exact.contracts)).toEqual(symbolsOf([JAN_CALL_200, JAN_PUT_150]));
    });

    it('keeps only strikes inside the band, both ends inclusive', async () => {
      const { helper } = availabilities();
      const subject = new BacktestMarketDataImpl(helper);
      await subject.init(AT);

      const { contracts } = await subject.listActiveOptionContracts({ underlying: 'AMZN', strikeFrom: 150, strikeTo: 200 });

      expect(symbolsOf(contracts)).toEqual(symbolsOf([JAN_CALL_200, JAN_PUT_150]));
    });

    it('narrows by every filter at once rather than by only one of them', async () => {
      const { helper } = availabilities();
      const subject = new BacktestMarketDataImpl(helper);
      await subject.init(AT);

      // Each filter alone would keep two contracts; together they keep exactly one.
      const { contracts } = await subject.listActiveOptionContracts({
        underlying: 'AMZN',
        type: 'call',
        expirationFrom: '2026-01-01',
        expirationTo: '2026-02-01',
        strikeFrom: 150,
        strikeTo: 250,
      });

      expect(symbolsOf(contracts)).toEqual([JAN_CALL_200.symbol]);
    });

    it('answers with nothing when every filter excludes the chain', async () => {
      const { helper } = availabilities();
      const subject = new BacktestMarketDataImpl(helper);
      await subject.init(AT);

      const { contracts } = await subject.listActiveOptionContracts({ underlying: 'AMZN', strikeFrom: 1000 });

      expect(contracts).toEqual([]);
    });

    it('answers with nothing rather than throwing when the underlying has no contracts at all', async () => {
      const { helper } = availabilities([]);
      const subject = new BacktestMarketDataImpl(helper);
      await subject.init(AT);

      const { contracts } = await subject.listActiveOptionContracts({ underlying: 'TSLA' });

      expect(contracts).toEqual([]);
    });
  });

  describe('the clock', () => {
    it('refuses to be stepped to an instant it is already on or past', async () => {
      const { helper } = availabilities();
      const subject = new BacktestMarketDataImpl(helper);
      await subject.init(AT);

      await expect(subject.forward(AT)).rejects.toThrow(/only ever stepped forward/);
      await expect(subject.forward(AT - 1)).rejects.toThrow(/only ever stepped forward/);
    });

    it('takes a subscriber id of its own, so two of them both get told', () => {
      const { helper } = availabilities();

      expect(new BacktestMarketDataImpl(helper).timeSubscriberId).not.toBe(new BacktestMarketDataImpl(helper).timeSubscriberId);
    });
  });
});
