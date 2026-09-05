import { Decimal } from '../utils/decimal';
import { HistoricalPosition, Position } from '../models/account';
import { AssetClass } from '../models/asset-class';
import { TimeWindowPage } from './common';

export interface ListPositionsRequest {
  readonly accountId: string;
  /** Include positions that have been closed out to zero. Defaults to false. */
  readonly includeClosed?: boolean;
  /** Omit for every asset class the account holds. */
  readonly assetClass?: AssetClass;
}

export interface ListPositionsResponse {
  readonly positions: ReadonlyArray<Position>;
}

export interface GetPositionRequest {
  readonly accountId: string;
  readonly symbol: string;
}

export interface GetPositionResponse {
  readonly position: Position;
}

export interface ListHistoricalPositionsRequest extends TimeWindowPage {
  readonly accountId: string;
  readonly symbol: string;
}

export interface ListHistoricalPositionsResponse {
  readonly positions: ReadonlyArray<HistoricalPosition>;
}

/**
 * A split changes how many units a position is counted in. It does not change what was
 * paid for it, so the stored total cost is left exactly as it is and the unit cost
 * falls out of the new size — no division, and no chance of the size and the price
 * disagreeing about the ratio.
 *
 * Fractional ratios and fractional resulting sizes are both allowed.
 */
export interface StockSplitRequest {
  readonly accountId: string;
  readonly symbol: string;
  /** 2 means one share becomes two. */
  readonly ratio: Decimal;
}

export interface StockSplitResponse {}

/**
 * Moves units between two virtual accounts at a stated price, writing both sides as a
 * matched pair of synthetic `traderq` orders so each account's cost basis and realised
 * profit update exactly as they would for a real fill.
 */
export interface TransferPositionRequest {
  readonly originAccountId: string;
  readonly destinationAccountId: string;
  readonly symbol: string;
  readonly assetClass: AssetClass;
  /** Dollars per unit of `size`; cost per contract for an option. */
  readonly unitCost: Decimal;
  /** Always positive; the direction comes from which account is which. */
  readonly size: Decimal;
  /** Defaults to now. Set it when replaying history for a backtest. */
  readonly timestamp?: number;
}

export interface TransferPositionResponse {}
