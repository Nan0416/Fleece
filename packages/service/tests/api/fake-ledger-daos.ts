import { BrokerOrder, BrokerOrderRecord, Dividend } from '@fleece/models';
import { Decimal } from '@fleece/utilities';
import {
  BrokerOrderDao,
  DeleteBrokerOrderInput,
  DeleteBrokerOrderOutput,
  GetBrokerOrderInput,
  GetBrokerOrderOutput,
  InsertBrokerOrderRecordInput,
  InsertBrokerOrderRecordOutput,
  ListBrokerOrderLegsInput,
  ListBrokerOrderLegsOutput,
  ListBrokerOrderRecordsInput,
  ListBrokerOrderRecordsOutput,
  ListBrokerOrdersInput,
  ListBrokerOrdersOutput,
  UpsertBrokerOrderInput,
  UpsertBrokerOrderOutput,
} from '../../src/core/data/broker-order-dao';
import {
  DividendDao,
  GetDividendInput,
  GetDividendOutput,
  ListDividendsInput,
  ListDividendsOutput,
  UpsertDividendInput,
  UpsertDividendOutput,
} from '../../src/core/data/dividend-dao';

const d = (value: string): Decimal => Decimal.of(value);

/**
 * In-memory stand-ins for the two DAOs the API needs beyond the account and ledger
 * ones. They store what they are given and answer from it, so a route test asserts on
 * what came back through HTTP rather than on which method was called.
 */
export class FakeDividendDao implements DividendDao {
  readonly dividends: Dividend[] = [];

  seed(overrides: Partial<Dividend> = {}): Dividend {
    const dividend: Dividend = {
      accountId: 'MOMENTUM01',
      symbol: 'AAPL',
      exDividendDate: '2024-02-09',
      size: d('100'),
      amountPerShare: d('0.24'),
      declarationDate: '2024-02-01',
      recordDate: '2024-02-12',
      payDate: '2024-02-15',
      status: 'declared',
      ...overrides,
    };
    this.dividends.push(dividend);
    return dividend;
  }

  async getDividend(input: GetDividendInput): Promise<GetDividendOutput> {
    const found = this.dividends.find((dividend) => dividend.accountId === input.accountId && dividend.symbol === input.symbol && dividend.exDividendDate === input.exDividendDate);
    return { dividend: found ?? null };
  }

  async listDividends(input: ListDividendsInput): Promise<ListDividendsOutput> {
    return {
      dividends: this.dividends.filter((dividend) => dividend.accountId === input.accountId && (input.symbol === undefined || dividend.symbol === input.symbol)),
    };
  }

  async upsertDividend(input: UpsertDividendInput): Promise<UpsertDividendOutput> {
    const dividend: Dividend = { ...input, status: 'declared' };
    this.dividends.push(dividend);
    return { dividend };
  }
}

export class FakeBrokerOrderDao implements BrokerOrderDao {
  readonly orders = new Map<string, BrokerOrder>();
  readonly records = new Map<string, BrokerOrderRecord[]>();

  seed(overrides: Partial<BrokerOrder> = {}): BrokerOrder {
    const order: BrokerOrder = {
      brokerOrderId: 'order-1',
      accountId: 'MOMENTUM01',
      broker: 'alpaca',
      brokerAccountId: 'PAPER001',
      symbol: 'AAPL',
      assetClass: 'equity',
      multiplier: Decimal.ONE,
      status: 'filled',
      orderClass: 'regular',
      orderType: 'market',
      side: 'buy',
      timeInForce: 'day',
      extendedHours: false,
      qty: d('10'),
      filledQty: d('10'),
      filledAvgPrice: d('100'),
      createdAt: 1_700_000_000_000,
      lastUpdatedAt: 1_700_000_000_000,
      ...overrides,
    };
    this.orders.set(order.brokerOrderId, order);
    return order;
  }

  async upsertBrokerOrder(input: UpsertBrokerOrderInput): Promise<UpsertBrokerOrderOutput> {
    const created = !this.orders.has(input.brokerOrderId);
    const brokerOrder = this.seed({ ...input, ratioQty: input.ratioQty });
    return { brokerOrder, created };
  }

  async getBrokerOrder(input: GetBrokerOrderInput): Promise<GetBrokerOrderOutput> {
    return { brokerOrder: this.orders.get(input.brokerOrderId) ?? null };
  }

  async listBrokerOrders(input: ListBrokerOrdersInput): Promise<ListBrokerOrdersOutput> {
    const matches = [...this.orders.values()].filter(
      (order) =>
        (input.accountId === undefined || order.accountId === input.accountId) &&
        (input.brokerAccountId === undefined || order.brokerAccountId === input.brokerAccountId) &&
        (input.symbol === undefined || order.symbol === input.symbol) &&
        (input.status === undefined || order.status === input.status) &&
        (input.assetClass === undefined || order.assetClass === input.assetClass),
    );
    return { brokerOrders: matches.slice(0, input.limit) };
  }

  async listBrokerOrderLegs(input: ListBrokerOrderLegsInput): Promise<ListBrokerOrderLegsOutput> {
    return {
      brokerOrders: [...this.orders.values()].filter((order) => order.parentBrokerOrderId !== undefined && input.parentBrokerOrderIds.includes(order.parentBrokerOrderId)),
    };
  }

  async deleteBrokerOrder(input: DeleteBrokerOrderInput): Promise<DeleteBrokerOrderOutput> {
    return { deleted: this.orders.delete(input.brokerOrderId) };
  }

  /** Takes the record as given: a broker payload is whatever the broker sent. */
  async insertRecord(input: InsertBrokerOrderRecordInput): Promise<InsertBrokerOrderRecordOutput> {
    const existing = this.records.get(input.brokerOrderId) ?? [];
    existing.push(input.record);
    this.records.set(input.brokerOrderId, existing);
    return {};
  }

  async listRecords(input: ListBrokerOrderRecordsInput): Promise<ListBrokerOrderRecordsOutput> {
    return { records: this.records.get(input.brokerOrderId) ?? [] };
  }
}
