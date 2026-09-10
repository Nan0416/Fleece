/**
 * The equity data model, ported from `@qnquant/equity-data-models` with its field names
 * intact: a `Bar` is `{S, o, h, l, c, v, t}` here as it is on Alpaca's and Polygon's
 * WebSocket feeds, because these types are what a feed hands a strategy tick by tick.
 *
 * Options share it as far as it goes — an option bar and an option quote are those
 * shapes exactly — and the types below `OptionType` are what they need beyond it.
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

/**
 * The option model starts here. It is smaller than the equity one rather than larger:
 * OPRA sends no trade id and no tape, and a `Trade` requires both.
 */

export type OptionType = 'call' | 'put';

/**
 * An OCC contract symbol taken apart: `AAPL260918C00230000` is a September 18th 2026
 * AAPL 230 call.
 *
 * Parsed rather than carried alongside because the chain endpoint answers with nothing
 * but the symbol — no strike, no expiry, no type — so a caller cannot tell one contract
 * from another without this.
 */
export interface OccSymbol {
  readonly symbol: string;
  /** The ticker the contract is written on, without any adjustment suffix. */
  readonly underlying: string;
  /**
   * The OCC root. Equal to `underlying` for an ordinary contract, and `underlying` plus a
   * digit — `AAPL1` — for one a split, a spinoff or a special dividend re-issued. That an
   * adjusted contract does not deliver 100 shares is the reason to be able to tell.
   */
  readonly root: string;
  /** ISO `YYYY-MM-DD`. */
  readonly expiration: string;
  readonly type: OptionType;
  /** In dollars, so `230` for a 230 strike. Derived from `strikeMils`. */
  readonly strike: number;
  /**
   * The strike as OCC states it, in thousandths of a dollar. Kept because it is the
   * exact value: `strike` is that number divided by 1000, and a strike like 0.105 has
   * no exact double.
   */
  readonly strikeMils: number;
}

/** Alpaca's, computed from its own volatility surface rather than reported by OPRA. */
export interface OptionGreeks {
  readonly delta: number;
  readonly gamma: number;
  readonly theta: number;
  readonly vega: number;
  readonly rho: number;
}

export interface OptionTrade {
  /** The OCC contract symbol. */
  readonly S: string;
  /** Exchange code, a letter. */
  readonly x: string;
  /** Premium per share, so a contract costs this times its multiplier. */
  readonly p: number;
  /** Contracts, not shares. */
  readonly s: number;
  readonly t: number;
  /**
   * Condition codes. An array although OPRA sends exactly one, because the equity model
   * is an array and a classifier over the two should not need two shapes.
   *
   * These decide whether a print means what it appears to. `f` and `g` — multi-leg
   * autoelectronic and multi-leg auction — mark a leg of a spread, whose price is that
   * leg's share of a package rather than a price anyone paid for the contract alone;
   * `A`, `C`, `E` and `G` mark a trade that was subsequently cancelled.
   */
  readonly c?: ReadonlyArray<string>;
}

/**
 * One contract's corner of an option chain.
 *
 * Every section is optional, which is not defensiveness: Alpaca omits `prevDailyBar` for
 * a contract that did not trade the day before, and omits the greeks and the implied
 * volatility wherever it could not solve them — around four contracts in ten of a large
 * chain.
 */
export interface OptionSnapshot {
  readonly S: string;
  readonly f: DataSource;
  readonly contract: OccSymbol;
  /** Latest trade. */
  readonly lt?: OptionTrade;
  /** Latest quote. */
  readonly lq?: Quote;
  /** Latest minute bar. */
  readonly mb?: Bar;
  /** Today's bar. */
  readonly db?: Bar;
  /** The previous trading day's bar. */
  readonly pdb?: Bar;
  readonly greeks?: OptionGreeks;
  /** Implied volatility, as a fraction: `0.69` is 69%. */
  readonly iv?: number;
}

export type OptionStyle = 'american' | 'european';

/** A contract expiring today is still `active`; `inactive` covers expired and delisted alike. */
export type OptionContractStatus = 'active' | 'inactive';

/** What a contract delivers on exercise. Present only when the request asked for it. */
export interface OptionDeliverable {
  readonly type: 'cash' | 'equity';
  /** Absent for cash. */
  readonly symbol?: string;
  /** Shares for `equity`, dollars for `cash`. */
  readonly amount: number;
  /** A percentage, so `100` is the whole contract. */
  readonly allocationPercentage: number;
  readonly settlementType: 'T+0' | 'T+1' | 'T+2' | 'T+3' | 'T+4' | 'T+5' | string;
  readonly settlementMethod: 'BTOB' | 'CADF' | 'CAFX' | 'CCC' | string;
}

/**
 * A listed option contract: the instrument, not a price for it. Expiry, type, strike and
 * underlying are all stated by `S`, which `parseOccSymbol` takes apart.
 */
export interface OptionContract {
  readonly S: string;
  readonly f: DataSource;
  readonly status: OptionContractStatus;
  /** Whether Alpaca will accept an order for it, as of now rather than as of the expiry. */
  readonly tradable: boolean;
  readonly style: OptionStyle;
  /** Shares one contract prices — 100 unless an adjustment changed it. */
  readonly multiplier: number;
  /** Shares one contract delivers. Equal to `multiplier` except where an adjustment split them. */
  readonly size: number;
  readonly deliverables?: ReadonlyArray<OptionDeliverable>;
  /** As of `openInterestDate`, not as of now. */
  readonly openInterest?: number;
  readonly openInterestDate?: string;
  /** Premium per share, as of `closePriceDate`. */
  readonly closePrice?: number;
  readonly closePriceDate?: string;
}
