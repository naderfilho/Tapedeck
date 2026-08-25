/**
 * The benchmark behind the number in the README.
 *
 * Run it yourself:
 *
 * ```sh
 * pnpm bench
 * ```
 *
 * It reports a table rather than a single figure, because a single figure is marketing. "One
 * million bars per second" is only meaningful next to the question "doing what?" — replaying bars,
 * updating indicators, matching resting orders and trading are four very different workloads, and
 * the table shows all four.
 *
 * Strict mode is switched off before the core is loaded, so these are production-mode numbers.
 * The last row measures what development mode costs, since that is what the test suite actually
 * runs at.
 */

import type { BarChunk, InstrumentId, Strategy, StrategyContext, ViewMode } from '@tapedeck/core';

process.env['TAPEDECK_STRICT'] ??= '0';

const {
  BarChunkBuilder,
  Engine,
  INSTRUMENTS,
  MICROS_PER_MINUTE,
  PRESETS,
  asDuration,
  asQty,
  createRng,
  roundToTick,
} = await import('@tapedeck/core');

const BARS = 1_000_000;
const REPEATS = 5;
const ZERO = 0 as InstrumentId;

// --------------------------------------------------------------------------- data

/** Deterministic synthetic series, built once and replayed by every scenario. */
function makeSeries(bars: number, tickSize: number): BarChunk {
  const rng = createRng(1, 'bench');
  const builder = new BarChunkBuilder(ZERO, asDuration(MICROS_PER_MINUTE), bars);
  let price = 130_000;
  for (let i = 0; i < bars; i++) {
    const open = price;
    const close = Math.max(
      tickSize,
      roundToTick(open + Math.sin(i / 500) * 20 + (rng.nextFloat() - 0.5) * 40, tickSize),
    );
    const wick = roundToTick(20 + rng.nextInt(0, 40), tickSize, 'up');
    const openTs = i * MICROS_PER_MINUTE;
    builder.push(
      openTs,
      openTs + MICROS_PER_MINUTE,
      open,
      Math.max(open, close) + wick,
      Math.max(tickSize, Math.min(open, close) - wick),
      close,
      1_000,
    );
    price = close;
  }
  return builder.build();
}

// --------------------------------------------------------------------------- strategies

/** Fixed-window mean over a ring buffer: the shape every incremental indicator has. */
class RollingMean {
  private readonly window: Float64Array;
  private readonly period: number;
  private cursor = 0;
  private filled = 0;
  private sum = 0;

  constructor(period: number) {
    this.period = period;
    this.window = new Float64Array(period);
  }

  update(value: number): number | null {
    const outgoing = this.window[this.cursor] ?? 0;
    this.window[this.cursor] = value;
    this.cursor = (this.cursor + 1) % this.period;
    if (this.filled < this.period) {
      this.filled++;
      this.sum += value;
    } else {
      this.sum += value - outgoing;
    }
    return this.filled === this.period ? this.sum / this.period : null;
  }
}

function noopStrategy(): Strategy {
  return { id: 'noop', onInit: () => undefined };
}

function indicatorsOnly(): Strategy {
  const fast = new RollingMean(20);
  const slow = new RollingMean(60);
  let sink = 0;
  return {
    id: 'indicators',
    onInit: () => undefined,
    onBar: (bar) => {
      const f = fast.update(bar.close);
      const s = slow.update(bar.close);
      // Keep the values observable so the optimiser cannot delete the work.
      if (f !== null && s !== null && f > s) sink++;
    },
    onStop: (ctx) => {
      ctx.log.debug('crossings', { sink });
    },
  };
}

function crossover(): Strategy {
  const fast = new RollingMean(20);
  const slow = new RollingMean(60);
  let side = 0;
  return {
    id: 'crossover',
    onInit: () => undefined,
    onBar: (bar, ctx: StrategyContext) => {
      const f = fast.update(bar.close);
      const s = slow.update(bar.close);
      if (f === null || s === null) return;
      const next = f > s ? 1 : -1;
      if (next === side) return;
      side = next;
      const current = ctx.portfolio.position(ZERO).qty;
      const target = next;
      const delta = target - current;
      if (delta === 0) return;
      ctx.submit({
        instrumentId: ZERO,
        side: delta > 0 ? 'buy' : 'sell',
        type: 'market',
        qty: asQty(Math.abs(delta)),
      });
    },
  };
}

/** Always keeps a resting limit far from the market, so the matcher runs on every single bar. */
function restingOrders(): Strategy {
  return {
    id: 'resting',
    onInit: (ctx) => {
      ctx.submit({
        instrumentId: ZERO,
        side: 'buy',
        type: 'limit',
        qty: asQty(1),
        limitPrice: roundToTick(1_000, 5) as never,
      });
    },
  };
}

// --------------------------------------------------------------------------- harness

interface Scenario {
  readonly name: string;
  readonly strategy: () => Strategy;
  readonly viewMode: ViewMode;
  readonly validate: boolean;
  readonly note: string;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'replay only',
    strategy: noopStrategy,
    viewMode: 'reuse',
    validate: false,
    note: 'clock, scheduler, mark-to-market, equity curve',
  },
  {
    name: '+ two moving averages',
    strategy: indicatorsOnly,
    viewMode: 'reuse',
    validate: false,
    note: 'incremental indicators on every bar',
  },
  {
    name: '+ resting limit order',
    strategy: restingOrders,
    viewMode: 'reuse',
    validate: false,
    note: 'order matcher runs on every bar',
  },
  {
    name: '+ crossover trading',
    strategy: crossover,
    viewMode: 'reuse',
    validate: false,
    note: 'indicators, orders, fills, PnL',
  },
  {
    name: 'development mode',
    strategy: indicatorsOnly,
    viewMode: 'guarded',
    validate: true,
    note: 'guarded bar views + data validation, as the test suite runs',
  },
];

function runOnce(scenario: Scenario, series: BarChunk): number {
  const engine = new Engine({
    instruments: [INSTRUMENTS.WIN],
    strategy: scenario.strategy,
    params: {},
    initialCash: '1000000',
    seed: 1,
    execution: PRESETS.ideal(),
    barViewMode: scenario.viewMode,
    validateData: scenario.validate,
    recordFills: false,
    flattenAtEnd: false,
  });

  const start = performance.now();
  engine.feedBars(series);
  const result = engine.finish();
  const elapsed = performance.now() - start;

  if (result.stats.bars !== series.count) {
    throw new Error(
      `benchmark replayed ${String(result.stats.bars)} bars, expected ${String(series.count)}`,
    );
  }
  return elapsed;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function main(): void {
  const series = makeSeries(BARS, 5);
  const rows: string[] = [];

  console.log(
    `Tapedeck replay benchmark — ${BARS.toLocaleString('en-US')} bars, ${String(REPEATS)} runs each`,
  );
  console.log(`Node ${process.version} on ${process.platform}/${process.arch}\n`);

  for (const scenario of SCENARIOS) {
    runOnce(scenario, series); // warm up the JIT
    const timings: number[] = [];
    for (let i = 0; i < REPEATS; i++) timings.push(runOnce(scenario, series));

    const ms = median(timings);
    const barsPerSecond = (BARS / ms) * 1000;
    const nsPerBar = (ms * 1e6) / BARS;
    rows.push(
      `| ${scenario.name.padEnd(24)} | ${(barsPerSecond / 1e6).toFixed(2).padStart(8)} M bars/s | ${nsPerBar
        .toFixed(0)
        .padStart(5)} ns/bar | ${scenario.note} |`,
    );
    console.log(rows[rows.length - 1]);
  }

  console.log('\nMarkdown for the README:\n');
  console.log('| Scenario | Throughput | Per bar | What runs |');
  console.log('| --- | --- | --- | --- |');
  for (const row of rows) console.log(row);
}

main();
