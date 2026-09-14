import { requireOccSymbol } from '@fleece/marketdata';
import { Decimal } from '@fleece/utilities';

import { choosePut, daysToExpiration, exitReason, expirationsByPreference, ivPercentile } from '../../src/research/sell-put-rules';

function put(symbol: string, delta: number) {
  return { occSymbol: requireOccSymbol(symbol, 'build a fixture'), delta };
}

function check(credit: string, debit: string, daysToExpiration = 35) {
  return { credit: Decimal.of(credit), debit: Decimal.of(debit), daysToExpiration };
}

describe('daysToExpiration', () => {
  it('counts whole calendar days across both daylight-saving changes', () => {
    // Clocks went forward on 2025-03-09 and back on 2025-11-02, so the Eastern spans are
    // an hour short of and an hour over whole days.
    expect(daysToExpiration('2025-03-03', '2025-04-17')).toBe(45);
    expect(daysToExpiration('2025-10-20', '2025-11-21')).toBe(32);
  });

  it('is zero on expiration day and negative after it', () => {
    expect(daysToExpiration('2025-04-17', '2025-04-17')).toBe(0);
    expect(daysToExpiration('2025-04-18', '2025-04-17')).toBe(-1);
  });
});

describe('ivPercentile', () => {
  it('is the share of the history strictly below today, in percent', () => {
    expect(ivPercentile([0.2, 0.3, 0.4, 0.5], 0.35)).toBe(50);
    expect(ivPercentile([0.2, 0.3, 0.4, 0.5], 0.3)).toBe(25);
  });

  it('reads an ordinary high as high after a spike, which a rank would not', () => {
    const history = [...Array<number>(99).fill(0.25), 0.9];
    // Rank would put 0.3 at (0.3 - 0.25) / (0.9 - 0.25), under 8.
    expect(ivPercentile(history, 0.3)).toBe(99);
  });

  it('says nothing with no history', () => {
    expect(ivPercentile([], 0.3)).toBeUndefined();
  });
});

describe('expirationsByPreference', () => {
  it('orders the expirations inside the window nearest the target first, the earlier of a tie first', () => {
    // From 2025-03-03: 39, 42, 45, 48, 51 days.
    const expirations = ['2025-04-11', '2025-04-14', '2025-04-17', '2025-04-20', '2025-04-23'];
    expect(expirationsByPreference(expirations, '2025-03-03', { target: 45, min: 40, max: 50 })).toEqual(['2025-04-17', '2025-04-14', '2025-04-20']);
  });

  it('lists an expiration once however many contracts name it', () => {
    expect(expirationsByPreference(['2025-04-17', '2025-04-17'], '2025-03-03', { target: 45, min: 40, max: 50 })).toEqual(['2025-04-17']);
  });
});

describe('choosePut', () => {
  it('takes the delta nearest 0.20 inside the band', () => {
    const candidates = [put('AAPL250417P00200000', -0.12), put('AAPL250417P00205000', -0.17), put('AAPL250417P00210000', -0.22), put('AAPL250417P00215000', -0.29)];
    expect(choosePut(candidates)?.occSymbol.symbol).toBe('AAPL250417P00210000');
  });

  it('takes nothing rather than the nearest when every delta is outside the band', () => {
    expect(choosePut([put('AAPL250417P00200000', -0.1), put('AAPL250417P00215000', -0.3)])).toBeUndefined();
  });

  it('takes the lower strike of two equally near', () => {
    // The same delta on both, because 0.15 and 0.25 are not equally far from 0.2 in binary.
    const candidates = [put('AAPL250417P00210000', -0.19), put('AAPL250417P00205000', -0.19)];
    expect(choosePut(candidates)?.occSymbol.symbol).toBe('AAPL250417P00205000');
  });

  it('never takes a call, whatever its delta', () => {
    expect(choosePut([put('AAPL250417C00250000', 0.2)])).toBeUndefined();
  });
});

describe('exitReason', () => {
  it('holds while the put is between the profit and the stop, with time to run', () => {
    expect(exitReason(check('3.00', '2.00'))).toBeUndefined();
  });

  it('takes profit once half the credit is kept, and not a cent before', () => {
    expect(exitReason(check('3.00', '1.50'))).toBe('take-profit');
    expect(exitReason(check('3.00', '1.51'))).toBeUndefined();
  });

  it('stops out once the loss is twice the credit, and not a cent before', () => {
    expect(exitReason(check('3.00', '9.00'))).toBe('stop-loss');
    expect(exitReason(check('3.00', '8.99'))).toBeUndefined();
  });

  it('closes with 21 days left whatever the price', () => {
    expect(exitReason(check('3.00', '2.50', 21))).toBe('dte');
    expect(exitReason(check('3.00', '2.50', 22))).toBeUndefined();
  });

  it('reports a stop as a stop even on the day time runs out', () => {
    expect(exitReason(check('3.00', '9.50', 21))).toBe('stop-loss');
  });
});
