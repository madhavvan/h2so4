import { defineConfig } from 'vitest/config';

// Scope discovery to test/ — vitest's default **/*.test.* glob also swallowed
// scripts/.autotype-test/coverage.test.cjs, a standalone node checker that
// calls process.exit and fails the whole run as a collection error. That
// script is invoked directly via node; it is not a vitest suite.
export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
  },
});
