import { marketHour, marketState, parseOccSymbol, requireOccSymbol, type OccSymbol } from '@fleece/marketdata';
import { Decimal, easternClock, LEDGER_SCALE, LoggerFactory, mapWithConcurrency } from '@fleece/utilities';

import { BacktestAccountImpl, contractMultiplier, type Position, type Trade } from '../backtest/account';
import { BacktestDriver, BaseStrategy, type StrategyTrade } from '../backtest/driver';
import { BacktestMarketDataImpl } from '../backtest/marketdata';
import { BacktestTime } from '../backtest/time';
import { TradeReport } from '../backtest/trade-report';
import { impliedVolatilityHistoryHelper, marketDataClient, optionsAvailabilitiesHelper, optionsQuoteSpreadHelper } from '../client';
import { findGreek, type OptionPrice } from './greeks';
import type { ImpliedVolatilityHistoryHelper, ImpliedVolatilityPoint } from '../utils/implied-volatility-history';
import { daysToExpiration, expirationsByPreference } from '../utils/option-selection';
import type { OptionsQuoteSpreadHelper } from '../utils/options-quote-spread';
import { choosePut, ENTRY_DELTA, ENTRY_DTE, EXIT_DTE, exitReason, ivPercentile, type PutCandidate } from './sell-put-rules';

const logger = LoggerFactory.getLogger('SellPut');

const SYMBOL = 'AAPL';

/**
 * The volatility history comes from the cache, which starts in February 2024, so the first
 * session with 252 earlier ones to rank against is in February 2025.
 */
const RUN_FROM = '2025-01-01';
const RUN_TO = '2026-08-31';

const MINUTE = 60_000;
/** A minute after the 11:00 sample's bar is published, which is 11:01:04. */
const DECISION_TIME = '11:02:00';
const CONTRACTS = 1;

const RISK_FREE_RATE = 0.043;
/** AAPL's, roughly. */
const DIVIDEND_YIELD = 0.004;

/** Alpaca is commission free. */
const COMMISSION_PER_CONTRACT = Decimal.of('0.0');

/** Options are quoted in cents, and a fill lands on that grid wherever the estimate falls. */
const PRICE_SCALE = 2;

const IV_LOOKBACK_SAMPLES = 252;
const MIN_ENTRY_IV_PERCENTILE = 30;
/** The grid bar whose volatility is ranked. */
const IV_SAMPLE_TIME = '11:00:00';

/**
 * How old the last print may be. A delta is solved from the option's last trade against
 * the stock's last minute, so a put that last traded twenty minutes ago is priced against
 * a spot it never saw. Exits are held to a tighter bound because they also fill at that
 * print.
 */
const ENTRY_PRINT_MAX_AGE = 15 * MINUTE;
const EXIT_PRINT_MAX_AGE = 5 * MINUTE;

/** Low enough to reach a 0.15 delta 50 days out at 80 vol, which a sell-off reaches. */
const ENTRY_STRIKE_FLOOR = 0.7;
/** Same as the availability sweep, which is the figure known to stay under Alpaca's rate limit. */
const FETCH_CONCURRENCY = 10;

interface PricedPut extends PutCandidate {
  /** The print the delta was solved from, per share. */
  readonly price: number;
  readonly iv: number;
}

function minute(timestamp: number): string {
  return `${easternClock.date(timestamp)} ${easternClock.time(timestamp).slice(0, 5)}`;
}

/** The at-the-money volatility a point stands for: its put's and call's, averaged, since a trade print can sit anywhere in the spread and the two sides' errors lean opposite ways. */
function meanVolatility(point: ImpliedVolatilityPoint): number {
  return (point.putIv + point.callIv) / 2;
}

function volPoints(iv: number): string {
  return `${(iv * 100).toFixed(1)}%`;
}

/**
 * A side of an estimated quote as a fill price. The estimate is floating-point arithmetic over
 * a median and a print, which `Decimal.of` does not take; rounding to the cent settles the scale
 * at the grid the quote itself would sit on.
 */
function fillPrice(estimate: number): Decimal {
  return Decimal.of(estimate.toFixed(PRICE_SCALE));
}

export interface SellPutProps {
  /** The stock whose puts are sold. */
  readonly symbol: string;
  /**
   * Annualised continuous dividend yield, as a decimal: `0.004` is 0.4%. Every volatility
   * and delta is solved with it, and leaving a payer's yield out reads its puts as cheaper
   * volatility than they are.
   */
  readonly dividendYield: number;
  /** Where today's at-the-money volatility and the sessions it is ranked against come from. */
  readonly volatilityHistory: ImpliedVolatilityHistoryHelper;
  /**
   * What every fill is priced from. A minute bar's close is a trade print, not a price anyone
   * was offering, and a short-premium backtest filled at the print on both sides reports the
   * spread it never paid as profit. The print is taken as the middle of the quote, and this
   * strategy sells at the estimated bid and buys back at the estimated ask.
   */
  readonly quoteSpread: OptionsQuoteSpreadHelper;
}

/**
 * Sells a 45-day, 0.20-delta put on one stock when its implied volatility is high for it.
 *
 * At 11:02 each session: rank the month's at-the-money volatility at the 11:00 bar against
 * the 252 sessions before, and sell if the percentile is at least 30 and no short put is held.
 * Every minute, for each short put held: buy it back at half the credit, at a loss of twice
 * the credit, or with 21 days left. The rules themselves are in `sell-put-rules.ts`.
 */
export class SellPut extends BaseStrategy {
  private readonly symbol: string;
  private readonly dividendYield: number;
  private readonly volatilityHistory: ImpliedVolatilityHistoryHelper;
  private readonly quoteSpread: OptionsQuoteSpreadHelper;

  constructor(props: SellPutProps) {
    const symbol = props.symbol.trim().toUpperCase();
    super(`sell-put-${symbol}`);
    this.symbol = symbol;
    this.dividendYield = props.dividendYield;
    this.volatilityHistory = props.volatilityHistory;
    this.quoteSpread = props.quoteSpread;
  }

  /**
   * Sweeps whatever sessions the volatility history does not hold yet and loads it, so the
   * run starts from a current history and the first decision does not stall on reading it.
   * The spread table is read here for the other reason: a run whose captures are missing
   * cannot fill anything, and its first entry can be months of sessions away.
   */
  async init(): Promise<void> {
    await this.volatilityHistory.save(this.symbol);
    await this.volatilityHistory.sessions(this.symbol);
    await this.quoteSpread.warm(this.symbol);
  }

  async tick(): Promise<ReadonlyArray<StrategyTrade> | undefined> {
    const now = this.timestamp;
    if (marketState(now) !== 'open') {
      return undefined;
    }

    const held = this.heldPuts();
    const trades: StrategyTrade[] = [];
    for (const position of held) {
      const exit = await this.exit(position, now);
      if (exit !== undefined) {
        trades.push(exit);
      }
    }

    if (easternClock.time(now) === DECISION_TIME) {
      // A put closed this minute stays in the portfolio until the driver records the close,
      // so whether the strategy is flat is decided here rather than read back from it.
      const entry = await this.decide(now, trades.length === held.length);
      if (entry !== undefined) {
        trades.push(entry);
      }
    }
    return trades;
  }

  /** Every short put on this stock the portfolio holds. A long one is not this strategy's to exit. */
  private heldPuts(): ReadonlyArray<Position> {
    return this.portfolio.positions().filter((position) => {
      const occSymbol = parseOccSymbol(position.symbol);
      return occSymbol?.underlying === this.symbol && occSymbol.type === 'put' && position.size < 0;
    });
  }

  private async exit(held: Position, now: number): Promise<StrategyTrade | undefined> {
    const occSymbol = requireOccSymbol(held.symbol, 'read the put this strategy holds');
    const today = easternClock.date(now);
    const daysLeft = daysToExpiration(today, occSymbol.expiration);
    if (daysLeft <= 0) {
      throw new Error(
        `${held.symbol} reached expiration still held, which the ${EXIT_DTE}-day exit exists to prevent. The backtest account cannot assign, so any P&L from here is invented. Check why it had no print within ${EXIT_PRINT_MAX_AGE / MINUTE} minutes since then.`,
      );
    }

    const print = await this.lastPrint(occSymbol, now, EXIT_PRINT_MAX_AGE);
    if (print === undefined) {
      return undefined;
    }

    // Spot is read for the moneyness group the spread comes from, which a group 5 points of
    // moneyness wide does not need to the minute, so the entry's looser bound serves here too.
    const spot = await this.spot(now);
    if (spot === undefined) {
      logger.warn(
        `${minute(now)} ${this.symbol} has no print in the last ${ENTRY_PRINT_MAX_AGE / MINUTE} minutes, so ${held.symbol} has no spread to buy back at. No exit check this minute.`,
      );
      return undefined;
    }
    const quote = await this.quoteSpread.estimateQuote({ contract: occSymbol, underlyingPrice: spot, referencePrice: print.price, timestamp: now });

    // Net of the opening commission, which the account keeps in the position's basis.
    const credit = Decimal.of(held.averagePrice);
    const debit = fillPrice(quote.ask);
    const reason = exitReason({ credit, debit, daysToExpiration: daysLeft });
    if (reason === undefined) {
      return undefined;
    }

    const contracts = Decimal.of(held.size).abs();
    const trade: Trade = { symbol: held.symbol, size: contracts.toString(), price: debit.toString(), timestamp: now };
    logger.info(
      `${minute(now)} ${reason}: bought back ${contracts.toString()} ${held.symbol} at the ${debit.toFixed(2)} ask (print ${print.price.toFixed(2)}, printed ${minute(print.at)}, spread ${quote.spread.toFixed(2)}), sold at ${credit.toFixed(4)} after commission, ${daysLeft} days left.`,
    );
    return { trade, context: { kind: 'close', commission: COMMISSION_PER_CONTRACT.mul(contracts).toString(), reason } };
  }

  /** The 11:02 decision: rank today's 11:00 volatility, then sell a put if it and the book allow. */
  private async decide(now: number, flat: boolean): Promise<StrategyTrade | undefined> {
    const today = easternClock.date(now);
    const spot = await this.spot(now);
    if (spot === undefined) {
      logger.warn(`${today}: ${this.symbol} has no print in the ${ENTRY_PRINT_MAX_AGE / MINUTE} minutes before ${DECISION_TIME}. No entry today.`);
      return undefined;
    }

    const { points } = await this.volatilityHistory.impliedVolatilityHistory({
      underlying: this.symbol,
      time: IV_SAMPLE_TIME,
      timestamp: now,
      limit: IV_LOOKBACK_SAMPLES + 1,
      riskFreeRate: RISK_FREE_RATE,
      dividendYield: this.dividendYield,
    });
    const latest = points[points.length - 1];
    if (latest === undefined || latest.date !== today) {
      logger.warn(`${today}: no at-the-money volatility at ${IV_SAMPLE_TIME}. No entry today.`);
      return undefined;
    }

    // Ranked against the sessions before today: today counted in its own history would never
    // read below 1/253.
    const iv = meanVolatility(latest);
    const history = points.slice(0, -1).map(meanVolatility);
    const percentile = history.length < IV_LOOKBACK_SAMPLES ? undefined : ivPercentile(history, iv);
    if (percentile === undefined) {
      logger.debug(`${today}: at-the-money IV ${volPoints(iv)}, but only ${history.length} of the ${IV_LOOKBACK_SAMPLES} earlier sessions to rank it against. No entry.`);
      return undefined;
    }

    const context = `${today}: at-the-money IV ${volPoints(iv)}, percentile ${percentile.toFixed(0)}, spot ${spot.toFixed(2)}`;
    if (!flat) {
      logger.debug(`${context}. Already holding a put.`);
      return undefined;
    }
    if (percentile < MIN_ENTRY_IV_PERCENTILE) {
      logger.debug(`${context}. Below the ${MIN_ENTRY_IV_PERCENTILE} needed to sell.`);
      return undefined;
    }

    const put = await this.findPut(now, spot);
    if (put === undefined) {
      logger.info(
        `${context}. No put ${ENTRY_DTE.min}-${ENTRY_DTE.max} days out at ${ENTRY_DELTA.min}-${ENTRY_DELTA.max} delta printed in the last ${ENTRY_PRINT_MAX_AGE / MINUTE} minutes. No entry.`,
      );
      return undefined;
    }

    const quote = await this.quoteSpread.estimateQuote({ contract: put.occSymbol, underlyingPrice: spot, referencePrice: put.price, timestamp: now });
    const credit = fillPrice(quote.bid);
    if (!credit.isPositive()) {
      logger.info(`${context}. ${put.occSymbol.symbol} printed ${put.price}, which leaves no credit at the bid across a ${quote.spread.toFixed(2)} spread. No entry.`);
      return undefined;
    }

    const contracts = Decimal.of(CONTRACTS);
    const symbol = put.occSymbol.symbol;
    const daysLeft = daysToExpiration(today, put.occSymbol.expiration);
    const trade: Trade = { symbol, size: contracts.neg().toString(), price: credit.toString(), timestamp: now };
    // Strike × 100 per contract, from the exact thousandths OCC states rather than the float strike.
    const capital = Decimal.of(put.occSymbol.strikeMils).mul(contractMultiplier(symbol)).mul(contracts).div(Decimal.of(1000), LEDGER_SCALE);
    logger.info(
      `${context}. Sold ${CONTRACTS} ${symbol} at the ${credit.toFixed(2)} bid (print ${put.price.toFixed(2)}, spread ${quote.spread.toFixed(2)}), delta ${put.delta.toFixed(3)}, ${daysLeft} days out.`,
    );
    return {
      trade,
      context: {
        kind: 'open',
        commission: COMMISSION_PER_CONTRACT.mul(contracts).toString(),
        capital: capital.toString(),
        notes: {
          dte: String(daysLeft),
          delta: put.delta.toFixed(3),
          spread: quote.spread.toFixed(2),
          iv: volPoints(put.iv),
          atmIv: volPoints(iv),
          ivPct: percentile.toFixed(0),
          spot: spot.toFixed(2),
        },
      },
    };
  }

  /** The stock's last minute close, if it is recent enough to solve a volatility against. */
  private async spot(now: number): Promise<number | undefined> {
    const { bars } = await this.data.minuteBars({ symbol: this.symbol, from: easternClock.date(now) });
    const last = bars[bars.length - 1];
    return last === undefined || now - last.t > ENTRY_PRINT_MAX_AGE ? undefined : last.c;
  }

  /** The put to sell: the nearest qualifying expiration that has a put in the delta band. */
  private async findPut(now: number, spot: number): Promise<PricedPut | undefined> {
    const today = easternClock.date(now);
    const { contracts } = await this.data.listActiveOptionContracts({
      underlying: this.symbol,
      type: 'put',
      expirationFrom: easternClock.shiftDate(today, ENTRY_DTE.min),
      expirationTo: easternClock.shiftDate(today, ENTRY_DTE.max),
      strikeFrom: spot * ENTRY_STRIKE_FLOOR,
      strikeTo: spot,
    });

    for (const expiration of expirationsByPreference(
      contracts.map((contract) => contract.expiration),
      today,
      ENTRY_DTE,
    )) {
      const chain = contracts.filter((contract) => contract.expiration === expiration);
      const risks = findGreek({ timestamp: now, stockSpotPrice: spot, optionPrices: await this.prices(chain, now) }, RISK_FREE_RATE, this.dividendYield);
      const candidates = chain.flatMap((occSymbol): PricedPut[] => {
        const risk = risks.get(occSymbol.symbol);
        return risk === undefined ? [] : [{ occSymbol, delta: risk.delta, price: risk.price, iv: risk.impliedVolatility }];
      });
      const chosen = choosePut(candidates);
      if (chosen !== undefined) {
        return chosen;
      }
    }
    return undefined;
  }

  /** The contracts that printed recently enough to price at entry, keyed by symbol. */
  private async prices(contracts: ReadonlyArray<OccSymbol>, now: number): Promise<ReadonlyMap<string, OptionPrice>> {
    const prices = new Map<string, OptionPrice>();
    await mapWithConcurrency(contracts, FETCH_CONCURRENCY, async (occSymbol) => {
      const print = await this.lastPrint(occSymbol, now, ENTRY_PRINT_MAX_AGE);
      if (print !== undefined) {
        prices.set(occSymbol.symbol, print);
      }
    });
    return prices;
  }

  /**
   * The contract's last close this session, if it is no older than `maxAge`. A print
   * before the open is left out: the option endpoints do no session filtering, and a stray
   * pre-market trade would otherwise read as fresh in the first minutes of the day.
   *
   * Warns with the reason whenever there is no price, since each one is a decision the
   * strategy could not make — an exit not checked, a strike not considered.
   */
  private async lastPrint(occSymbol: OccSymbol, now: number, maxAge: number): Promise<OptionPrice | undefined> {
    const openAt = marketHour(now)?.openAt;
    const { bars } = await this.data.optionMinuteBars({ symbol: occSymbol.symbol, from: easternClock.date(now) });
    const last = bars[bars.length - 1];

    if (last === undefined || openAt === undefined) {
      logger.warn(`${minute(now)} ${occSymbol.symbol} has not printed yet today. No price for it this minute.`);
      return undefined;
    }
    if (last.t < openAt || now - last.t > maxAge) {
      const when = last.t < openAt ? 'before the open' : `${(now - last.t) / MINUTE} minutes ago, past the ${maxAge / MINUTE}-minute limit`;
      logger.warn(`${minute(now)} ${occSymbol.symbol} last printed at ${minute(last.t)}, ${when}. No price for it this minute.`);
      return undefined;
    }
    return { occSymbol, price: last.c, at: last.t };
  }
}

async function main(): Promise<void> {
  const time = new BacktestTime(easternClock.timestamp(RUN_FROM), easternClock.timestamp(RUN_TO, '23:59:59'), MINUTE);
  const client = marketDataClient();
  const availabilities = optionsAvailabilitiesHelper(client);
  const marketData = new BacktestMarketDataImpl(client, availabilities);
  const report = new TradeReport();
  const account = new BacktestAccountImpl(report);

  const driver = new BacktestDriver({ time, marketData, account });
  driver.addStrategy(
    new SellPut({
      symbol: SYMBOL,
      dividendYield: DIVIDEND_YIELD,
      volatilityHistory: impliedVolatilityHistoryHelper(client, availabilities),
      quoteSpread: optionsQuoteSpreadHelper(client),
    }),
  );
  await driver.run();

  for (const line of report.render()) {
    logger.info(line);
  }
}

main().catch((error: unknown) => {
  logger.error(`${String(error)}`);
  process.exitCode = 1;
});
