import { daysToExpiration, expirationsByPreference } from '../../src/utils/option-selection';

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
