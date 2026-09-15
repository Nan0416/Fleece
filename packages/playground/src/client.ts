/**
 * The market-data client the playground's scripts share, and the caches built on it.
 *
 * Keys come from `credentials.ts`, which is the one file in this package that reads the
 * environment.
 */
import { AlpacaMarketDataClient } from '@fleece/marketdata';

import { getCachePath, marketDataKeys } from './credentials';
import { ImpliedVolatilityHistoryHelper, ImpliedVolatilityHistoryHelperImpl } from './utils/implied-volatility-history';
import { OptionsAvailabilitiesHelper, OptionsAvailabilitiesHelperImpl } from './utils/options-availabilities';
import { OptionsQuoteSpreadHelper, OptionsQuoteSpreadHelperImpl } from './utils/options-quote-spread';

let client: AlpacaMarketDataClient | undefined;

/** Built once and kept, so a loop over sessions does not rebuild it per day. */
export function marketDataClient(): AlpacaMarketDataClient {
  if (client === undefined) {
    client = new AlpacaMarketDataClient(marketDataKeys());
  }
  return client;
}

export function optionsAvailabilitiesHelper(alpacaMarketDataClient: AlpacaMarketDataClient): OptionsAvailabilitiesHelper {
  return new OptionsAvailabilitiesHelperImpl(getCachePath(), alpacaMarketDataClient);
}

export function impliedVolatilityHistoryHelper(alpacaMarketDataClient: AlpacaMarketDataClient, availabilities: OptionsAvailabilitiesHelper): ImpliedVolatilityHistoryHelper {
  return new ImpliedVolatilityHistoryHelperImpl(getCachePath(), alpacaMarketDataClient, availabilities);
}

export function optionsQuoteSpreadHelper(alpacaMarketDataClient: AlpacaMarketDataClient): OptionsQuoteSpreadHelper {
  return new OptionsQuoteSpreadHelperImpl(getCachePath(), alpacaMarketDataClient);
}
