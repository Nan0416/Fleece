import {
  BarsResponse,
  DailyBarsRequest,
  MinuteBarsRequest,
  OccSymbol,
  OptionBarsRequest,
  OptionBarsResponse,
  OptionType,
  StockSplitsRequest,
  StockSplitsResponse,
} from '@fleece/marketdata';
import { TimeSubscriber } from './time';
import { nanoid } from 'nanoid';
import { OptionsAvailabilitiesHelper } from '../utils/options-availabilities';

export interface ListActiveOptionContractsRequest {
  /** The underlying ticker, not a contract symbol. */
  readonly underlying: string;
  readonly type?: OptionType;
  /** Inclusive, ISO `YYYY-MM-DD`. Set both to the same date for one expiry. */
  readonly expirationFrom?: string;
  readonly expirationTo?: string;
  /** Inclusive, in dollars. */
  readonly strikeFrom?: number;
  readonly strikeTo?: number;
}

export interface ListActiveOptionContractsResponse {
  readonly contracts: ReadonlyArray<OccSymbol>;
}
export interface BacktestMarketData extends TimeSubscriber {
  minuteBars(_request: MinuteBarsRequest): Promise<BarsResponse>;
  dailyBars(_request: DailyBarsRequest): Promise<BarsResponse>;
  stockSplits(_request: StockSplitsRequest): Promise<StockSplitsResponse>;
  optionBars(_request: OptionBarsRequest): Promise<OptionBarsResponse>;
  listActiveOptionContracts(request: ListActiveOptionContractsRequest): Promise<ListActiveOptionContractsResponse>;
}

export class BacktestMarketDataImpl implements BacktestMarketData {
  readonly timeSubscriberId: string;
  private currentTimestamp: number;

  constructor(private readonly optionsHelper: OptionsAvailabilitiesHelper) {
    this.timeSubscriberId = 'marketdata' + nanoid();
    this.currentTimestamp = 0;
  }

  async init(timestamp: number): Promise<void> {
    this.currentTimestamp = timestamp;
  }

  async forward(timestamp: number): Promise<void> {
    if (this.currentTimestamp >= timestamp) {
      throw new Error(`The clock moved to ${timestamp}, which is not past the ${this.currentTimestamp} the marketdata is already on. A subscriber is only ever stepped forward.`);
    }
    this.currentTimestamp = timestamp;
  }

  minuteBars(_request: MinuteBarsRequest): Promise<BarsResponse> {
    throw new Error('Method not implemented.');
  }
  dailyBars(_request: DailyBarsRequest): Promise<BarsResponse> {
    throw new Error('Method not implemented.');
  }
  stockSplits(_request: StockSplitsRequest): Promise<StockSplitsResponse> {
    throw new Error('Method not implemented.');
  }
  optionBars(_request: OptionBarsRequest): Promise<OptionBarsResponse> {
    throw new Error('Method not implemented.');
  }

  async listActiveOptionContracts(request: ListActiveOptionContractsRequest): Promise<ListActiveOptionContractsResponse> {
    const symbols = await this.optionsHelper.availableOptions(request.underlying, this.currentTimestamp);
    const contracts = symbols
      .filter((symbol) => request.type === undefined || request.type === symbol.type)
      .filter((symbol) => request.expirationFrom === undefined || request.expirationFrom <= symbol.expiration)
      .filter((symbol) => request.expirationTo === undefined || request.expirationTo >= symbol.expiration)
      .filter((symbol) => request.strikeFrom === undefined || request.strikeFrom <= symbol.strike)
      .filter((symbol) => request.strikeTo === undefined || request.strikeTo >= symbol.strike);
    return { contracts };
  }
}
