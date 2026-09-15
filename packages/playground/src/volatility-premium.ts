/**
 * Whether an underlying's options were worth selling: its 30-day implied volatility at each
 * session's close against the volatility that then happened over those 30 days, and whether
 * implied above trailing realized said so in advance. Prints each session and a summary.
 * Nothing is persisted.
 *
 *   npm run volatility-premium -w @fleece/playground
 *
 * Every volatility here is on implied volatility's clock, 365 calendar days a year, so the
 * columns subtract:
 *
 *   edge    = IV − what was realized close to close over the next 30 calendar days
 *   signal  = IV − trailing realized, restated for the sessions those 30 days hold
 *
 * The edge uses the future and grades the history; only the signal is something a strategy
 * could have acted on.
 */
import { dayOfWeek, easternClock, LoggerFactory } from '@fleece/utilities';

import { BacktestMarketDataImpl } from './backtest/marketdata';
import { marketDataClient, optionsAvailabilitiesHelper } from './client';
import { HistoricalConstantMaturityVolatilityLoader, type ConstantMaturityVolatilityPoint } from './utils/constant-maturity-volatility';
import { calendarClockVolatility, HistoricalRealizedVolatilityLoader, realizedAfter, type RealizedWindow } from './utils/realized-volatility';

const logger = LoggerFactory.getLogger('VolatilityPremiumRunner');

const SYMBOL = 'SOFI';
const DIVIDEND_YIELD = 0.0;
/** The sessions whose closing implied volatility is graded. A month after the last must have passed for it to have an edge. */
const RUN_FROM = '2026-01-01';
const RUN_TO = '2026-08-14';

/** Close to VIX's, which reads 30 days from expirations more than 23 and fewer than 37 days out. */
const DAYS_TO_EXPIRATION = { target: 30, min: 23, max: 37 };
const IV_DAYS = DAYS_TO_EXPIRATION.target;

/** Sessions in a trailing estimate: about the month the implied volatility covers. */
const WINDOW = 21;
/** 1 for a name whose intervals agree down to the minute, as SOFI's and AAPL's do; 5 or 10 for a thinly traded one. */
const INTRADAY_MINUTES = 5;

/** Which trailing estimate the signal subtracts, and so which one the buckets rank by. */
const SIGNAL: TrailingName = 'intradayPlusOvernight';

/**
 * A month holding an overnight gap this many times the trailing gaps' typical size is set apart
 * in the summary. Earnings are the usual cause, and the data has no calendar of them.
 */
const GAP_MULTIPLE = 3;

const BUCKETS = 5;
const WORST = 5;

type TrailingName = 'closeToClose' | 'intradayPlusOvernight' | 'yangZhang';
const TRAILING_NAMES: ReadonlyArray<TrailingName> = ['closeToClose', 'intradayPlusOvernight', 'yangZhang'];
const TRAILING_LABELS: Record<TrailingName, string> = {
  closeToClose: 'close to close',
  intradayPlusOvernight: `${INTRADAY_MINUTES}-min + overnight`,
  yangZhang: 'Yang-Zhang',
};

type TrailingVolatility = Record<TrailingName, number>;

interface Observation {
  readonly date: string;
  /** Where the half-hour chunk the implied volatility was read from starts. */
  readonly time: string;
  readonly iv: number;
  /** On the calendar clock, over the sessions the next `IV_DAYS` hold. */
  readonly trailing: TrailingVolatility;
  /** Absent until `IV_DAYS` have passed. */
  readonly realized?: RealizedWindow;
  /** Whether that month held a gap `GAP_MULTIPLE` times the trailing typical one. */
  readonly largeGap: boolean;
}

/** A chunk that measured an implied volatility. */
interface ClosingVolatility extends ConstantMaturityVolatilityPoint {
  readonly iv: number;
}

interface Graded extends Observation {
  readonly realized: RealizedWindow;
}

function percent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function points(value: number): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}`;
}

function mean(values: ReadonlyArray<number>): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: ReadonlyArray<number>): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function correlation(xs: ReadonlyArray<number>, ys: ReadonlyArray<number>): number {
  const mx = mean(xs);
  const my = mean(ys);
  let covariance = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < xs.length; i++) {
    covariance += (xs[i] - mx) * (ys[i] - my);
    vx += (xs[i] - mx) ** 2;
    vy += (ys[i] - my) ** 2;
  }
  return covariance / Math.sqrt(vx * vy);
}

function edge(observation: Graded): number {
  return observation.iv - observation.realized.volatility;
}

function signal(observation: Observation, name: TrailingName = SIGNAL): number {
  return observation.iv - observation.trailing[name];
}

function isGraded(observation: Observation): observation is Graded {
  return observation.realized !== undefined;
}

/**
 * Each session's implied volatility from the last chunk of it that measured one. Normally the
 * chunk ending at the close; on a thinly traded day, an earlier one.
 */
function closingVolatility(ivs: ReadonlyArray<ConstantMaturityVolatilityPoint>): ReadonlyMap<string, ClosingVolatility> {
  const byDate = new Map<string, ClosingVolatility>();
  for (const point of ivs) {
    const iv = point.iv;
    if (typeof iv === 'number') {
      // In time order, so a later chunk replaces an earlier one.
      byDate.set(point.date, { ...point, iv });
    }
  }
  return byDate;
}

function describe(stats: ReadonlyArray<Graded>): string {
  const edges = stats.map(edge);
  return `mean ${points(mean(edges))}, median ${points(median(edges))}, positive ${percent(edges.filter((value) => value > 0).length / edges.length, 0)}, over ${stats.length}`;
}

function report(observations: ReadonlyArray<Observation>): void {
  const graded = observations.filter(isGraded);
  if (graded.length === 0) {
    logger.info(`No session has ${IV_DAYS} days after it yet, so nothing to grade. End RUN_TO earlier.`);
    return;
  }

  // Each month overlaps the next session's by all but a day, so the sessions are nowhere near
  // independent draws: what is being measured is about one month per 21 sessions.
  logger.info('');
  logger.info(`${graded.length} sessions graded, about ${(graded.length / WINDOW).toFixed(1)} independent months: consecutive sessions' months overlap by all but a day.`);
  logger.info(`Implied ${percent(mean(graded.map((o) => o.iv)))} on average, against ${percent(Math.sqrt(mean(graded.map((o) => o.realized.volatility ** 2))))} realized.`);
  logger.info(`Edge, IV − realized in volatility points: ${describe(graded)}`);

  logger.info('');
  logger.info(`The ${WORST} worst months to have sold into:`);
  for (const worst of [...graded].sort((a, b) => edge(a) - edge(b)).slice(0, WORST)) {
    logger.info(
      `  ${worst.date}: IV ${percent(worst.iv)}, realized ${percent(worst.realized.volatility)}, edge ${points(edge(worst))}, largest gap ${percent(worst.realized.largestGap)}${worst.largeGap ? ' (large)' : ''}`,
    );
  }

  // If selling only on a large signal beats selling every day, the top buckets' edge is above the
  // bottom's. Flat buckets mean the signal adds nothing to always selling.
  logger.info('');
  logger.info(`By signal, IV − ${TRAILING_LABELS[SIGNAL]}, lowest to highest in ${BUCKETS} equal groups:`);
  const bySignal = [...graded].sort((a, b) => signal(a) - signal(b));
  for (let bucket = 0; bucket < BUCKETS; bucket++) {
    const members = bySignal.slice(Math.floor((bucket * bySignal.length) / BUCKETS), Math.floor(((bucket + 1) * bySignal.length) / BUCKETS));
    if (members.length === 0) {
      continue;
    }
    logger.info(`  signal ${points(signal(members[0])).padStart(6)} to ${points(signal(members[members.length - 1])).padStart(6)}: edge ${describe(members)}`);
  }
  for (const name of TRAILING_NAMES) {
    logger.info(
      `  correlation of the edge with IV − ${TRAILING_LABELS[name]}: ${correlation(
        graded.map((o) => signal(o, name)),
        graded.map(edge),
      ).toFixed(2)}`,
    );
  }

  logger.info('');
  const withGap = graded.filter((o) => o.largeGap);
  const withoutGap = graded.filter((o) => !o.largeGap);
  logger.info(`Months holding a gap ${GAP_MULTIPLE}× the trailing typical one: ${withGap.length === 0 ? 'none' : describe(withGap)}`);
  logger.info(`Months without: ${withoutGap.length === 0 ? 'none' : describe(withoutGap)}`);

  // Implied volatility's clock counts a weekend's calendar days that the stock barely moves over,
  // so the same option prices read as a higher volatility on Monday than on Friday.
  logger.info('');
  logger.info('By weekday, every session with an implied volatility:');
  for (const weekday of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) {
    const members = observations.filter((o) => dayOfWeek(o.date) === weekday);
    if (members.length === 0) {
      continue;
    }
    logger.info(`  ${weekday.padEnd(9)} IV ${percent(mean(members.map((o) => o.iv)))}, signal ${points(mean(members.map((o) => signal(o))))}, over ${members.length}`);
  }
}

async function main(): Promise<void> {
  const client = marketDataClient();
  const availabilities = optionsAvailabilitiesHelper(client);
  const data = new BacktestMarketDataImpl(client, availabilities);

  const implied = new HistoricalConstantMaturityVolatilityLoader({
    symbol: SYMBOL,
    dividendYield: DIVIDEND_YIELD,
    data,
    availabilities,
    daysToExpiration: DAYS_TO_EXPIRATION,
    fromDate: RUN_FROM,
    toDate: RUN_TO,
  });
  await implied.load();

  // Measured past RUN_TO, far enough for the last session's month; the loader stops at the last session that has closed.
  const realized = new HistoricalRealizedVolatilityLoader({
    symbol: SYMBOL,
    client,
    fromDate: RUN_FROM,
    toDate: easternClock.shiftDate(RUN_TO, IV_DAYS),
    window: WINDOW,
    intradayMinutes: INTRADAY_MINUTES,
  });
  await realized.load();

  const ivByDate = closingVolatility(implied.getIvs());
  const sessions = realized.getSessions();
  const observations: Observation[] = [];
  for (const point of realized.getPoints()) {
    const iv = ivByDate.get(point.date);
    if (point.date > RUN_TO || iv === undefined) {
      continue;
    }
    const after = realizedAfter(sessions, point.date, IV_DAYS);
    const typicalGap = Math.sqrt(point.trailing.intradayPlusOvernight * point.trailing.overnightShare);
    observations.push({
      date: point.date,
      time: iv.time,
      iv: iv.iv,
      trailing: {
        closeToClose: calendarClockVolatility(point.trailing.closeToClose, point.date, IV_DAYS),
        intradayPlusOvernight: calendarClockVolatility(point.trailing.intradayPlusOvernight, point.date, IV_DAYS),
        yangZhang: calendarClockVolatility(point.trailing.yangZhang, point.date, IV_DAYS),
      },
      realized: after,
      largeGap: after !== undefined && after.largestGap > GAP_MULTIPLE * typicalGap,
    });
  }
  const missing = [...ivByDate.keys()].filter((date) => !observations.some((o) => o.date === date)).length;
  if (missing > 0) {
    logger.warn(`${SYMBOL}: ${missing} sessions have an implied volatility but no realized point, and are left out.`);
  }

  logger.info(`date        IV from  |    IV | trailing: close→close  ${INTRADAY_MINUTES}m+overnight  Yang-Zhang | signal | next ${IV_DAYS} days: realized  edge  largest gap`);
  for (const o of observations) {
    logger.info(
      [
        `${o.date}  ${o.time.slice(0, 5)}`,
        `  | ${percent(o.iv).padStart(6)}`,
        ` |   ${percent(o.trailing.closeToClose).padStart(6)}`,
        `   ${percent(o.trailing.intradayPlusOvernight).padStart(6)}`,
        `   ${percent(o.trailing.yangZhang).padStart(6)}`,
        ` | ${points(signal(o)).padStart(6)}`,
        o.realized === undefined
          ? ' |   -'
          : ` |   ${percent(o.realized.volatility).padStart(6)}  ${points(o.iv - o.realized.volatility).padStart(6)}  ${percent(o.realized.largestGap).padStart(5)}${o.largeGap ? ' large' : ''}`,
      ].join(''),
    );
  }

  report(observations);
}

main().catch((error: unknown) => {
  logger.error(`${String(error)}`);
  process.exitCode = 1;
});
