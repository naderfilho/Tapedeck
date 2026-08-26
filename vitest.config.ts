import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run straight off TypeScript sources: no build step, no stale dist.
    alias: {
      '@tapedeck/core': src('./packages/core/src/index.ts'),
      '@tapedeck/indicators': src('./packages/indicators/src/index.ts'),
      // Before the barrel below: aliases match by prefix, so the longer key has to come first or
      // '@tapedeck/data/codec' resolves through it and lands on a path that does not exist.
      '@tapedeck/data/codec': src('./packages/data/src/tape-format.ts'),
      '@tapedeck/data': src('./packages/data/src/index.ts'),
      '@tapedeck/store': src('./packages/store/src/index.ts'),
      '@tapedeck/report': src('./packages/report/src/index.ts'),
      '@tapedeck/cli': src('./packages/cli/src/index.ts'),
    },
  },
  test: {
    include: ['{packages,examples}/*/test/**/*.test.ts', 'demo/test/**/*.test.ts'],
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
        // A three-line entry point that wires real dependencies to real streams. Everything it
        // could get wrong lives in runProgram, which is covered.
        'packages/cli/src/cli.ts',
      ],
      // Every published package carries the same floor. A package that cannot meet it is a
      // package whose behaviour nobody has pinned down.
      //
      // Branches sit lower on purpose. `noUncheckedIndexedAccess` is on, so every read from a
      // typed-array column has to be written `column[i] ?? 0`, and the fallback half of that
      // branch cannot fire: the index is bounded by the loop that produced it. Chasing those to
      // 85% would mean writing tests for states the code cannot reach.
      thresholds: {
        'packages/core/src/**': { statements: 85, branches: 75, functions: 85, lines: 85 },
        'packages/indicators/src/**': { statements: 85, branches: 75, functions: 85, lines: 85 },
        'packages/data/src/**': { statements: 85, branches: 75, functions: 85, lines: 85 },
        'packages/store/src/**': { statements: 85, branches: 75, functions: 85, lines: 85 },
        'packages/report/src/**': { statements: 85, branches: 75, functions: 85, lines: 85 },
        'packages/cli/src/**': { statements: 85, branches: 75, functions: 85, lines: 85 },
      },
    },
  },
});
