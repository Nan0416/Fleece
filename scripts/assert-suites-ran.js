#!/usr/bin/env node
/**
 * Fails when a test suite skipped itself.
 *
 * The integration suites skip when `FLEECE_TEST_DATABASE_URL` is unset — which is right
 * on a laptop with no PostgreSQL, and a silent lie in CI. Jest reports that state as
 * `success: true` with a non-zero `numPendingTestSuites`, so a run that tested none of
 * the locking, idempotency or client round-trip behaviour is indistinguishable from a
 * green one unless something looks.
 *
 * This is that something. It reads the JSON jest already writes, so it costs no second
 * test run.
 */
const { readFileSync } = require('node:fs');

const resultsPath = process.argv[2];
if (resultsPath === undefined) {
  console.error('usage: assert-suites-ran.js <jest-results.json>');
  process.exit(2);
}

const results = JSON.parse(readFileSync(resultsPath, 'utf-8'));

// A suite that failed is already red on jest's own exit code, and a suite that failed
// to compile also reports zero assertions — so failures are excluded here rather than
// reported twice under the wrong heading.
const skipped = results.testResults.filter((suite) => suite.status !== 'failed' && (suite.assertionResults.length === 0 || suite.assertionResults.every((test) => test.status === 'pending')));

if (skipped.length > 0) {
  console.error(`${skipped.length} test suite(s) ran nothing:`);
  for (const suite of skipped) {
    console.error(`  ${suite.name}`);
  }
  console.error('\nThe integration suites skip themselves when FLEECE_TEST_DATABASE_URL is unset.');
  console.error('They are the ones covering the position lock, fill idempotency and the client round trip,');
  console.error('so a run without them is green for a reason that has nothing to do with the code.');
  process.exit(1);
}

console.log(`${results.numTotalTests} tests across ${results.numTotalTestSuites} suites; none skipped.`);
