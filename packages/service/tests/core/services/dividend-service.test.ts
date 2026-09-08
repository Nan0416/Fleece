import { Decimal, InvalidRequestError } from '@fleece/shared';

import type {
  DividendDao,
  GetDividendInput,
  GetDividendOutput,
  ListDividendsInput,
  ListDividendsOutput,
  UpsertDividendInput,
  UpsertDividendOutput,
} from '../../../src/core/data/dividend-dao';
import { DividendService } from '../../../src/core/services/dividend-service';

import { FakeAccountDao } from './fake-daos';

/** Records nothing: these tests are about what never reaches the ledger. */
class RefusingDividendDao implements DividendDao {
  written = 0;

  async getDividend(_input: GetDividendInput): Promise<GetDividendOutput> {
    throw new Error('not expected');
  }

  async listDividends(_input: ListDividendsInput): Promise<ListDividendsOutput> {
    throw new Error('not expected');
  }

  async upsertDividend(_input: UpsertDividendInput): Promise<UpsertDividendOutput> {
    this.written += 1;
    throw new Error('a dividend reached the ledger that should have been refused');
  }
}

function serviceWith(dao: RefusingDividendDao): DividendService {
  const accounts = new FakeAccountDao();
  accounts.seed('MOMENTUM01');
  return new DividendService(dao, accounts, () => Date.parse('2026-03-01T15:00:00Z'));
}

const request = {
  accountId: 'MOMENTUM01',
  symbol: 'AAPL',
  amountPerShare: Decimal.of('0.25'),
  size: Decimal.of('100'),
  declarationDate: '2026-02-01',
  exDividendDate: '2026-02-09',
  recordDate: '2026-02-10',
  payDate: '2026-02-13',
};

describe('recordDividend', () => {
  it('refuses a date that is shaped right but does not exist', async () => {
    // 2026-02-30 passed both this check and the column's own CHECK constraint, which is
    // the same shape-only regex — and the ex-dividend date is part of the primary key.
    const dao = new RefusingDividendDao();
    const service = serviceWith(dao);

    await expect(service.recordDividend({ ...request, exDividendDate: '2026-02-30' })).rejects.toThrow(InvalidRequestError);
    expect(dao.written).toBe(0);
  });

  it('refuses an impossible value in any of the four dates', async () => {
    const dao = new RefusingDividendDao();
    const service = serviceWith(dao);

    for (const field of ['declarationDate', 'exDividendDate', 'recordDate', 'payDate'] as const) {
      await expect(service.recordDividend({ ...request, [field]: '2026-13-01' })).rejects.toThrow(new RegExp(field));
    }
    expect(dao.written).toBe(0);
  });

  it('names the field and what it wanted', async () => {
    const service = serviceWith(new RefusingDividendDao());
    await expect(service.recordDividend({ ...request, payDate: '2026-2-13' })).rejects.toThrow(/payDate must be an Eastern calendar date in YYYY-MM-DD form, got "2026-2-13"/);
  });
});
