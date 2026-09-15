/**
 * An underlying's realized volatility, estimated three ways over the same sessions, to see the
 * math on real bars: close to close, intraday plus overnight, and Yang-Zhang. Prints each
 * session, then what the estimators say about each other. Nothing is persisted.
 *
 *   npm run realized-volatility -w @fleece/playground
 *
 * Every estimator builds a session's variance from the same two pieces:
 *
 *   overnight   o = ln(Open / previous Close)     the gap, a weekend or holiday included
 *   intraday    c = ln(Close / Open)              and the path between, which only minute bars see
 *
 * The math is in `utils/realized-volatility.ts`; this reports on it.
 */
import { LoggerFactory } from '@fleece/utilities';

import { marketDataClient } from './client';
import {
  annualizedVolatility,
  calendarClockVolatility,
  HistoricalRealizedVolatilityLoader,
  intradayVarianceAt,
  realizedAfter,
  SAMPLING_MINUTES,
  sessionsWithin,
  SESSIONS_PER_YEAR,
  type SessionReturns,
} from './utils/realized-volatility';

const logger = LoggerFactory.getLogger('RealizedVolatilityRunner');

const SYMBOL = 'SOFI';
const RUN_FROM = '2025-01-01';
const RUN_TO = '2026-09-14';
/** Sessions in a trailing estimate: about a month, to sit beside a 30-day implied volatility. */
const WINDOW = 21;
/** The implied volatility's maturity, in calendar days: the clock each forecast is put on, and the stretch it is graded over. */
const IV_DAYS = 30;
/** The interval the intraday-plus-overnight estimator samples at. */
const RV_MINUTES = 5;

const DAYS_PER_YEAR = 365;

function mean(values: ReadonlyArray<number>): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: ReadonlyArray<number>): number {
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

function percent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;
}

interface Forecast {
  readonly name: string;
  /** Annual variance on the calendar clock, paired by position with what followed. */
  readonly predicted: number[];
  readonly realized: number[];
}

/** The average intraday variance each estimator reads, and how far one session's estimate strays from it. */
function reportIntraday(sessions: ReadonlyArray<SessionReturns>): void {
  // The same true intraday variance underneath every row, so the means should agree. One that
  // climbs as the interval shortens is measuring the bid-ask bounce, not the stock.
  logger.info('');
  logger.info(`Intraday variance, ${sessions.length} sessions: mean annualized, and how far a single session's estimate strays (lower is less noise)`);
  const row = (label: string, values: ReadonlyArray<number>): void => {
    logger.info(`  ${label.padEnd(22)} ${percent(annualizedVolatility(mean(values))).padStart(6)}   ${(standardDeviation(values) / mean(values)).toFixed(2)}`);
  };
  row(
    'open→close squared',
    sessions.map((s) => s.openToClose ** 2),
  );
  row(
    'Rogers-Satchell',
    sessions.map((s) => s.rogersSatchell),
  );
  for (const minutes of SAMPLING_MINUTES) {
    row(
      `${minutes}-minute returns`,
      sessions.map((s) => intradayVarianceAt(s, minutes)),
    );
  }
}

/** How the overnight gap and the session after it add up, and whether a weekend's gap is any bigger than a weeknight's. */
function reportOvernight(sessions: ReadonlyArray<SessionReturns>): void {
  const overnightVariance = mean(sessions.map((s) => s.overnight ** 2));
  const totalVariance = mean(sessions.map((s) => s.overnight ** 2 + intradayVarianceAt(s, RV_MINUTES)));
  logger.info('');
  logger.info(`Overnight is ${percent(overnightVariance / totalVariance)} of total variance.`);

  // (o + c)² = o² + c² + 2oc. Adding the pieces' variances, as the intraday estimator and
  // Yang-Zhang both do, drops the cross term, which is only zero on average if a gap is no more
  // likely to be faded than extended in the session after it.
  const closeToClose = mean(sessions.map((s) => s.closeToClose ** 2));
  const pieces = mean(sessions.map((s) => s.overnight ** 2 + s.openToClose ** 2));
  const cross = mean(sessions.map((s) => 2 * s.overnight * s.openToClose));
  const correlation = mean(sessions.map((s) => s.overnight * s.openToClose)) / Math.sqrt(overnightVariance * mean(sessions.map((s) => s.openToClose ** 2)));
  logger.info(
    `Close to close ${percent(annualizedVolatility(closeToClose))}, against ${percent(annualizedVolatility(pieces))} from overnight² + open→close²: the cross term 2·o·c is ${percent(cross / pieces)} of the pieces, from a correlation of ${correlation.toFixed(2)} between a gap and the session after it.`,
  );

  // If variance came from time rather than trading, a 3-day gap would carry three times a 1-day one.
  const weekday = sessions.filter((s) => s.gapDays === 1);
  const longer = sessions.filter((s) => s.gapDays > 1);
  if (weekday.length > 0 && longer.length > 0) {
    const weekdayGap = mean(weekday.map((s) => s.overnight ** 2));
    const longerGap = mean(longer.map((s) => s.overnight ** 2));
    logger.info(
      `Overnight gap, annualized as if each were one session: ${percent(annualizedVolatility(weekdayGap))} across ${weekday.length} weeknights, ${percent(annualizedVolatility(longerGap))} across ${longer.length} weekends and holidays, a variance ratio of ${(longerGap / weekdayGap).toFixed(2)}.`,
    );
  }
}

async function main(): Promise<void> {
  const loader = new HistoricalRealizedVolatilityLoader({
    symbol: SYMBOL,
    client: marketDataClient(),
    fromDate: RUN_FROM,
    toDate: RUN_TO,
    window: WINDOW,
    intradayMinutes: RV_MINUTES,
  });
  await loader.load();
  const sessions = loader.getSessions();

  const forecasts: ReadonlyArray<Forecast> = [
    { name: 'close to close', predicted: [], realized: [] },
    { name: `${RV_MINUTES}-min + overnight`, predicted: [], realized: [] },
    { name: 'Yang-Zhang', predicted: [], realized: [] },
  ];

  logger.info(
    `date        overnight  open→close  today ${RV_MINUTES}m | trailing ${WINDOW}, ×${SESSIONS_PER_YEAR}: close→close  ${RV_MINUTES}m+overnight (overnight share)  Yang-Zhang | ${RV_MINUTES}m+overnight on the ${IV_DAYS}-day calendar clock | next ${IV_DAYS} days: close→close`,
  );
  for (const point of loader.getPoints()) {
    const { session, trailing } = point;
    const ahead = sessionsWithin(point.date, IV_DAYS);
    const after = realizedAfter(sessions, point.date, IV_DAYS);
    if (after !== undefined) {
      [trailing.closeToClose, trailing.intradayPlusOvernight, trailing.yangZhang].forEach((variance, index) => {
        forecasts[index].predicted.push((variance * ahead * DAYS_PER_YEAR) / IV_DAYS);
        forecasts[index].realized.push(after.volatility ** 2);
      });
    }

    logger.info(
      [
        point.date,
        `  ${signed(session.overnight).padStart(7)}`,
        `   ${signed(session.openToClose).padStart(7)}`,
        `   ${percent(annualizedVolatility(intradayVarianceAt(session, RV_MINUTES))).padStart(6)}`,
        ` |   ${percent(annualizedVolatility(trailing.closeToClose)).padStart(6)}`,
        `   ${percent(annualizedVolatility(trailing.intradayPlusOvernight)).padStart(6)} (${percent(trailing.overnightShare, 0)})`,
        `   ${percent(annualizedVolatility(trailing.yangZhang)).padStart(6)}`,
        ` |   ${percent(calendarClockVolatility(trailing.intradayPlusOvernight, point.date, IV_DAYS)).padStart(6)} over ${ahead} sessions`,
        ` |   ${after === undefined ? '-' : percent(after.volatility)}`,
      ].join(''),
    );
  }

  const inRun = loader.getPoints().map((point) => point.session);
  reportIntraday(inRun);
  reportOvernight(inRun);

  // The next month's close-to-close is noisy, but its noise is independent of every trailing
  // estimate, so it adds the same amount to each one's error and leaves their ranking alone.
  // The averages are taken over variance and only then square-rooted: the square root of a noisy
  // variance is low on average, so averaging volatilities would flatter whichever estimator is
  // as noisy as the target.
  logger.info('');
  logger.info(
    `As a forecast of the next ${IV_DAYS} days' close-to-close, on the calendar clock: the average forecast against the average of what followed, and the root-mean-square miss in volatility points`,
  );
  for (const forecast of forecasts) {
    if (forecast.predicted.length === 0) {
      continue;
    }
    const misses = forecast.predicted.map((variance, index) => Math.sqrt(variance) - Math.sqrt(forecast.realized[index]));
    const rmse = Math.sqrt(mean(misses.map((miss) => miss * miss)));
    logger.info(
      `  ${forecast.name.padEnd(22)} ${percent(Math.sqrt(mean(forecast.predicted))).padStart(6)} against ${percent(Math.sqrt(mean(forecast.realized)))}   rmse ${percent(rmse).padStart(6)}   over ${forecast.predicted.length} sessions`,
    );
  }
}

main().catch((error: unknown) => {
  logger.error(`${String(error)}`);
  process.exitCode = 1;
});
