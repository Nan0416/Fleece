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
  testPathIgnorePatterns: ['/node_modules/'],
  setupFiles: ['<rootDir>/jest.setup.js'],
  moduleNameMapper: {
    '^@fleece/shared$': '<rootDir>/packages/shared/src',
    '^@fleece/core$': '<rootDir>/packages/core/src',
    '^@fleece/client$': '<rootDir>/packages/client/src',
    '^@fleece/alpaca$': '<rootDir>/packages/alpaca/src',
    '^@fleece/broker$': '<rootDir>/packages/broker/src',
    '^@fleece/marketdata$': '<rootDir>/packages/marketdata/src',
    '^@fleece/tracking-service$': '<rootDir>/packages/tracking-service/src',
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
