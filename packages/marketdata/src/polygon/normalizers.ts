import { easternClock, LoggerFactory } from '@fleece/shared';

import type { Bar, Dividend, DividendFrequency, DividendType, LatestSnapshot, Quote, StockSplit, Ticker, TickerDetails, Trade } from '../equity-data-models';

import type {
  PolygonAggregateBar,
  PolygonDividend,
  PolygonDividendFrequency,
  PolygonLatestSnapshot,
  PolygonQuoteV3,
  PolygonStockSplit,
  PolygonTicker,
  PolygonTickerDetailsV3,
  PolygonTradeV3,
} from './polygon-rest-models';

const logger = LoggerFactory.getLogger('PolygonNormalizers');

const ONE_MINUTE_MS = 60_000;

const DIVIDEND_FREQUENCY: Record<PolygonDividendFrequency, DividendFrequency> = {
  0: 'one-time',
  1: 'annually',
  2: 'bi-annually',
  4: 'quarterly',
  12: 'monthly',
};

const DIVIDEND_TYPES: ReadonlyArray<DividendType> = ['CD', 'SC', 'LT', 'ST'];

export function normalizeDividend(dividend: PolygonDividend): Dividend {
  return {
    ticker: dividend.ticker,
    cashAmount: dividend.cash_amount,
    currency: dividend.currency,
    dividendType: toDividendType(dividend.dividend_type),
    frequency: toDividendFrequency(dividend.frequency),
    declarationDate: dividend.declaration_date,
    exDividendDate: dividend.ex_dividend_date,
    recordDate: dividend.record_date,
    payDate: dividend.pay_date,
  };
}

/** Polygon adding a type is not a reason to drop a dividend an account is owed. */
function toDividendType(value: string): DividendType {
  const known = DIVIDEND_TYPES.find((type) => type === value);
  if (known !== undefined) {
    return known;
  }
  logger.warn(`Polygon reported an unrecognised dividend type "${value}"; treating it as a special dividend.`);
  return 'SC';
}

function toDividendFrequency(value: number): DividendFrequency {
  const known = DIVIDEND_FREQUENCY[value === 0 || value === 1 || value === 2 || value === 4 || value === 12 ? value : 0];
  if (value !== 0 && known === DIVIDEND_FREQUENCY[0]) {
    logger.warn(`Polygon reported an unrecognised dividend frequency ${value}; treating it as a one-off.`);
  }
  return known;
}

/** Polygon timestamps trades and quotes in nanoseconds, which does not fit a double. */
export function nanosecondsToMilliseconds(timestamp: number): number {
  return Number(BigInt(timestamp) / BigInt(1_000_000));
}

export function normalizeAggregateBar(symbol: string, bar: PolygonAggregateBar): Bar {
  return { S: symbol, v: bar.v, o: bar.o, c: bar.c, h: bar.h, l: bar.l, t: bar.t };
}

export function normalizeQuote(symbol: string, quote: PolygonQuoteV3): Quote {
  return {
    S: symbol,
    t: nanosecondsToMilliseconds(quote.sip_timestamp),
    bx: quote.bid_exchange,
    bp: quote.bid_price,
    bs: quote.bid_size,
    ax: quote.ask_exchange,
    ap: quote.ask_price,
    as: quote.ask_size,
    z: quote.tape,
  };
}

export function normalizeTrade(symbol: string, trade: PolygonTradeV3): Trade {
  return {
    S: symbol,
    t: nanosecondsToMilliseconds(trade.sip_timestamp),
    s: trade.size,
    c: trade.conditions,
    p: trade.price,
    i: trade.id,
    x: trade.exchange,
    z: trade.tape,
  };
}

export function normalizeTicker(ticker: PolygonTicker): Ticker {
  return {
    ticker: ticker.ticker,
    f: 'p',
    name: ticker.name,
    market: ticker.market,
    primaryExchange: ticker.primary_exchange,
    type: ticker.type,
    active: ticker.active,
    locale: ticker.locale,
    currencyName: ticker.currency_name,
    cik: ticker.cik,
    compositeFigi: ticker.composite_figi,
    shareClassFigi: ticker.share_class_figi,
    lastUpdatedAt: new Date(ticker.last_updated_utc).getTime(),
  };
}

export function normalizeTickerDetails(details: PolygonTickerDetailsV3): TickerDetails {
  return {
    ticker: details.ticker,
    f: 'p',
    name: details.name,
    market: details.market,
    locale: details.locale,
    primaryExchange: details.primary_exchange,
    type: details.type,
    active: details.active,
    currencyName: details.currency_name,
    cik: details.cik,
    compositeFigi: details.composite_figi,
    shareClassFigi: details.share_class_figi,
    marketCap: details.market_cap,
    sicCode: details.sic_code,
    sicDescription: details.sic_description,
    listDate: details.list_date,
    outstandingShares: details.share_class_shares_outstanding,
    weightedSharesOutstanding: details.weighted_shares_outstanding,
    description: details.description,
    employeeCount: details.total_employee,
    tickerRoot: details.ticker_root,
    tickerSuffix: details.ticker_suffix,
  };
}

export function normalizeStockSplit(split: PolygonStockSplit): StockSplit {
  return {
    ticker: split.ticker,
    executionDate: split.execution_date,
    splitFrom: split.split_from,
    splitTo: split.split_to,
  };
}

export function normalizeSnapshot(snapshot: PolygonLatestSnapshot, previousTradingDayStartTimestamp: number): LatestSnapshot {
  const updatedAt = nanosecondsToMilliseconds(snapshot.updated);
  // The day bar is stamped at Eastern midnight, not at a UTC day floor: `pdb` below is a
  // real Eastern session start, and a UTC floor would put the two bars on different time
  // bases — filing a 10:00 ET snapshot under the previous trading day, and an evening one
  // under the next.
  const easternMidnight = easternClock.timestamp(easternClock.date(updatedAt), '00:00:00');
  return {
    S: snapshot.ticker,
    f: 'p',
    lt: {
      S: snapshot.ticker,
      i: snapshot.lastTrade.i,
      x: snapshot.lastTrade.x,
      p: snapshot.lastTrade.p,
      s: snapshot.lastTrade.s,
      t: nanosecondsToMilliseconds(snapshot.lastTrade.t),
      c: snapshot.lastTrade.c,
      z: snapshot.lastTrade.z,
    },
    lq: {
      S: snapshot.ticker,
      bp: snapshot.lastQuote.p,
      bs: snapshot.lastQuote.s,
      ap: snapshot.lastQuote.P,
      as: snapshot.lastQuote.S,
      t: nanosecondsToMilliseconds(snapshot.lastQuote.t),
    },
    mb: {
      S: snapshot.ticker,
      o: snapshot.min.o,
      h: snapshot.min.h,
      l: snapshot.min.l,
      c: snapshot.min.c,
      v: snapshot.min.v,
      t: Math.floor(updatedAt / ONE_MINUTE_MS) * ONE_MINUTE_MS,
    },
    db: { S: snapshot.ticker, o: snapshot.day.o, h: snapshot.day.h, l: snapshot.day.l, c: snapshot.day.c, v: snapshot.day.v, t: easternMidnight },
    pdb: {
      S: snapshot.ticker,
      o: snapshot.prevDay.o,
      h: snapshot.prevDay.h,
      l: snapshot.prevDay.l,
      c: snapshot.prevDay.c,
      v: snapshot.prevDay.v,
      t: previousTradingDayStartTimestamp,
    },
  };
}
