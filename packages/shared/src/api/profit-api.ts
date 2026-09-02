import { Profit } from '../models/account';

export interface ListProfitsRequest {
  readonly accountId: string;
}

export interface ListProfitsResponse {
  readonly profits: ReadonlyArray<Profit>;
}

export interface GetProfitRequest {
  readonly accountId: string;
  readonly symbol: string;
}

export interface GetProfitResponse {
  readonly profit: Profit;
}
