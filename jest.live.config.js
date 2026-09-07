/**
 * The suites that talk to a real data provider over the network.
 *
 * Kept out of `npm test` rather than skipped inside it: CI has no provider key, and a
 * suite that skips itself there would make the run green having tested nothing —
 * which is the failure `scripts/assert-suites-ran.js` exists to catch.
 *
 * Run with `npm run test:live`, having put the key in `.env`.
 */
const base = require('./jest.config.js');

module.exports = {
  ...base,
  testPathIgnorePatterns: ['/node_modules/'],
  testMatch: ['**/tests/live/**/*.test.ts'],
  setupFiles: [...base.setupFiles, '<rootDir>/jest.live.setup.js'],
  // One provider, one rate limit: parallel workers would race each other for it.
  maxWorkers: 1,
};
