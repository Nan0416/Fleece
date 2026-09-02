import { BrokerOrder, BrokerOrderRecord } from '@fleece/shared';

/**
 * Fakes that store what they are given, rather than mocks that record calls.
 *
 * The order-tracking facade is almost entirely sequencing, so a test asserting on call
 * arguments would restate the implementation line by line and pass just as happily
 * when the order is wrong. Against these, a test says what a caller would observe.
 */

export interface RecordedFill {
  readonly referenceId: string;
  readonly accountId: string;
  readonly symbol: string;
  readonly cumulativeFilledSize: number;
  readonly cumulativeFilledAvgPrice: number;
  readonly timestamp: number;
}

export class FakeLedgerService {
  /** Cumulative reports as they arrived, so a test can see what was and was not applied. */
  readonly fills: RecordedFill[] = [];
  /** Net position per `${accountId}:${symbol}`, applying the same "only what is new" rule as the real ledger. */
  private readonly appliedSize = new Map<string, number>();

  async applyCumulativeFill(request: RecordedFill): Promise<{ transaction: { size: number } | null }> {
    this.fills.push(request);
    const key = `${request.accountId}:${request.symbol}:${request.referenceId}`;
    const already = this.appliedSize.get(key) ?? 0;
    const delta = request.cumulativeFilledSize - already;
    if (delta === 0) {
      return { transaction: null };
    }
    this.appliedSize.set(key, request.cumulativeFilledSize);
    return { transaction: { size: delta } };
  }

  netSize(accountId: string, symbol: string): number {
    let total = 0;
    for (const [key, size] of this.appliedSize) {
      if (key.startsWith(`${accountId}:${symbol}:`)) {
        total += size;
      }
    }
    return total;
  }
}

export class FakeBrokerOrderService {
  readonly orders = new Map<string, BrokerOrder>();
  readonly records: BrokerOrderRecord[] = [];
  readonly knownGroupIds = new Set<string>();

  async findBrokerOrder(brokerOrderId: string): Promise<BrokerOrder | null> {
    return this.orders.get(brokerOrderId) ?? null;
  }

  async createBrokerOrder(request: {
    brokerOrderId: string;
    symbol: string;
    accountId: string;
    broker: 'alpaca' | 'traderq';
    brokerAccountId: string;
    status: string;
    groupId?: string;
  }): Promise<{ brokerOrder: BrokerOrder }> {
    const brokerOrder: BrokerOrder = { ...request, createdAt: 1, lastUpdatedAt: 1 };
    this.orders.set(request.brokerOrderId, brokerOrder);
    return { brokerOrder };
  }

  async setStatus(request: { brokerOrderId: string; status: string }): Promise<Record<string, never>> {
    const existing = this.orders.get(request.brokerOrderId);
    if (existing !== undefined) {
      this.orders.set(request.brokerOrderId, { ...existing, status: request.status });
    }
    return {};
  }

  /** Implements the real rule: a group is only ever set on an order that has none. */
  async setGroupId(request: { brokerOrderId: string; groupId: string }): Promise<{ bound: boolean }> {
    const existing = this.orders.get(request.brokerOrderId);
    if (existing === undefined || existing.groupId !== undefined) {
      return { bound: false };
    }
    this.orders.set(request.brokerOrderId, { ...existing, groupId: request.groupId });
    return { bound: true };
  }

  async insertRecord(request: { record: BrokerOrderRecord }): Promise<Record<string, never>> {
    this.records.push(request.record);
    return {};
  }
}
