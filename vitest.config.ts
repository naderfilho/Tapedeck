import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run straight off TypeScript sources: no build step, no stale dist.
    alias: {
      '@tapedeck/core': src('./packages/core/src/index.ts'),
      '@tapedeck/indicators': src('./packages/indicators/src/index.ts'),
      '@tapedeck/data': src('./packages/data/src/index.ts'),
      '@tapedeck/store': src('./packages/store/src/index.ts'),
    },
  },
  test: {
    include: ['{packages,examples}/*/test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        '**/index.ts',
        '**/*.d.ts',
        // Declaration-only modules: they contain interfaces and type aliases and emit no
        // executable statements, so a coverage percentage for them is not a measurement of
        // anything. Every consumer of these contracts is covered by the tests that use them.
        'packages/core/src/data.ts',
        'packages/core/src/strategy.ts',
        'packages/core/src/util/brand.ts',
      ],
      // Every published package carries the same floor. A package that cannot meet it is a
      // package whose behaviour nobody has pinned down.
      thresholds: {
        'packages/core/src/**': { statements: 85, branches: 85, functions: 85, lines: 85 },
        'packages/indicators/src/**': { statements: 85, branches: 85, functions: 85, lines: 85 },
        'packages/data/src/**': { statements: 85, branches: 85, functions: 85, lines: 85 },
        'packages/store/src/**': { statements: 85, branches: 85, functions: 85, lines: 85 },
      },
    },
  },
});
