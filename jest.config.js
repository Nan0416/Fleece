/**
 * Root jest config — runs unit tests across every workspace package.
 *
 * Tests live in `packages/<pkg>/tests/`, mirroring that package's `src/` directory:
 * `src/data/pg-account-dao.ts` is tested by `tests/data/pg-account-dao.test.ts`. The
 * mirror is the index — finding the tests for a file never involves a search, and a
 * directory with no counterpart under `tests/` is visibly untested.
 *
 * `tests/data-integration/` is the one deliberate exception: it holds suites that
 * need a real PostgreSQL and skip themselves without one, kept apart so a directory
 * listing says which tests always run.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/packages'],
  testMatch: ['**/tests/**/*.test.ts'],
  /**
   * `@fleece/broker` is left out for the same reason it is left out of `npm run build`:
   * it does not compile against the ledger redesign, and must not be ported by
   * translating its arithmetic — its option reservations are wrong by a factor of 100,
   * so converting them first would produce a package that looks correct while still
   * being wrong. See `md/OPEN-ITEMS.md` items 0 and 2b.
   *
   * Excluding it keeps `npm test` a signal rather than a known-red run people stop
   * reading. CI still runs it, in a job allowed to fail, so the gap stays visible.
   */
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/packages/broker/'],
  setupFiles: ['<rootDir>/jest.setup.js'],
  moduleNameMapper: {
    '^@fleece/shared$': '<rootDir>/packages/shared/src',
    '^@fleece/core$': '<rootDir>/packages/core/src',
    '^@fleece/client$': '<rootDir>/packages/client/src',
    '^@fleece/alpaca$': '<rootDir>/packages/alpaca/src',
    '^@fleece/broker$': '<rootDir>/packages/broker/src',
    '^@fleece/marketdata$': '<rootDir>/packages/marketdata/src',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          target: 'es2022',
          lib: ['es2022'],
          esModuleInterop: true,
          strict: true,
        },
      },
    ],
  },
  collectCoverageFrom: [
    'packages/*/src/**/*.ts',
    // Barrels are re-exports with no behaviour of their own; counting them inflates
    // the number without anything being tested.
    '!packages/*/src/**/index.ts',
  ],
};
