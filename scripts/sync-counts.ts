/**
 * Rewrites the test and coverage figures in the documentation from the run that produced them.
 *
 * ```sh
 * corepack pnpm coverage        # writes the artefacts this reads
 * corepack pnpm counts          # rewrites README.md and CLAUDE.md
 * corepack pnpm counts:check    # fails if either is stale; CI runs this
 * ```
 *
 * The README claimed 685 tests in its badge and 610 in its testing section, and 96% coverage in one
 * place and 97% in another. Small, and the same drift the project complains about elsewhere: the
 * site's figures already come from `out/metrics.json` rather than from a paragraph, and there was no
 * reason the repository's own numbers should be typed by hand.
 *
 * The inputs are the artefacts `pnpm coverage` leaves behind, so a figure can only move when a run
 * moved it.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const at = (path: string): string => fileURLToPath(new URL(`../${path}`, import.meta.url));

interface CoverageSummary {
  readonly total: {
    readonly statements: { readonly pct: number };
    readonly functions: { readonly pct: number };
  };
}

interface TestResults {
  readonly numTotalTests: number;
  readonly numFailedTests: number;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} is missing or unreadable. Run \`corepack pnpm coverage\` first.`);
  }
}

const coverage = readJson(at('coverage/coverage-summary.json')) as CoverageSummary;
const tests = readJson(at('coverage/test-results.json')) as TestResults;

if (tests.numFailedTests > 0) {
  throw new Error(
    `the last run had ${String(tests.numFailedTests)} failing test(s); fix those first`,
  );
}

const adrs = readdirSync(at('docs/adr')).filter((name) => /^\d{4}-.*\.md$/.test(name)).length;

/** Truncated, never rounded up: a badge should not claim a percentage point nobody measured. */
const statements = Math.floor(coverage.total.statements.pct);
const functions = Math.floor(coverage.total.functions.pct);
const total = tests.numTotalTests;

interface Rule {
  readonly find: RegExp;
  readonly to: string;
}

/** Every place a figure appears, and what it should say now. */
const FILES: readonly { readonly file: string; readonly rules: readonly Rule[] }[] = [
  {
    file: 'README.md',
    rules: [
      { find: /badge\/tests-\d+-/, to: `badge/tests-${String(total)}-` },
      { find: /badge\/coverage-\d+%25-/, to: `badge/coverage-${String(statements)}%25-` },
      {
        find: /\d+ tests, \d+% statement coverage/,
        to: `${String(total)} tests, ${String(statements)}% statement coverage`,
      },
      { find: /pnpm test {10}# \d+ tests/, to: `pnpm test          # ${String(total)} tests` },
      {
        find: /pnpm coverage {6}# \d+% statements, \d+% functions/,
        to: `pnpm coverage      # ${String(statements)}% statements, ${String(functions)}% functions`,
      },
      { find: /\[\d+ ADRs\]\(docs\/adr\/\)/, to: `[${String(adrs)} ADRs](docs/adr/)` },
    ],
  },
  {
    file: 'CLAUDE.md',
    rules: [
      {
        find: /\d+ tests, \d+% statement coverage/,
        to: `${String(total)} tests, ${String(statements)}% statement coverage`,
      },
      { find: /`docs\/adr\/` — \d+ of them/, to: `\`docs/adr/\` — ${String(adrs)} of them` },
    ],
  },
];

const check = process.argv.includes('--check');
const stale: string[] = [];

for (const { file, rules } of FILES) {
  const path = at(file);
  const before = readFileSync(path, 'utf8');
  let after = before;
  for (const rule of rules) {
    if (!rule.find.test(after)) {
      throw new Error(
        `${file} no longer contains ${String(rule.find)}; update scripts/sync-counts.ts`,
      );
    }
    after = after.replace(rule.find, rule.to);
  }
  if (after === before) continue;
  if (check) stale.push(file);
  else writeFileSync(path, after, 'utf8');
}

const figures =
  `${String(total)} tests, ${String(statements)}% statements, ` +
  `${String(functions)}% functions, ${String(adrs)} ADRs`;

if (check && stale.length > 0) {
  console.error(`stale figures in ${stale.join(', ')}: the run says ${figures}.`);
  console.error('Run `corepack pnpm counts` and commit the result.');
  process.exit(1);
}

console.log(check ? `up to date: ${figures}` : `written: ${figures}`);
