/**
 * The engine, in a browser tab.
 *
 * Nothing here reimplements anything. It imports the same `@tapedeck/core` the CLI imports, decodes
 * the same committed `.tape` the tests read, and draws with the same chart primitives that produce
 * the static report. The only thing this file adds is a form and a `requestAnimationFrame`.
 *
 * That it works at all is a consequence of a rule made for a different reason: `@tapedeck/core`,
 * `@tapedeck/indicators` and `@tapedeck/report` have **zero runtime dependencies** and import
 * nothing from `node:`, so they were portable to the browser without a line of change. Nobody
 * planned that; it fell out of ADR-0001 and ADR-0007.
 *
 * The report itself stays static and stays a file (ADR-0013). This is a different artefact with a
 * different job: a report is a record, and this is a demonstration.
 */

import { type BarChunk, PRESETS, runBacktest } from '@tapedeck/core';
import { decodeBarTape } from '@tapedeck/data/codec';
import smaCrossover from '../../examples/sma-crossover/src/strategy.ts';
import {
  type Metrics,
  areaPath,
  boundsOf,
  computeMetrics,
  downsample,
  linePath,
} from '@tapedeck/report';

const MONEY = 100_000_000;

interface Params {
  readonly fastPeriod: number;
  readonly slowPeriod: number;
  readonly qty: number;
  readonly preset: 'ideal' | 'binanceSpot';
  readonly allowShort: boolean;
}

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing #${id}`);
  return node;
}

/** The same lookup, for the form controls whose `value` the run reads. */
function field(id: string): HTMLInputElement & HTMLSelectElement {
  return el(id) as HTMLInputElement & HTMLSelectElement;
}

const money = (value: number): string =>
  (value / MONEY).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const percent = (value: number | null): string =>
  value === null ? 'n/a' : `${(value * 100).toFixed(2)}%`;
const decimal = (value: number | null): string => (value === null ? 'n/a' : value.toFixed(2));

/** Draws one line chart with the report's own path builders, so it looks like the report. */
function chart(
  series: { xs: Float64Array; ys: Float64Array; length: number },
  stroke: string,
  fill: string,
): string {
  const width = 900;
  const height = 260;
  const box = { width, height, left: 46, right: width - 14, top: 12, bottom: height - 26 };
  const reduced = downsample(series.xs, series.ys, series.length, 260);
  const bounds = boundsOf(reduced);
  const line = linePath(reduced, bounds, box);
  // The area is filled down to the bottom of the value range, which is what the report does.
  const area = areaPath(reduced, bounds, box, bounds.minY);

  return `<svg viewBox="0 0 ${String(width)} ${String(height)}" preserveAspectRatio="none" role="img">
    <path d="${area}" fill="${fill}" />
    <path d="${line}" fill="none" stroke="${stroke}" stroke-width="1.5" />
  </svg>`;
}

function readParams(): Params {
  return {
    fastPeriod: Number(field('fast').value),
    slowPeriod: Number(field('slow').value),
    qty: Number(field('qty').value),
    preset: field('preset').value as Params['preset'],
    allowShort: field('short').checked,
  };
}

function renderMetrics(metrics: Metrics, elapsed: number, bars: number): void {
  const cards: readonly (readonly [string, string, string])[] = [
    ['net profit', `${money(metrics.netProfit)} USDT`, metrics.netProfit >= 0 ? 'up' : 'down'],
    ['total return', percent(metrics.totalReturn), metrics.totalReturn >= 0 ? 'up' : 'down'],
    ['max drawdown', percent(metrics.maxDrawdown), 'down'],
    ['Sharpe', decimal(metrics.sharpe), ''],
    [
      'trades',
      `${String(metrics.trades)} (${String(metrics.wins)}W/${String(metrics.losses)}L)`,
      '',
    ],
    ['win rate', percent(metrics.winRate), ''],
    ['profit factor', decimal(metrics.profitFactor), ''],
    ['commission', `${money(metrics.commissionPaid)} USDT`, 'down'],
    [
      'costs ate',
      percent(metrics.commissionShareOfGross),
      (metrics.commissionShareOfGross ?? 0) > 0.5 ? 'down' : '',
    ],
  ];

  el('cards').innerHTML = cards
    .map(
      ([label, value, tone]) =>
        `<div class="card"><span class="label">${label}</span><span class="value ${tone}">${value}</span></div>`,
    )
    .join('');

  el('timing').textContent =
    `${bars.toLocaleString('en-US')} bars replayed in ${elapsed.toFixed(0)} ms ` +
    `(${((bars / elapsed) * 1000).toLocaleString('en-US', { maximumFractionDigits: 0 })} bars/s), ` +
    `in this tab, on the same kernel the CLI runs.`;

  const warnings = metrics.warnings;
  el('warnings').innerHTML =
    warnings.length === 0
      ? ''
      : `<h3>What this run could not know</h3><ul>${warnings
          .map((w) => `<li>${w.replace(/[<>&]/g, '')}</li>`)
          .join('')}</ul>`;
}

let chunk: BarChunk | null = null;

function run(): void {
  if (chunk === null) return;
  const params = readParams();
  if (params.fastPeriod >= params.slowPeriod) {
    el('error').textContent = 'The fast average has to be shorter than the slow one.';
    return;
  }
  el('error').textContent = '';

  const started = performance.now();
  const result = runBacktest(
    {
      instruments: [instrument],
      strategy: smaCrossover,
      params: {
        fastPeriod: params.fastPeriod,
        slowPeriod: params.slowPeriod,
        qty: params.qty,
        allowShort: params.allowShort,
      },
      initialCash: '100000',
      seed: 20_260_825,
      execution: PRESETS[params.preset](),
      flattenAtEnd: true,
      // The guarded bar view costs about half the throughput and exists to catch a strategy that
      // keeps the bar. Nothing here does, and the demo is the one place where speed is the message.
      barViewMode: 'reuse',
    },
    [chunk],
  );
  const elapsed = performance.now() - started;

  renderMetrics(computeMetrics(result), elapsed, result.stats.bars);

  const curve = result.equityCurve;
  el('equity').innerHTML = chart(
    { xs: curve.ts, ys: curve.equity, length: curve.length },
    '#1d4ed8',
    'rgba(29,78,216,0.10)',
  );

  // Drawdown, recomputed from the curve the run just produced.
  const drawdown = new Float64Array(curve.length);
  let peak = -Infinity;
  for (let i = 0; i < curve.length; i++) {
    const value = curve.equity[i] ?? 0;
    if (value > peak) peak = value;
    drawdown[i] = peak === 0 ? 0 : ((value - peak) / peak) * 100;
  }
  el('drawdown').innerHTML = chart(
    { xs: curve.ts, ys: drawdown, length: curve.length },
    '#b91c1c',
    'rgba(185,28,28,0.10)',
  );
}

let instrument: Parameters<typeof runBacktest>[0]['instruments'][number];

async function boot(): Promise<void> {
  const response = await fetch('btcusdt-1h.tape');
  if (!response.ok) throw new Error(`could not load the tape: ${String(response.status)}`);
  const file = decodeBarTape(new Uint8Array(await response.arrayBuffer()));
  chunk = file.chunk;
  instrument = file.instrument;

  el('source').textContent =
    `${file.instrument.venue}:${file.instrument.symbol} · ` +
    `${file.chunk.count.toLocaleString('en-US')} hourly bars · the same file the test suite reads`;

  for (const id of ['fast', 'slow', 'qty', 'preset', 'short']) {
    el(id).addEventListener('change', run);
  }
  el('run').addEventListener('click', run);
  run();
}

void boot().catch((error: unknown) => {
  el('error').textContent = String(error);
});
