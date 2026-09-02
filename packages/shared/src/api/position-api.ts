import { HistoricalPosition, Position } from '../models/account';
import { TimeWindowPage } from './common';

export interface ListPositionsRequest {
  readonly accountId: string;
  /** Include positions that have been closed out to zero. Defaults to false. */
  readonly includeClosed?: boolean;
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

export interface StockSplitRequest {
  readonly accountId: string;
  readonly symbol: string;
  /** 2 means one share becomes two. Fractional ratios are allowed; share counts are not. */
  readonly ratio: number;
}

export interface StockSplitResponse {}

/**
 * Moves shares between two virtual accounts at a stated price, writing both sides as
 * a matched pair of synthetic `traderq` orders so each account's cost basis and
 * realised profit update exactly as they would for a real fill.
 */
export interface TransferPositionRequest {
  readonly originAccountId: string;
  readonly originGroupId: string;
  readonly destinationAccountId: string;
  readonly destinationGroupId: string;
  readonly symbol: string;
  readonly unitCost: number;
  readonly shares: number;
  /** Defaults to now. Set it when replaying history for a backtest. */
  readonly timestamp?: number;
}

export interface TransferPositionResponse {}
