/**
 * The coverage gate, and the only config carrying thresholds.
 *
 * **It measures the unit suites alone**, deliberately. `data-integration/` needs a real
 * PostgreSQL and skips itself without one, so a number taken from the base config means
 * one thing on a machine with a database and something 15 points lower on a machine
 * without — and a threshold calibrated against either fails on the other. Pinning the
 * test set here is what makes the gate answer a question about the change rather than a
 * question about the environment: the same number on a laptop, in CI, and in whatever
 * CI comes next.
 *
 * `data-integration/` is not thereby unguarded. Those suites still run under `npm test`
 * and `npm run test:ci`, and `scripts/assert-suites-ran.js` turns a silent skip red. It
 * is coverage that stops depending on them, not correctness.
 *
 * What that costs, and where it lands: the Postgres DAOs under
 * `packages/service/src/core/data/` are exercised almost entirely by those suites, so
 * this run sees very little of them. They get a group of their own below rather than
 * being excluded — the report should say what is unmeasured, not hide it — and a floor
 * that stops them sliding further while keeping their low number from diluting the code
 * this gate can genuinely hold.
 */
const base = require('./jest.config.js');

module.exports = {
  ...base,
  // The one difference that matters. `live/` was already out; this adds the suites that
  // need a database, so the set is the same everywhere regardless of what is installed.
  //
  // `/data-integration/` rather than `/tests/data-integration/`: the directory sits
  // wherever in the mirror the code it tests sits, so the real paths are
  // `tests/core/data-integration/` and `tests/tracking/data-integration/`.
  testPathIgnorePatterns: [...base.testPathIgnorePatterns, '/data-integration/'],

  /**
   * A ratchet, not a target.
   *
   * Each number sits just under what the suite reaches, so ordinary work does not trip
   * it and a genuine fall does. Raise one when the real figure moves up; never lower one
   * to make a red build green — that is the signal doing its job.
   *
   * Per-package rather than one global floor, because a single number over the whole
   * repo is dominated by whichever package has the most statements: a real fall in
   * `utilities` disappears under `service` being large. Each group is held to what that
   * package can actually reach.
   */
  coverageThreshold: {
    // Pure: no database, no network, no clock they do not own, and no excuse.
    './packages/utilities/src/': { statements: 95, branches: 91, functions: 97, lines: 95 },
    './packages/models/src/': { statements: 97, branches: 96, functions: 97, lines: 97 },
    './packages/marketdata/src/': { statements: 95, branches: 84, functions: 96, lines: 95 },
    './packages/broker/src/': { statements: 88, branches: 77, functions: 89, lines: 88 },
    './packages/client/src/': { statements: 88, branches: 68, functions: 88, lines: 89 },

    // The Postgres layer, covered by `tests/**/data-integration/` which this run
    // excludes. The floor is what the unit suites happen to reach through it and is not
    // evidence of anything; the suites that do test it are the evidence. Kept as its own
    // group so it neither dilutes the rest nor silently disappears from the report.
    './packages/service/src/core/data/': { statements: 17, branches: 11, functions: 9, lines: 17 },

    // The rest of `service`: the services, the HTTP plumbing, the routes, and the
    // tracking and corporate-action processes. Lower than the packages above because
    // each process's server, runtime and config object reads the environment and builds
    // an object graph — the same shape as a `main.ts`, and untestable for the same
    // reason, but part of a directory that is otherwise ordinary code.
    global: { statements: 71, branches: 61, functions: 73, lines: 71 },
  },
};
