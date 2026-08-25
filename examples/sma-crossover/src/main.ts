/**
 * Runs the crossover end to end on real data and prints a summary.
 *
 * Node 24 strips the types, so this file runs directly:
 *
 * ```sh
 * node examples/sma-crossover/src/main.ts
 * ```
 *
 * The data is the committed BTCUSDT fixture: a year of hourly candles from Binance, fetched by
 * `pnpm fixtures` through the same provider a user would call. Metrics — Sharpe, drawdown, profit
 * factor — arrive with `@tapedeck/report` in phase 3. What is printed here is what the core itself
 * knows, including the warnings, which come first on purpose.
 */

import { fileURLToPath } from 'node:url';
import {
  type RunResult,
  Engine,
  MONEY_EXP,
  PRESETS,
  formatFixed,
  parseFixed,
  toIso,
} from '@tapedeck/core';
import { readBarTapeFileSync } from '@tapedeck/data';
import { smaCrossover, type SmaCrossoverParams } from './strategy.ts';

const TAPE = fileURLToPath(new URL('../../../fixtures/binance-BTCUSDT-1h.tape', import.meta.url));
const INITIAL_CASH = '100000';
const POSITION_SIZE = '0.25';

function money(value: number): string {
  return formatFixed(value, MONEY_EXP);
}

function percent(part: number, whole: number): string {
  return whole === 0 ? '0.0%' : `${((part / whole) * 100).toFixed(1)}%`;
}

function summarise(result: RunResult): string {
  const lines: string[] = [];
  const { stats } = result;

  if (result.warnings.length > 0) {
    lines.push('Modelling caveats');
    for (const warning of result.warnings) lines.push(`  ! ${warning}`);
    lines.push('');
  }

  lines.push(`Strategy       ${result.config.strategyId}  seed=${String(result.config.seed)}`);
  lines.push(`Instrument     ${result.config.instruments.join(', ')}`);
  lines.push(
    `Execution      slippage=${result.config.slippageModel}  commission=${result.config.commissionModel}`,
  );
  lines.push(
    `               liquidity=${result.config.liquidityModel}  intrabar=${result.config.intrabarPolicy}`,
  );
  lines.push(
    `Period         ${result.startTs === null ? 'n/a' : toIso(result.startTs)} to ${
      result.endTs === null ? 'n/a' : toIso(result.endTs)
    }`,
  );
  lines.push('');
  lines.push(`Bars           ${String(stats.bars)}`);
  lines.push(
    `Orders         ${String(stats.ordersSubmitted)} submitted, ${String(stats.ordersRejected)} rejected`,
  );
  lines.push(`Fills          ${String(stats.fills)} (${String(stats.partialFills)} partial)`);
  lines.push(`Trades         ${String(result.trades.length)}`);
  lines.push('');
  lines.push(`Initial cash   ${money(result.initialCash)}`);
  lines.push(`Final equity   ${money(result.finalEquity)}`);
  lines.push(`Realised PnL   ${money(result.realizedPnl)}`);
  lines.push(`Unrealised     ${money(result.unrealizedPnl)}`);
  lines.push(`Commission     ${money(result.commissionPaid)}`);

  const wins = result.trades.filter((trade) => trade.netPnl > 0).length;
  lines.push(
    `Win rate       ${percent(wins, result.trades.length)} (${String(wins)}/${String(result.trades.length)})`,
  );

  return lines.join('\n');
}

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

  console.log(`Tapedeck — SMA crossover on ${tape.header.source}\n`);
  console.log(summarise(result));
  console.log(
    '\nA 24/72 crossover on hourly BTC is a demonstration, not an edge. What this run shows is\n' +
      'that orders, fills, costs and accounting all ran end to end on real prices, and that the\n' +
      'engine reported every assumption it had to make along the way.',
  );
}

main();
