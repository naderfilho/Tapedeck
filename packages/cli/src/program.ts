/**
 * The command tree.
 *
 * Built as a function rather than a module-level singleton so a test can construct one with its
 * own IO and its own fake provider, hand it an argv, and assert on what came out. Commander is
 * configured to throw rather than call `process.exit`, which is what makes that possible.
 */

import { Command } from 'commander';
import { TapedeckError } from '@tapedeck/core';
import { openStore } from '@tapedeck/store';
import type { CliIo } from './io.ts';
import { type DataDependencies, convertCommand, fetchCommand } from './commands/data.ts';
import { reportCommand } from './commands/report.ts';
import { type RunDependencies, runCommand } from './commands/run.ts';

export const VERSION = '0.1.0';

export interface ProgramDependencies extends RunDependencies, DataDependencies {
  readonly io: CliIo;
}

export function createProgram(deps: ProgramDependencies): Command {
  const program = new Command();

  program
    .name('tapedeck')
    .description('Deterministic backtesting and paper trading for TypeScript')
    .version(VERSION)
    .configureOutput({
      writeOut: (text) => {
        deps.io.log(text.replace(/\n$/, ''));
      },
      writeErr: (text) => {
        deps.io.error(text.replace(/\n$/, ''));
      },
    })
    .exitOverride();

  program
    .command('run')
    .description('replay a strategy over a tape')
    .argument('<strategy>', 'module exporting a strategy factory as default or as `strategy`')
    .requiredOption('-d, --data <file>', 'a .tape file to replay')
    .option('-c, --cash <amount>', 'starting balance, as a decimal string', '100000')
    .option('-s, --seed <number>', 'seed for every random stream in the run', '1')
    .option('-p, --preset <name>', 'ideal | binanceSpot | b3Futures | b3Stocks', 'ideal')
    .option('--params <json>', 'strategy parameters as a JSON object')
    .option('--intrabar <policy>', 'pessimistic | optimistic | ohlc-path')
    .option('--result <file>', 'write the full run result as JSON')
    .option('--json <file>', 'write the metrics as JSON')
    .option('--html <file>', 'write the HTML report')
    .option('--store <file>', 'also save the run to a SQLite store')
    .option('--run-id <id>', 'identifier to store the run under')
    .option('-q, --quiet', 'write files but print nothing')
    .action(async (strategy: string, options: unknown) => {
      await runCommand(strategy, options, deps);
    });

  program
    .command('report')
    .description('render metrics and an HTML report from a stored run result')
    .argument('<result>', 'a JSON file written by `run --result`')
    .option('--html <file>', 'write the HTML report')
    .option('--json <file>', 'write the metrics as JSON')
    .option('--risk-free-rate <rate>', 'annual risk-free rate as a decimal, e.g. 0.05')
    .option('--periods-per-year <n>', 'override the inferred bars per year')
    .option('--currency <code>', 'currency label for the numbers')
    .option('-q, --quiet', 'write files but print nothing')
    .action((result: string, options: unknown) => {
      reportCommand(result, options, deps.io);
    });

  const data = program.command('data').description('fetch and convert market data');

  data
    .command('fetch')
    .description('download public candles into a .tape file')
    .requiredOption('--symbol <symbol>', 'venue symbol, e.g. BTCUSDT')
    .requiredOption('--timeframe <tf>', 'bar size, e.g. 1m, 15m, 1h, 1d')
    .requiredOption('--from <iso>', 'inclusive start, ISO-8601')
    .requiredOption('--to <iso>', 'exclusive end, ISO-8601')
    .requiredOption('-o, --out <file>', 'destination .tape file')
    .option('--venue <name>', 'currently only binance', 'binance')
    .option('--store <file>', 'also cache the range in a SQLite store')
    .option('-q, --quiet', 'write files but print nothing')
    .action(async (options: unknown) => {
      await fetchCommand(options, deps);
    });

  data
    .command('convert')
    .description('turn a CSV export into a .tape file')
    .argument('<csv>', 'the CSV file to read')
    .requiredOption('-i, --instrument <file>', 'JSON instrument specification')
    .requiredOption('--timeframe <tf>', 'bar size, e.g. 1m, 15m, 1h, 1d')
    .requiredOption('-o, --out <file>', 'destination .tape file')
    .option('--timestamp-unit <unit>', 'iso | ms | s | us', 'ms')
    .option('--timestamp-is <which>', 'whether the timestamp marks the open or the close', 'open')
    .option('--delimiter <char>', 'field separator', ',')
    .option('-q, --quiet', 'write files but print nothing')
    .action(async (csv: string, options: unknown) => {
      await convertCommand(csv, options, deps);
    });

  return program;
}

/** The dependency set used by the real binary. */
export function nodeDependencies(io: CliIo): ProgramDependencies {
  return { io, openStore: (path) => openStore(path) };
}

const COMMANDER_SUCCESSES = new Set([
  'commander.helpDisplayed',
  'commander.help',
  'commander.version',
]);

/**
 * Runs one command line and returns the process exit code.
 *
 * A Tapedeck error is a message for a person: it prints its own text and its details, and exits 1.
 * Anything else is a bug and keeps its stack, because a stack is what a bug report needs.
 * Commander signals `--help` and `--version` by throwing as well, and those are successes.
 */
export async function runProgram(
  argv: readonly string[],
  deps: ProgramDependencies,
): Promise<number> {
  const program = createProgram(deps);
  try {
    await program.parseAsync([...argv], { from: 'user' });
    return 0;
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code: unknown = (error as Record<'code', unknown>).code;
      if (typeof code === 'string' && COMMANDER_SUCCESSES.has(code)) return 0;
    }
    if (error instanceof TapedeckError) {
      deps.io.error(`error: ${error.message}`);
      const details = JSON.stringify(error.details);
      if (details !== '{}') deps.io.error(`  ${details}`);
      return 1;
    }
    throw error;
  }
}
