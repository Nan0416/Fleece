import { AssetClass, BrokerOrder, BrokerOrderRecord, Decimal } from '@fleece/shared';
import { RecordBrokerOrderRequest } from '@fleece/core';

/**
 * Fakes that store what they are given, rather than mocks that record calls.
 *
 * The order-tracking facade is almost entirely sequencing, so a test asserting on call
 * arguments would restate the implementation line by line and pass just as happily
 * when the order is wrong. Against these, a test says what a caller would observe.
 *
 * Where a caller depends on a rule, the fake implements the rule — notably that an
 * upsert never overwrites what an order *is*. There is no way to move an order between
 * accounts here because there is none in the real service either.
 */

export interface RecordedFill {
  readonly referenceId: string;
  readonly accountId: string;
  readonly symbol: string;
  readonly assetClass: AssetClass;
  readonly multiplier: Decimal;
  readonly cumulativeFilledSize: Decimal;
  readonly cumulativeFilledTotalCost: Decimal;
  readonly timestamp: number;
}

export class FakeLedgerService {
  /** Cumulative reports as they arrived, so a test can see what was and was not applied. */
  readonly fills: RecordedFill[] = [];
  /** Net position per `${accountId}:${symbol}:${referenceId}`, applying the same "only what is new" rule as the real ledger. */
  private readonly appliedSize = new Map<string, Decimal>();

  async applyCumulativeFill(request: RecordedFill): Promise<{ transaction: { size: Decimal } | null }> {
    this.fills.push(request);
    const key = `${request.accountId}:${request.symbol}:${request.referenceId}`;
    const already = this.appliedSize.get(key) ?? Decimal.ZERO;
    const delta = request.cumulativeFilledSize.sub(already);
    if (delta.isZero()) {
      return { transaction: null };
    }
    this.appliedSize.set(key, request.cumulativeFilledSize);
    return { transaction: { size: delta } };
  }

  netSize(accountId: string, symbol: string): Decimal {
    let total = Decimal.ZERO;
    for (const [key, size] of this.appliedSize) {
      if (key.startsWith(`${accountId}:${symbol}:`)) {
        total = total.add(size);
      }
    }
    return total;
  }
}

export class FakeBrokerOrderService {
  readonly orders = new Map<string, BrokerOrder>();
  readonly records: BrokerOrderRecord[] = [];

  async findBrokerOrder(brokerOrderId: string): Promise<BrokerOrder | null> {
    return this.orders.get(brokerOrderId) ?? null;
  }

  /**
   * Implements the real upsert rule: an existing row keeps everything describing what
   * the order *is* — its account, how that was decided, its instrument, its size — and
   * only what a broker legitimately revises moves.
   */
  async recordBrokerOrder(request: RecordBrokerOrderRequest): Promise<{ brokerOrder: BrokerOrder; created: boolean }> {
    const existing = this.orders.get(request.brokerOrderId);
    if (existing === undefined) {
      const brokerOrder: BrokerOrder = { ...request, createdAt: 1, lastUpdatedAt: 1 };
      this.orders.set(request.brokerOrderId, brokerOrder);
      return { brokerOrder, created: true };
    }
    const brokerOrder: BrokerOrder = {
      ...existing,
      status: request.status,
      filledQty: request.filledQty,
      filledAvgPrice: request.filledAvgPrice ?? existing.filledAvgPrice,
      filledAt: request.filledAt ?? existing.filledAt,
      lastUpdatedAt: 2,
    };
    this.orders.set(request.brokerOrderId, brokerOrder);
    return { brokerOrder, created: false };
  }

  async insertRecord(request: { record: BrokerOrderRecord }): Promise<Record<string, never>> {
    this.records.push(request.record);
    return {};
  }
}
