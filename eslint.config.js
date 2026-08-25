// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Two rules here are not style preferences but the enforcement of ADR-0006: the core may not read
 * the wall clock and may not draw randomness that is not seeded. Everything else is ordinary
 * strictness.
 */
const DETERMINISM_RULES = [
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: 'The core must be deterministic: inject a Clock instead of reading Date.now().',
  },
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: 'The core must be deterministic: inject a Clock instead of constructing new Date().',
  },
  {
    selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
    message: 'The core must be deterministic: inject an Rng (see util/rng.ts).',
  },
  {
    selector: "CallExpression[callee.object.name='performance'][callee.property.name='now']",
    message: 'Timing belongs in bench/, not in the engine.',
  },
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', 'site/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Non-negotiable for this repository. See docs/adr/0002 and docs/adr/0006.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  {
    // The determinism rules apply to the kernel and nowhere else. Adapters read the wall clock
    // because that is their job; the engine must not, because that is the guarantee.
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...DETERMINISM_RULES],
    },
  },
  {
    // Config files and any plain JavaScript are linted without type information.
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  {
    // Tests and benchmarks may read the wall clock and reach for looser typing.
    files: ['**/test/**/*.ts', 'bench/**/*.ts', 'examples/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-unary-minus': 'off',
    },
  },
  prettier,
);
