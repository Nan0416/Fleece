/**
 * The equity data model, ported from `@qnquant/equity-data-models` with its field names
 * intact: a `Bar` is `{S, o, h, l, c, v, t}` here as it is on Alpaca's and Polygon's
 * WebSocket feeds, because these types are what a feed hands a strategy tick by tick.
 */

export type AlpacaSource = 'a';
export type PolygonSource = 'p';
export type ReplaySource = 'r';
export type DataSource = AlpacaSource | PolygonSource | ReplaySource;

export interface Bar {
  readonly S: string; // symbol
  readonly o: number; // open
  readonly h: number; // high
  readonly l: number; // low
  readonly c: number; // close
  readonly v: number; // volume
  readonly t: number; // timestamp, in millisecond, the start timestamp
}

export interface Trade {
  readonly S: string; // symbol
  readonly i: number | string; // trade id.
  readonly x: number | string; // exchange code
  readonly p: number; // price
  readonly s: number; // size
  readonly t: number; // timestamp, in millisecond
  readonly c?: string[] | number[]; // condition ["@", "I"],
  readonly z?: number | string; // tape"C"
}

export interface TradeStat extends Bar {
  readonly S: string; // symbol
  readonly avg: number; // volume based average
}

export interface AggQuote {
  /* symbol */
  readonly S: string; // symbol
  readonly bp: number; // bid price
  readonly bs: number; // bid size
  readonly ap: number; // ask price
  readonly as: number; // ask size
  readonly t: number; // start time of the aggregation
}

export interface Quote {
  /* symbol */
  readonly S: string; // symbol
  readonly bx?: string | number; // bid exchane code
  readonly bp: number; // bid price
  readonly bs: number; // bid lot (lot * 100)
  readonly ax?: string | number; // ask exchange code.
  readonly ap: number; // ask price
  readonly as: number; // ask lot (lot * 100)
  readonly t: number; // timestamp
  readonly c?: string[] | number[] | number | string; // condition ["@", "I"],
  readonly z?: string | number; // tape"C"
}

export interface LULD {
  /* symbol */
  readonly S: string;
  readonly h: number; // High Price
  readonly l: number; // Low Price
  // i:[...],               // Indicators
  readonly z: number; // Tape ( 1=A 2=B 3=C)
  readonly t: number; // Timestamp (Unix Nanoseconds)
  readonly q: number; // Sequence Number
}

// https://www.investopedia.com/terms/n/net-order-imbalance-indicator-noii.asp
// https://www.investopedia.com/terms/o/order-imbalance.asp#:~:text=What%20Is%20an%20Order%20Imbalance,orders%20of%20buyers%20and%20sellers.&text=Extreme%20cases%20of%20order%20imbalance,until%20the%20imbalance%20is%20resolved.

export interface NOI {
  /* symbol */
  readonly S: string;
  readonly t: number; // Timestamp (Unix Nanoseconds)
  readonly at: number; // Auction Time
  readonly a: string; // Auction Type
  readonly i: number; // Symbol Sequence
  readonly x: number; // Exchange ID
  readonly o: number; // Imbalance Quantity
  readonly p: number; // Paired Quantity
  readonly b: number; // Book Clearing Price
}

// https://polygon.io/docs/stocks/get_v3_reference_exchanges
export type Exchange = 'XASE' | 'XBOS' | 'XCIS' | 'EDGA' | 'EDGX' | 'XCHI' | 'XNYS' | 'ARCX' | 'XNAS' | 'LTSE' | 'IEXG' | 'XPHL' | 'BATY' | 'BATS' | 'EPRL' | 'MEMX';

// copy polygon ticker type as our standard.
// https://polygon.io/docs/stocks/get_v3_reference_tickers_types
export type TickerType =
  'CS' | 'PFD' | 'WARRANT' | 'RIGHT' | 'BOND' | 'ETF' | 'ETN' | 'ETV' | 'ETS' | 'SP' | 'ADRC' | 'ADRP' | 'ADRW' | 'ADRR' | 'FUND' | 'BASKET' | 'UNIT' | 'LT' | 'OS' | 'GDR';

export interface Ticker {
  readonly ticker: string;
  readonly f: DataSource;
  readonly name: string;
  readonly market: 'stocks' | string;
  readonly locale: 'us' | string;
  readonly primaryExchange: Exchange;
  readonly type: TickerType;
  readonly active: boolean;
  readonly currencyName: 'usd' | string;
  readonly cik: string;
  readonly compositeFigi: string;
  readonly shareClassFigi: string;
  readonly lastUpdatedAt: number;
}

export interface TickerDetails {
  readonly ticker: string;
  readonly f: DataSource;
  readonly name: string;
  readonly market: 'stocks' | string;
  readonly locale: 'us' | string;
  readonly primaryExchange: Exchange;
  readonly type: TickerType;
  readonly active: boolean;
  readonly currencyName: 'usd' | string;
  /**
   * Central Index Key or CIK is a 10-digit number used on the Securities and Exchange Commission's computer systems
   * to identify corporations and individuals who have filed disclosure with the SEC.
   */
  readonly cik: string;

  /**
   * Financial Instrument Global Identifier is an open standard, unique identifier of financial instruments that can
   * be assigned to instruments including common stock, options, derivatives, futures, corporate and government bonds,
   * municipals, currencies, and mortgage products
   *
   * A FIGI consists of three parts: A two-character prefix, a 'G' as the third character; an eight character alpha-numeric
   * code which does not contain English vowels "A", "E", "I", "O", or "U"; and a single check digit.
   */
  readonly compositeFigi: string;
  readonly shareClassFigi: string;
  readonly marketCap?: number; // polygon doesn't have market cap for ETF.
  readonly sicCode?: string;
  readonly sicDescription?: string;
  readonly listDate: string;
  readonly outstandingShares: number;
  readonly weightedSharesOutstanding?: number; // convert different outstanding classes to this class, and times it price to get the market cap.
  readonly description?: string;
  readonly employeeCount?: number;
  readonly tickerRoot?: string; // e.g. GOOGL ticker root is GOOG
  readonly tickerSuffix?: string; // e.g. GOOGL ticker suffix is L
}

export interface LatestSnapshot {
  readonly S: string;
  readonly f: DataSource;
  readonly lt: Trade; // latest trade
  readonly lq: Quote; // latest quote
  readonly mb: Bar; // minute bar
  readonly db: Bar; // today's bar
  readonly pdb: Bar; // previous trading bar.
}

export interface StockSplit {
  readonly executionDate: string; // e.g. "2014-06-09",
  readonly splitFrom: number; // e.g 1,
  readonly splitTo: number; // e.g. 4
  readonly ticker: string;
}

export type DividendType =
  | 'CD' // consistent scheduled dividends
  | 'SC' // special dividends
  | 'LT' // long term dividends ?
  | 'ST'; // short term dividends ?

export type DividendFrequency = 'one-time' | 'annually' | 'bi-annually' | 'quarterly' | 'monthly';

export interface Dividend {
  readonly cashAmount: number;
  readonly currency: 'USD' | string;
  readonly dividendType: DividendType;
  readonly ticker: string;
  readonly frequency: DividendFrequency;
  readonly declarationDate: string;
  readonly exDividendDate: string;
  readonly recordDate: string;
  readonly payDate: string;
}
