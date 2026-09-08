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
  // `tests/live/` talks to a real provider over the network and needs a key; it runs
  // from `jest.live.config.js` via `npm run test:live`.
  testPathIgnorePatterns: ['/node_modules/', '/tests/live/'],
  setupFiles: ['<rootDir>/jest.setup.js'],
  moduleNameMapper: {
    '^@fleece/utilities$': '<rootDir>/packages/utilities/src',
    '^@fleece/models$': '<rootDir>/packages/models/src',
    '^@fleece/client$': '<rootDir>/packages/client/src',
    '^@fleece/broker$': '<rootDir>/packages/broker/src',
    '^@fleece/marketdata$': '<rootDir>/packages/marketdata/src',
    '^@fleece/service$': '<rootDir>/packages/service/src',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          target: 'es2022',
          resolveJsonModule: true,
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
