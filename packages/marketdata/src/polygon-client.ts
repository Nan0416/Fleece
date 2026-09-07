import type { ListDividendsInput, ListDividendsOutput, ListStockSplitsInput, ListStockSplitsOutput, MarketDataClient } from './models';
import { PolygonRestClient, type PolygonRestClientProps } from './polygon';

export type PolygonClientProps = PolygonRestClientProps;

/** The corporate-action slice of `PolygonRestClient`, as `corporate-actions` consumes it. */
export class PolygonClient implements MarketDataClient {
  private readonly rest: PolygonRestClient;

  constructor(props: PolygonClientProps) {
    this.rest = new PolygonRestClient(props);
  }

  async listDividends(input: ListDividendsInput): Promise<ListDividendsOutput> {
    return await this.rest.dividends(input);
  }

  async listStockSplits(input: ListStockSplitsInput): Promise<ListStockSplitsOutput> {
    return await this.rest.stockSplits(input);
  }
}
