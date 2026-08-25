/**
 * Runs the crossover end to end on real data, prints the metrics and writes the report.
 *
 * Node 24 strips the types, so this file runs directly:
 *
 * ```sh
 * node examples/sma-crossover/src/main.ts
 * ```
 *
 * The data is the committed BTCUSDT fixture: a year of hourly candles from Binance, fetched by
 * `pnpm fixtures` through the same provider a user would call. The same run is available from the
 * command line — see the README — and produces the same bytes, because it is the same code.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Engine, PRESETS, parseFixed } from '@tapedeck/core';
import { readBarTapeFileSync } from '@tapedeck/data';
import {
  computeMetrics,
  formatMetrics,
  metricsToJsonString,
  renderHtmlReport,
} from '@tapedeck/report';
import { type SmaCrossoverParams, smaCrossover } from './strategy.ts';

const TAPE = fileURLToPath(new URL('../../../fixtures/binance-BTCUSDT-1h.tape', import.meta.url));
const OUT = fileURLToPath(new URL('../../../out/', import.meta.url));
const INITIAL_CASH = '100000';
const POSITION_SIZE = '0.25';

function main(): void {
  const tape = readBarTapeFileSync(TAPE);
  const params: SmaCrossoverParams = {
    fastPeriod: 24,
    slowPeriod: 72,
    // Position size is written the way a human says it and converted once, exactly.
    qty: parseFixed(POSITION_SIZE, tape.instrument.qtyExp),
    allowShort: true,
  };

  const engine = new Engine<SmaCrossoverParams>({
    instruments: [tape.instrument],
    strategy: smaCrossover,
    params,
    initialCash: INITIAL_CASH,
    seed: 20260825,
    execution: PRESETS.binanceSpot(),
    flattenAtEnd: true,
  });

  engine.feedBars(tape.chunk);
  const result = engine.finish();
  const metrics = computeMetrics(result);

  console.log(`Tapedeck — SMA crossover on ${tape.header.source}\n`);
  console.log(formatMetrics(metrics, tape.instrument.currency));

  // Writing the report here means the quickstart produces something you can look at.
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    `${OUT}report.html`,
    renderHtmlReport(result, metrics, { currency: tape.instrument.currency }),
    'utf8',
  );
  writeFileSync(`${OUT}metrics.json`, metricsToJsonString(metrics), 'utf8');

  console.log('\nreport  out/report.html');
  console.log('metrics out/metrics.json');
  console.log(
    '\nA 24/72 crossover on hourly BTC is a demonstration, not an edge. What this run shows is\n' +
      'that orders, fills, costs, accounting and reporting all ran end to end on real prices, and\n' +
      'that the engine reported every assumption it had to make along the way.',
  );
}

main();
