import { marketHour, marketState, parseOccSymbol, requireOccSymbol, type OccSymbol } from '@fleece/marketdata';
import { Decimal, easternClock, LEDGER_SCALE, LoggerFactory, mapWithConcurrency, sumDecimals } from '@fleece/utilities';

import { BacktestAccountImpl, contractMultiplier, type Position, type Trade } from '../backtest/account';
import { BacktestDriver, BaseStrategy } from '../backtest/driver';
import { BacktestMarketDataImpl } from '../backtest/marketdata';
import { BacktestTime } from '../backtest/time';
import { TradeReport } from '../backtest/trade-report';
import { marketDataClient, optionsAvailabilitiesHelper } from '../client';
import { findGreek } from './greeks';
import type { OptionPrice } from './prices';
import { choosePut, daysToExpiration, ENTRY_DELTA, ENTRY_DTE, EXIT_DTE, exitReason, expirationsByPreference, ivPercentile, type PutCandidate } from './sell-put-rules';

const logger = LoggerFactory.getLogger('SellPut');

const SYMBOL = 'AAPL';

/**
 * A year before the first trade can happen. The strategy measures the volatility its
 * percentile is taken against as the clock passes, rather than loading it from outside the
 * run, so no day can be ranked against a value measured after it — and that first year is
 * spent measuring. Alpaca's option history starts in February 2024.
 */
const RUN_FROM = '2024-02-01';
const RUN_TO = '2026-08-31';

const MINUTE = 60_000;
const DECISION_TIME = '11:00:00';
const CONTRACTS = 1;

const RISK_FREE_RATE = 0.043;
/** AAPL's, roughly. */
const DIVIDEND_YIELD = 0.004;

/**
 * Placeholders until the historical figures are measured. A minute bar's close is a trade
 * print, not a price anyone was offering, and a short-premium backtest filled at the print
 * on both sides reports the spread it never paid as profit.
 */
const SLIPPAGE_PER_SHARE = Decimal.of('0.05');
const COMMISSION_PER_CONTRACT = Decimal.of('0.65');

const IV_LOOKBACK_SAMPLES = 252;
const MIN_ENTRY_IV_PERCENTILE = 30;
/** The volatility ranked is a month's: the at-the-money pair at the expiration nearest 30 days out. */
const IV_DTE = { target: 30, min: 20, max: 40 } as const;
/** Strikes tried, nearest the spot first, before moving to the next expiration. */
const IV_STRIKES_TRIED = 3;

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

interface VolatilitySample {
  readonly date: string;
  readonly iv: number;
}

interface PricedPut extends PutCandidate {
  /** The print the delta was solved from, per share. */
  readonly price: number;
  readonly iv: number;
}

interface StraddlePair {
  readonly strikeMils: number;
  readonly put: OccSymbol;
  readonly call: OccSymbol;
}

function minute(timestamp: number): string {
  return `${easternClock.date(timestamp)} ${easternClock.time(timestamp).slice(0, 5)}`;
}

function volPoints(iv: number): string {
  return `${(iv * 100).toFixed(1)}%`;
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
  readonly report: TradeReport;
}

/**
 * Sells a 45-day, 0.20-delta put on one stock when its implied volatility is high for it.
 *
 * At 11:00 each session: measure the month's at-the-money volatility, rank it against the
 * last 252 measured, and sell if the percentile is at least 30 and no short put is held.
 * Every minute, for each short put held: buy it back at half the credit, at a loss of twice
 * the credit, or with 21 days left. The rules themselves are in `sell-put-rules.ts`.
 */
export class SellPut extends BaseStrategy {
  private readonly symbol: string;
  private readonly dividendYield: number;
  private readonly report: TradeReport;
  private readonly volatility: VolatilitySample[] = [];

  constructor(props: SellPutProps) {
    const symbol = props.symbol.trim().toUpperCase();
    super(`sell-put-${symbol}`);
    this.symbol = symbol;
    this.dividendYield = props.dividendYield;
    this.report = props.report;
  }

  async tick(): Promise<ReadonlyArray<Trade> | undefined> {
    const now = this.timestamp;
    if (marketState(now) !== 'open') {
      return undefined;
    }

    const held = this.heldPuts();
    const trades: Trade[] = [];
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

  private async exit(held: Position, now: number): Promise<Trade | undefined> {
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

    const credit = Decimal.of(held.averagePrice);
    const debit = Decimal.of(print.price).add(SLIPPAGE_PER_SHARE);
    const reason = exitReason({ credit, debit, daysToExpiration: daysLeft });
    if (reason === undefined) {
      return undefined;
    }

    const contracts = Decimal.of(held.size).abs();
    const trade: Trade = { symbol: held.symbol, size: contracts.toString(), price: debit.toString(), timestamp: now };
    this.report.closed({ trade, commission: COMMISSION_PER_CONTRACT.mul(contracts).toString(), reason });
    logger.info(
      `${minute(now)} ${reason}: bought back ${contracts.toString()} ${held.symbol} at ${debit.toFixed(2)} (print ${print.price.toFixed(2)}, printed ${minute(print.at)}), sold at ${credit.toFixed(2)}, ${daysLeft} days left.`,
    );
    return trade;
  }

  /** The 11:00 decision: record today's volatility, then sell a put if it and the book allow. */
  private async decide(now: number, flat: boolean): Promise<Trade | undefined> {
    const today = easternClock.date(now);
    const spot = await this.spot(now);
    if (spot === undefined) {
      logger.warn(`${today}: ${this.symbol} has no print in the ${ENTRY_PRINT_MAX_AGE / MINUTE} minutes before ${DECISION_TIME}. No volatility sample and no entry today.`);
      return undefined;
    }

    const iv = await this.atTheMoneyVolatility(now, spot);
    if (iv === undefined) {
      logger.warn(
        `${today}: no at-the-money put and call ${IV_DTE.min}-${IV_DTE.max} days out both printed in the last ${ENTRY_PRINT_MAX_AGE / MINUTE} minutes. No volatility sample and no entry today.`,
      );
      return undefined;
    }

    // Ranked against the samples before today, then recorded: today counted in its own
    // history would never read below 1/253.
    const history = this.volatility.slice(-IV_LOOKBACK_SAMPLES).map((sample) => sample.iv);
    this.volatility.push({ date: today, iv });
    const percentile = history.length < IV_LOOKBACK_SAMPLES ? undefined : ivPercentile(history, iv);
    if (percentile === undefined) {
      logger.debug(
        `${today}: at-the-money IV ${volPoints(iv)}, spot ${spot.toFixed(2)}. Sample ${this.volatility.length} of the ${IV_LOOKBACK_SAMPLES} needed before the first entry.`,
      );
      return undefined;
    }
    if (this.volatility.length === IV_LOOKBACK_SAMPLES + 1) {
      logger.info(`${today}: ${IV_LOOKBACK_SAMPLES} sessions of volatility recorded since ${this.volatility[0].date}. Entries can start.`);
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

    const credit = Decimal.of(put.price).sub(SLIPPAGE_PER_SHARE);
    if (!credit.isPositive()) {
      logger.info(`${context}. ${put.occSymbol.symbol} printed ${put.price}, which is no credit after ${SLIPPAGE_PER_SHARE.toString()} slippage. No entry.`);
      return undefined;
    }

    const contracts = Decimal.of(CONTRACTS);
    const symbol = put.occSymbol.symbol;
    const daysLeft = daysToExpiration(today, put.occSymbol.expiration);
    const trade: Trade = { symbol, size: contracts.neg().toString(), price: credit.toString(), timestamp: now };
    // Strike × 100 per contract, from the exact thousandths OCC states rather than the float strike.
    const capital = Decimal.of(put.occSymbol.strikeMils).mul(contractMultiplier(symbol)).mul(contracts).div(Decimal.of(1000), LEDGER_SCALE);
    this.report.opened({
      trade,
      commission: COMMISSION_PER_CONTRACT.mul(contracts).toString(),
      capital: capital.toString(),
      notes: {
        dte: String(daysLeft),
        delta: put.delta.toFixed(3),
        iv: volPoints(put.iv),
        atmIv: volPoints(iv),
        ivPct: percentile.toFixed(0),
        spot: spot.toFixed(2),
      },
    });
    logger.info(`${context}. Sold ${CONTRACTS} ${symbol} at ${credit.toFixed(2)} (print ${put.price.toFixed(2)}), delta ${put.delta.toFixed(3)}, ${daysLeft} days out.`);
    return trade;
  }

  /** The stock's last minute close, if it is recent enough to solve a volatility against. */
  private async spot(now: number): Promise<number | undefined> {
    const { bars } = await this.data.minuteBars({ symbol: this.symbol, from: easternClock.date(now) });
    const last = bars[bars.length - 1];
    return last === undefined || now - last.t > ENTRY_PRINT_MAX_AGE ? undefined : last.c;
  }

  /**
   * The mean of the put's and the call's implied volatility at the strike nearest the spot,
   * at the expiration nearest 30 days out. Both rather than one, because a trade print can
   * sit anywhere in the spread and the two sides' errors lean opposite ways.
   */
  private async atTheMoneyVolatility(now: number, spot: number): Promise<number | undefined> {
    const today = easternClock.date(now);
    const { contracts } = await this.data.listActiveOptionContracts({
      underlying: this.symbol,
      expirationFrom: easternClock.shiftDate(today, IV_DTE.min),
      expirationTo: easternClock.shiftDate(today, IV_DTE.max),
      strikeFrom: spot * 0.9,
      strikeTo: spot * 1.1,
    });

    for (const expiration of expirationsByPreference(
      contracts.map((contract) => contract.expiration),
      today,
      IV_DTE,
    )) {
      for (const pair of straddlePairs(contracts, expiration, spot).slice(0, IV_STRIKES_TRIED)) {
        const risks = findGreek({ timestamp: now, stockSpotPrice: spot, optionPrices: await this.prices([pair.put, pair.call], now) }, RISK_FREE_RATE, this.dividendYield);
        const put = risks.get(pair.put.symbol);
        const call = risks.get(pair.call.symbol);
        if (put !== undefined && call !== undefined) {
          return (put.impliedVolatility + call.impliedVolatility) / 2;
        }
      }
    }
    return undefined;
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

/** Strikes that have both a put and a call at `expiration`, nearest the spot first. */
function straddlePairs(contracts: ReadonlyArray<OccSymbol>, expiration: string, spot: number): ReadonlyArray<StraddlePair> {
  const byStrike = new Map<number, { put?: OccSymbol; call?: OccSymbol }>();
  for (const contract of contracts) {
    if (contract.expiration !== expiration) {
      continue;
    }
    const sides = byStrike.get(contract.strikeMils) ?? {};
    byStrike.set(contract.strikeMils, contract.type === 'put' ? { ...sides, put: contract } : { ...sides, call: contract });
  }
  return [...byStrike]
    .flatMap(([strikeMils, { put, call }]) => (put === undefined || call === undefined ? [] : [{ strikeMils, put, call }]))
    .sort((left, right) => Math.abs(left.put.strike - spot) - Math.abs(right.put.strike - spot));
}

async function main(): Promise<void> {
  const time = new BacktestTime(easternClock.timestamp(RUN_FROM), easternClock.timestamp(RUN_TO, '23:59:59'), MINUTE);
  const client = marketDataClient();
  const marketData = new BacktestMarketDataImpl(client, optionsAvailabilitiesHelper(client));
  const account = new BacktestAccountImpl();
  const report = new TradeReport();

  const driver = new BacktestDriver({ time, marketData, account });
  driver.addStrategy(new SellPut({ symbol: SYMBOL, dividendYield: DIVIDEND_YIELD, report }));
  await driver.run();

  for (const line of report.render()) {
    logger.info(line);
  }

  // The report prices its round trips itself and the account booked the same fills, so the
  // two must agree. If they do not, one of them paired or priced a fill wrongly and the
  // totals above are not to be trusted.
  const booked = sumDecimals(account.realizedPLs().map((entry) => Decimal.of(entry.realizedPL)));
  const reported = report.summary().grossPL;
  if (!booked.round(2).eq(reported.round(2))) {
    throw new Error(
      `The account booked ${booked.toFixed(2)} realized, but the report's round trips add up to ${reported.toFixed(2)} gross. Find the fill they disagree on before reading the report.`,
    );
  }
}

main().catch((error: unknown) => {
  logger.error(`${String(error)}`);
  process.exitCode = 1;
});
