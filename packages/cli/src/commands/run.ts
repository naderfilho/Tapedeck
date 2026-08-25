/**
 * `tapedeck run` — replay a strategy over a tape and report what happened.
 *
 * The strategy is a module you point at, not a name in a registry: a strategy is code, and
 * pretending otherwise means inventing a plugin system nobody asked for. The module exports a
 * factory as `default` or as `strategy`, which is exactly what `Engine` already expects.
 *
 * Everything the run needed in order to be reproducible — the seed, the execution preset, the
 * parameters, the data range — is printed with the results and stored in the result file, so a
 * number can always be traced back to the configuration that produced it (ADR-0006).
 */

import { resolve } from 'node:path';
import { z } from 'zod';
import {
  type RunOptions,
  type Store,
  type StrategyFactory,
  Engine,
  PRESETS,
  ConfigError,
  serializeRunResult,
} from '@tapedeck/core';
import { decodeBarTape } from '@tapedeck/data';
import {
  computeMetrics,
  formatMetrics,
  metricsToJsonString,
  renderHtmlReport,
} from '@tapedeck/report';
import type { CliIo } from '../io.ts';

const PRESET_NAMES = ['ideal', 'binanceSpot', 'b3Futures', 'b3Stocks'] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

const OptionsSchema = z.object({
  data: z.string().min(1),
  cash: z.string().min(1),
  seed: z.coerce.number().int(),
  preset: z.enum(PRESET_NAMES),
  params: z.string().optional(),
  intrabar: z.enum(['pessimistic', 'optimistic', 'ohlc-path']).optional(),
  json: z.string().optional(),
  result: z.string().optional(),
  html: z.string().optional(),
  store: z.string().optional(),
  runId: z.string().optional(),
  quiet: z.boolean().optional(),
});

export type RunCommandOptions = z.infer<typeof OptionsSchema>;

export interface RunDependencies {
  readonly io: CliIo;
  /** Opens a store when `--store` is given. Injected so the CLI does not import sqlite eagerly. */
  readonly openStore?: ((path: string) => Store) | undefined;
}

/** Pulls the factory out of a user module, with an error that says what was expected. */
export function resolveStrategyFactory(
  module: Record<string, unknown>,
  path: string,
): StrategyFactory {
  const candidate = module['default'] ?? module['strategy'];
  if (typeof candidate !== 'function') {
    throw new ConfigError(
      `${path} must export a strategy factory as its default export or as \`strategy\``,
      { path, exports: Object.keys(module) },
    );
  }
  return candidate as StrategyFactory;
}

export function parseParams(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause: unknown) {
    throw new ConfigError('--params must be a JSON object', { raw, cause: String(cause) });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError('--params must be a JSON object', { raw });
  }
  return parsed as Record<string, unknown>;
}

export async function runCommand(
  strategyPath: string,
  rawOptions: unknown,
  deps: RunDependencies,
): Promise<void> {
  const parsed = OptionsSchema.safeParse(rawOptions);
  if (!parsed.success) {
    throw new ConfigError('invalid options for `run`', { issues: parsed.error.issues });
  }
  const options = parsed.data;
  const { io } = deps;

  const absoluteStrategy = resolve(strategyPath);
  const module = await io.importModule(absoluteStrategy);
  const strategy = resolveStrategyFactory(module, strategyPath);

  const tape = decodeBarTape(io.readFile(resolve(options.data)));
  const execution = PRESETS[options.preset]();

  const engineOptions: RunOptions<Record<string, never>> = {
    instruments: [tape.instrument],
    strategy,
    params: parseParams(options.params) as Record<string, never>,
    initialCash: options.cash,
    seed: options.seed,
    execution:
      options.intrabar === undefined ? execution : { ...execution, intrabar: options.intrabar },
    flattenAtEnd: true,
  };

  const engine = new Engine(engineOptions);
  engine.feedBars(tape.chunk);
  const result = engine.finish();
  const metrics = computeMetrics(result);

  if (options.quiet !== true) {
    io.log(`${result.config.strategyId} — ${tape.header.source}\n`);
    io.log(formatMetrics(metrics, tape.instrument.currency));
  }

  if (options.result !== undefined) {
    io.writeFile(resolve(options.result), serializeRunResult(result));
    if (options.quiet !== true) io.log(`\nresult  ${options.result}`);
  }
  if (options.json !== undefined) {
    io.writeFile(resolve(options.json), metricsToJsonString(metrics));
    if (options.quiet !== true) io.log(`metrics ${options.json}`);
  }
  if (options.html !== undefined) {
    io.writeFile(
      resolve(options.html),
      renderHtmlReport(result, metrics, { currency: tape.instrument.currency }),
    );
    if (options.quiet !== true) io.log(`report  ${options.html}`);
  }

  if (options.store !== undefined) {
    if (deps.openStore === undefined) {
      throw new ConfigError('this build cannot open a store');
    }
    const store = deps.openStore(resolve(options.store));
    try {
      const id = options.runId ?? `${result.config.strategyId}-${String(options.seed)}`;
      await store.runs.save(id, result);
      if (options.quiet !== true) io.log(`stored  ${id}`);
    } finally {
      store.close();
    }
  }
}
