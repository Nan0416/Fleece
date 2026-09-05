import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Guideline: never cast with `as` — use the assertion helpers in @fleece/shared.
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      // Guideline: always brace `if` bodies.
      curly: ['error', 'all'],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
  {
    // The logger and assertion helpers are the sanctioned boundary where casting is unavoidable.
    files: ['packages/shared/src/utils/assertions.ts', 'packages/shared/src/utils/logger.ts'],
    rules: { '@typescript-eslint/consistent-type-assertions': 'off' },
  },
  {
    // Every API method takes one Request and returns one Response, and every DAO
    // method one Input and one Output, even when the payload is empty. `{}` is the
    // point: it names the contract and gives the shape somewhere to grow, so an
    // endpoint or query gaining a field is not a breaking signature change for every
    // caller.
    files: ['packages/shared/src/api/*.ts', 'packages/core/src/data/*-dao.ts', 'packages/core/src/services/*.ts', 'packages/alpaca/src/alpaca-rest-client.ts', 'packages/broker/src/l1/*.ts'],
    rules: { '@typescript-eslint/no-empty-object-type': 'off' },
  },
  {
    // Tests are held to the same rules as `src` with two exceptions, both of which
    // exist because a test's job is to stand in for something.
    //
    // Casting: a fake DAO or a hand-built `req`/`res` deliberately implements only
    // the slice of an interface its subject touches, and the point of the double is
    // that the compiler cannot know that. The production rule exists so that data
    // crossing a trust boundary is asserted rather than assumed — a fixture the test
    // itself wrote is not that.
    //
    // `require`: `stage-config.ts` resolves its configuration in a module-level
    // initialiser, so the only way to test it under a different environment is
    // `jest.isolateModules` plus a re-require. A static import would resolve once.
    files: ['packages/*/tests/**/*.ts'],
    languageOptions: { globals: globals.jest },
    rules: {
      '@typescript-eslint/consistent-type-assertions': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
