/**
 * `tapedeck report` — turn a stored run into metrics and an HTML page.
 *
 * Separate from `run` because they answer different questions. `run` asks "what happens if I
 * replay this"; `report` asks "what did that run mean", and a result you saved six months ago
 * deserves the same answer as one you produced a second ago — including when the metric
 * definitions have improved since.
 */

import { resolve } from 'node:path';
import { z } from 'zod';
import { ConfigError, parseRunResult } from '@tapedeck/core';
import {
  type MetricsOptions,
  computeMetrics,
  formatMetrics,
  metricsToJsonString,
  renderHtmlReport,
} from '@tapedeck/report';
import type { CliIo } from '../io.ts';

const OptionsSchema = z.object({
  html: z.string().optional(),
  json: z.string().optional(),
  riskFreeRate: z.coerce.number().optional(),
  periodsPerYear: z.coerce.number().positive().optional(),
  currency: z.string().optional(),
  quiet: z.boolean().optional(),
});

export type ReportCommandOptions = z.infer<typeof OptionsSchema>;

export function reportCommand(resultPath: string, rawOptions: unknown, io: CliIo): void {
  const parsed = OptionsSchema.safeParse(rawOptions);
  if (!parsed.success) {
    throw new ConfigError('invalid options for `report`', { issues: parsed.error.issues });
  }
  const options = parsed.data;

  const text = Buffer.from(io.readFile(resolve(resultPath))).toString('utf8');
  let result;
  try {
    result = parseRunResult(text);
  } catch (cause: unknown) {
    throw new ConfigError(`${resultPath} is not a Tapedeck run result`, {
      path: resultPath,
      cause: String(cause),
    });
  }

  const metricsOptions: MetricsOptions = {
    riskFreeRate: options.riskFreeRate,
    periodsPerYear: options.periodsPerYear,
  };
  const metrics = computeMetrics(result, metricsOptions);
  const currency = options.currency ?? '';

  if (options.quiet !== true) {
    io.log(`${result.config.strategyId} — ${result.config.instruments.join(', ')}\n`);
    io.log(formatMetrics(metrics, currency));
  }

  if (options.json !== undefined) {
    io.writeFile(resolve(options.json), metricsToJsonString(metrics));
    if (options.quiet !== true) io.log(`\nmetrics ${options.json}`);
  }
  if (options.html !== undefined) {
    io.writeFile(resolve(options.html), renderHtmlReport(result, metrics, { currency }));
    if (options.quiet !== true) io.log(`report  ${options.html}`);
  }
}
