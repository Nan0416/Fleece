import {
  AssetClass,
  Broker,
  BrokerOrder,
  BrokerOrderAttribution,
  BrokerOrderClass,
  BrokerOrderRecord,
  BrokerOrderSide,
  BrokerOrderTimeInForce,
  BrokerOrderType,
  BrokerPositionIntent,
  Decimal,
  DeleteBrokerOrderRequest,
  DeleteBrokerOrderResponse,
  GetBrokerOrderRequest,
  GetBrokerOrderResponse,
  InvalidRequestError,
  ListBrokerOrderLegsRequest,
  ListBrokerOrderLegsResponse,
  ListBrokerOrderRecordsRequest,
  ListBrokerOrderRecordsResponse,
  ListBrokerOrdersRequest,
  ListBrokerOrdersResponse,
  ListOrphanBrokerOrdersRequest,
  ListOrphanBrokerOrdersResponse,
  LoggerFactory,
  NotFoundError,
} from '@fleece/shared';
import { AccountDao } from '../data/account-dao';
import { BrokerOrderDao } from '../data/broker-order-dao';

const logger = LoggerFactory.getLogger('BrokerOrderService');

interface SearchProperty {
  readonly name: string;
  readonly value: string | undefined;
}

/**
 * Everything a broker just said about an order, recorded whether or not it has been
 * seen before.
 *
 * One idempotent write rather than a find followed by a create-or-update. The injector
 * receives the same order many times — every status change, plus whatever the REST
 * backfill re-reports — and two of those arriving at once would otherwise each decide
 * independently that the row did not exist.
 *
 * Declared field by field rather than aliased to the DAO's input type: guideline 26
 * keeps a DAO input matching its columns, and tying a service contract to it would make
 * a column rename a breaking change for every caller.
 */
export interface RecordBrokerOrderRequest {
  readonly brokerOrderId: string;
  /** Set on a leg. Groups only — a spread's parent is never recorded, so this may name no row. */
  readonly parentBrokerOrderId?: string;
  readonly accountId: string;
  readonly broker: Broker;
  readonly brokerAccountId: string;
  /** How `accountId` was decided. `default` means nobody claimed the order. */
  readonly attribution: BrokerOrderAttribution;

  readonly symbol?: string;
  readonly assetClass: AssetClass;
  readonly multiplier: Decimal;

  readonly status: string;
  readonly orderClass: BrokerOrderClass;
  readonly orderType: BrokerOrderType;
  readonly side?: BrokerOrderSide;
  readonly positionIntent?: BrokerPositionIntent;
  readonly timeInForce: BrokerOrderTimeInForce;
  readonly extendedHours: boolean;

  readonly qty: Decimal;
  readonly ratioQty?: Decimal;
  readonly limitPrice?: Decimal;
  readonly stopPrice?: Decimal;
  /** As the broker reports it, in the broker's own units. Never used for accounting. */
  readonly filledQty: Decimal;
  readonly filledAvgPrice?: Decimal;

  readonly submittedAt?: number;
  readonly filledAt?: number;
}

export interface RecordBrokerOrderResponse {
  readonly brokerOrder: BrokerOrder;
  /** False when the row already existed and only what a broker revises has moved. */
  readonly created: boolean;
}

export interface ClaimBrokerOrderRequest {
  readonly brokerOrderId: string;
  readonly accountId: string;
  readonly attribution: BrokerOrderAttribution;
}

export interface ClaimBrokerOrderResponse {
  /** False when the order was already attributed to somebody, which is never overwritten. */
  readonly claimed: boolean;
}

export interface InsertBrokerOrderRecordRequest {
  readonly record: BrokerOrderRecord;
}

export interface InsertBrokerOrderRecordResponse {}

export class BrokerOrderService {
  constructor(
    private readonly brokerOrderDao: BrokerOrderDao,
    private readonly accountDao: AccountDao,
  ) {}

  async getBrokerOrder(request: GetBrokerOrderRequest): Promise<GetBrokerOrderResponse> {
    return { brokerOrder: await this.requireBrokerOrder(request.brokerOrderId) };
  }

  async findBrokerOrder(brokerOrderId: string): Promise<BrokerOrder | null> {
    const { brokerOrder } = await this.brokerOrderDao.getBrokerOrder({ brokerOrderId });
    return brokerOrder;
  }

  /**
   * Records what a broker reported, creating the order or advancing it.
   *
   * The account is checked on the way in because booking an order to an account that
   * does not exist is how a fill goes missing — but note what is *not* checked: a
   * `parentBrokerOrderId` naming no row is normal, not an error. A spread's parent is
   * discarded by the converter, so its legs routinely name an id this table holds
   * nothing for, and refusing those would drop every option fill.
   */
  async recordBrokerOrder(request: RecordBrokerOrderRequest): Promise<RecordBrokerOrderResponse> {
    await this.requireAccount(request.accountId);
    const result = await this.brokerOrderDao.upsertBrokerOrder(request);
    if (result.created) {
      logger.info(
        `Recording ${request.broker} order ${request.brokerOrderId} (${request.status}) for account ${request.accountId} by ${request.attribution}${request.parentBrokerOrderId === undefined ? '' : `, a leg of ${request.parentBrokerOrderId}`}.`,
      );
    }
    return result;
  }

  /**
   * At most one search property.
   *
   * Not taste: each property has an index paired with `created_at`, so one property plus
   * a time window is a range scan and anything else is a table scan.
   */
  async listBrokerOrders(request: ListBrokerOrdersRequest): Promise<ListBrokerOrdersResponse> {
    const searchProperties: ReadonlyArray<SearchProperty> = [
      { name: 'accountId', value: request.accountId },
      { name: 'brokerAccountId', value: request.brokerAccountId },
      { name: 'symbol', value: request.symbol },
      { name: 'status', value: request.status },
      { name: 'assetClass', value: request.assetClass },
    ];
    const provided = searchProperties.filter((property) => property.value !== undefined).map((property) => property.name);

    if (provided.length > 1) {
      throw new InvalidRequestError(
        `Listing broker orders accepts at most one search property, got ${provided.length} (${provided.join(', ')}). Pick one of accountId, brokerAccountId, symbol, status or assetClass.`,
      );
    }
    return await this.brokerOrderDao.listBrokerOrders(request);
  }

  /**
   * The legs of one composite order.
   *
   * Takes the parent's id without requiring a row for it, for the reason above: a
   * spread's parent is never recorded, so this is the only way back to the contracts it
   * traded.
   */
  async listBrokerOrderLegs(request: ListBrokerOrderLegsRequest): Promise<ListBrokerOrderLegsResponse> {
    return await this.brokerOrderDao.listBrokerOrderLegs({ parentBrokerOrderIds: [request.parentBrokerOrderId] });
  }

  async listOrphanBrokerOrders(_request: ListOrphanBrokerOrdersRequest = {}): Promise<ListOrphanBrokerOrdersResponse> {
    return await this.brokerOrderDao.listOrphanBrokerOrders({});
  }

  /**
   * Moves an order off the catch-all account, and only off the catch-all account.
   *
   * An order's account never changes once something has actually claimed it: a leg can
   * arrive before the tracking request that names its account, but a claim arriving
   * after the order is attributed is a disagreement, not a correction. The guard lives
   * in the UPDATE rather than here, so a concurrent late claim cannot slip between a
   * read and a write.
   */
  async claimBrokerOrder(request: ClaimBrokerOrderRequest): Promise<ClaimBrokerOrderResponse> {
    await this.requireAccount(request.accountId);
    const existing = await this.requireBrokerOrder(request.brokerOrderId);
    const { brokerOrder } = await this.brokerOrderDao.claimBrokerOrder(request);
    if (brokerOrder === null) {
      logger.warn(
        `Broker order ${request.brokerOrderId} is already booked to account ${existing.accountId} by ${existing.attribution}, so the claim by ${request.accountId} was not applied. Leaving it where it is.`,
      );
      return { claimed: false };
    }
    logger.info(`Claimed broker order ${request.brokerOrderId} for account ${request.accountId} by ${request.attribution}.`);
    return { claimed: true };
  }

  /**
   * Deletes the order and its records. The transactions it produced are left alone:
   * they are the record of units that actually moved, and removing them would leave
   * the position they built unexplained.
   *
   * Its legs are left alone too. A leg is an order in its own right with its own fills,
   * so cascading into them would delete records of executions that happened.
   */
  async deleteBrokerOrder(request: DeleteBrokerOrderRequest): Promise<DeleteBrokerOrderResponse> {
    await this.requireBrokerOrder(request.brokerOrderId);
    logger.info(`Deleting broker order ${request.brokerOrderId} and its records.`);
    await this.brokerOrderDao.deleteBrokerOrder(request);
    return {};
  }

  async insertRecord(request: InsertBrokerOrderRecordRequest): Promise<InsertBrokerOrderRecordResponse> {
    return await this.brokerOrderDao.insertRecord({ brokerOrderId: request.record.id, record: request.record });
  }

  async listRecords(request: ListBrokerOrderRecordsRequest): Promise<ListBrokerOrderRecordsResponse> {
    await this.requireBrokerOrder(request.brokerOrderId);
    return await this.brokerOrderDao.listRecords(request);
  }

  private async requireBrokerOrder(brokerOrderId: string): Promise<BrokerOrder> {
    const { brokerOrder } = await this.brokerOrderDao.getBrokerOrder({ brokerOrderId });
    if (brokerOrder === null) {
      throw new NotFoundError(`Broker order ${brokerOrderId} does not exist.`);
    }
    return brokerOrder;
  }

  private async requireAccount(accountId: string): Promise<void> {
    const { account } = await this.accountDao.getAccount({ accountId });
    if (account === null) {
      throw new NotFoundError(`Account ${accountId} does not exist. List accounts to see which ids are in use.`);
    }
  }
}
