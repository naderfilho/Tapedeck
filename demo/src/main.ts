/**
 * The engine, in a browser tab.
 *
 * Nothing here reimplements anything. It imports the same `@tapedeck/core` the CLI imports, decodes
 * the same committed `.tape` files the tests read, and draws with the same chart primitives that
 * produce the static report. The only thing this file adds is a form, a cursor and some motion.
 *
 * That it works at all is a consequence of a rule made for a different reason: `@tapedeck/core`,
 * `@tapedeck/indicators` and `@tapedeck/report` have **zero runtime dependencies** and import
 * nothing from `node:`, so they were portable to the browser without a line of change. Nobody
 * planned that; it fell out of ADR-0001 and ADR-0007.
 *
 * The report itself stays static and stays a file (ADR-0013). This is a different artefact with a
 * different job: a report is a record, and this is a demonstration. Everything interactive below —
 * the crosshair, the tooltips, the transitions — exists here and can never leak into the report,
 * because the report has no `<script>` to run it.
 */

import { type BarChunk, PRESETS, runBacktest } from '@tapedeck/core';
import { decodeBarTape } from '@tapedeck/data/codec';
import smaCrossover from '../../examples/sma-crossover/src/strategy.ts';
import {
  type Bounds,
  type Box,
  CHART_BOX,
  type Metrics,
  SMALL_BOX,
  type Series,
  areaPath,
  axes,
  boundsOf,
  computeMetrics,
  downsample,
  linePath,
  scaleX,
  scaleY,
} from '@tapedeck/report';

const MONEY = 100_000_000;
const INITIAL_CASH = 100_000;

/**
 * The example's position size, in coins, so the demo opens on the run the report publishes.
 *
 * `examples/sma-crossover/src/main.ts` sizes in BTC — `0.25`, which is how a human says it for one
 * instrument. This page cannot: 0.25 is a different amount of money on every tape, and comparing
 * instruments is the whole reason the picker exists. So the control is quoted in USDT and the
 * default is whatever that size costs on the first bar, which makes the first result a visitor sees
 * identical to the one in `/report/`. Everything after that is theirs to change.
 */
const EXAMPLE_SIZE_COINS = 0.25;
const EXAMPLE_SYMBOL = 'BTCUSDT';

/**
 * The instruments the demo offers.
 *
 * Five rather than one because a single result teaches nothing: a 24/72 crossover looks like an
 * edge on whichever series happens to have trended, and the only way to see that is to switch.
 * They are committed tapes, not live requests — the page still sends nothing anywhere.
 */
const MARKETS = [
  { symbol: 'BTCUSDT', name: 'Bitcoin', ticker: 'BTC' },
  { symbol: 'ETHUSDT', name: 'Ethereum', ticker: 'ETH' },
  { symbol: 'SOLUSDT', name: 'Solana', ticker: 'SOL' },
  { symbol: 'BNBUSDT', name: 'BNB', ticker: 'BNB' },
  { symbol: 'XRPUSDT', name: 'XRP', ticker: 'XRP' },
] as const;

type MarketSymbol = (typeof MARKETS)[number]['symbol'];

/**
 * The instrument type is derived from `runBacktest` rather than imported, because what a tape
 * decodes to is the *spec* the engine accepts, not the resolved `Instrument` it builds internally.
 * Naming the concrete type here compiled until the engine added a field.
 */
type InstrumentInput = Parameters<typeof runBacktest>[0]['instruments'][number];

interface Tape {
  readonly instrument: InstrumentInput;
  readonly chunk: BarChunk;
}

interface Params {
  readonly fastPeriod: number;
  readonly slowPeriod: number;
  /** Position size in quote currency (USDT), which is the only size a reader can compare. */
  readonly notional: number;
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

/** The y-axis labels for money, which arrives fixed-point. */
function compact(value: number): string {
  const units = value / MONEY;
  return Math.abs(units) >= 1_000 ? `${(units / 1_000).toFixed(1)}k` : units.toFixed(2);
}

const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------------------- position sizing

/**
 * Turns a position size in USDT into the integer quantity the engine deals in.
 *
 * The control used to be a raw quantity, and `25000` meant 0.25 BTC only because that instrument
 * reports five decimals. The same number is 2,500 XRP on a tape that reports one, so a fixed
 * quantity stopped meaning anything the moment the demo offered more than one instrument. Size is
 * quoted in the currency the result is quoted in, and the quantity is derived per instrument.
 */
function quantityFor(tape: Tape, notionalUsdt: number): number {
  const price = (tape.chunk.close[0] ?? 0) / 10 ** tape.instrument.priceExp;
  if (price <= 0) return 0;
  const coins = notionalUsdt / price;
  // Every one of these tapes reports a lot size of exactly one unit at its own precision, so
  // rounding to an integer is the lot-size snap. `Math.max` keeps a tiny size legal rather than
  // submitting a zero-quantity order the engine would refuse.
  return Math.max(1, Math.round(coins * 10 ** tape.instrument.qtyExp));
}

function describeQuantity(tape: Tape, qty: number): string {
  const coins = qty / 10 ** tape.instrument.qtyExp;
  const digits = Math.min(tape.instrument.qtyExp, coins < 1 ? 4 : 2);
  return `≈ ${coins.toLocaleString('en-US', { maximumFractionDigits: digits })} ${tickerFor(tape.instrument.symbol)}`;
}

function tickerFor(symbol: string): string {
  return MARKETS.find((m) => m.symbol === symbol)?.ticker ?? symbol.replace('USDT', '');
}

// ------------------------------------------------------------------------------------- charts

interface ChartOptions {
  readonly box: Box;
  readonly kind: 'equity' | 'drawdown';
  readonly label: string;
  /** Short, for the axis, where five labels share the gutter. */
  readonly formatAxis: (value: number) => string;
  /** Full, for the crosshair, which has the room and is the one a reader will quote. */
  readonly formatValue: (value: number) => string;
  /** Where the fill closes: the bottom of the range for equity, zero for drawdown. */
  readonly baseline: 'min' | 0;
}

/** Everything the cursor needs to answer "what is under the mouse" without recomputing a run. */
interface ChartState {
  readonly box: Box;
  readonly bounds: Bounds;
  readonly series: Series;
  readonly formatValue: (value: number) => string;
  readonly ticker: string;
}

const chartStates = new Map<string, ChartState>();
const readouts = new Map<string, HTMLElement>();

/**
 * The floating value box for one panel, created once and kept across re-runs.
 *
 * It has to be owned here rather than by `wireCursor`, because drawing a chart replaces the
 * panel's `innerHTML`. The first version created the box at wiring time and the first re-run
 * detached it: the pointer handler went on writing into a node that was no longer in the document,
 * so the crosshair worked exactly once, before anyone changed a parameter.
 */
function readoutFor(target: string): HTMLElement {
  const existing = readouts.get(target);
  if (existing !== undefined) return existing;
  const readout = document.createElement('div');
  readout.className = 'readout';
  readout.setAttribute('aria-hidden', 'true');
  readouts.set(target, readout);
  return readout;
}

/**
 * Draws one line chart with the report's own boxes, axes and path builders.
 *
 * The box used to be built here — `right: width - 14`, `bottom: height - 26` — on the assumption
 * that those fields were coordinates. They are insets, so the usable width came out negative and
 * both charts collapsed into a 32×14 scribble in the top-left corner. Nothing here computes
 * geometry any more; `CHART_BOX` and `SMALL_BOX` are the report's, and so is `axes`.
 */
function chart(
  target: string,
  series: { xs: Float64Array; ys: Float64Array; length: number },
  options: ChartOptions,
  ticker: string,
): void {
  const { box, kind, label, formatAxis, formatValue, baseline } = options;
  const reduced = downsample(series.xs, series.ys, series.length, 600);
  const host = el(target);
  if (reduced.length === 0) {
    host.innerHTML = '';
    chartStates.delete(target);
    return;
  }
  const bounds = boundsOf(reduced);
  chartStates.set(target, { box, bounds, series: reduced, formatValue, ticker });

  // `pathLength="1"` normalises the line so the draw-in animation is one dash offset from 1 to 0,
  // without measuring the path in script. The cursor group is inert until a pointer arrives.
  host.innerHTML = `<svg class="chart" viewBox="0 0 ${String(box.width)} ${String(box.height)}" role="img" aria-label="${label}">
    ${axes({ box, series: reduced, formatY: formatAxis })}
    <path class="${kind}-area" d="${areaPath(reduced, bounds, box, baseline === 'min' ? bounds.minY : 0)}" />
    <path class="${kind}-line${reducedMotion() ? '' : ' draw'}" pathLength="1" d="${linePath(reduced, bounds, box)}" />
    <g class="cursor" aria-hidden="true">
      <line class="cursor-line" y1="${String(box.top)}" y2="${String(box.height - box.bottom)}" />
      <circle class="cursor-dot" r="4" />
    </g>
  </svg>`;

  // Re-attached after the markup is replaced, never re-created: the pointer handler holds this
  // node, so a fresh one each run would leave it writing into a detached element.
  host.appendChild(readoutFor(target));
}

/** Index of the point nearest an x in chart user units. The series is sorted, so this bisects. */
function nearestIndex(state: ChartState, userX: number): number {
  const { series, bounds, box } = state;
  const span = bounds.maxX - bounds.minX;
  const usable = box.width - box.left - box.right;
  const targetX = bounds.minX + ((userX - box.left) / usable) * span;

  let lo = 0;
  let hi = series.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((series.xs[mid] ?? 0) < targetX) lo = mid + 1;
    else hi = mid;
  }
  const before = Math.max(0, lo - 1);
  const dBefore = Math.abs((series.xs[before] ?? 0) - targetX);
  const dAt = Math.abs((series.xs[lo] ?? 0) - targetX);
  return dBefore < dAt ? before : lo;
}

const isoDay = (micros: number): string => new Date(micros / 1000).toISOString().slice(0, 10);

/**
 * Wires the crosshair for one chart panel.
 *
 * Pointer events rather than mouse events, so a touch drag reads the series too, and the readout
 * is an HTML element rather than SVG `<text>`: it has to be measured and clamped against the panel
 * edge, and the browser is better at that than arithmetic on a viewBox would be.
 */
function wireCursor(target: string): void {
  const host = el(target);
  const readout = readoutFor(target);

  const hide = (): void => {
    host.classList.remove('is-tracking');
  };

  host.addEventListener('pointerleave', hide);
  host.addEventListener('pointercancel', hide);
  host.addEventListener('pointermove', (event: PointerEvent) => {
    const state = chartStates.get(target);
    const svg = host.querySelector('svg');
    if (state === undefined || svg === null) return;

    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return;
    const { box } = state;
    const userX = ((event.clientX - rect.left) / rect.width) * box.width;
    const clamped = Math.min(Math.max(userX, box.left), box.width - box.right);

    const index = nearestIndex(state, clamped);
    const x = scaleX(state.series.xs[index] ?? 0, state.bounds, box);
    const value = state.series.ys[index] ?? 0;
    const y = scaleY(value, state.bounds, box);

    const line = svg.querySelector('.cursor-line');
    const dot = svg.querySelector('.cursor-dot');
    line?.setAttribute('x1', x.toFixed(2));
    line?.setAttribute('x2', x.toFixed(2));
    dot?.setAttribute('cx', x.toFixed(2));
    dot?.setAttribute('cy', y.toFixed(2));

    readout.innerHTML =
      `<span class="readout__date">${isoDay(state.series.xs[index] ?? 0)}</span>` +
      `<span class="readout__value">${state.formatValue(value)}</span>`;

    // Position in CSS pixels against the panel, then keep the box inside it.
    const px = (x / box.width) * rect.width + (rect.left - host.getBoundingClientRect().left);
    const half = readout.offsetWidth / 2;
    const maxLeft = host.clientWidth - readout.offsetWidth - 4;
    readout.style.left = `${String(Math.min(Math.max(px - half, 4), Math.max(4, maxLeft)))}px`;
    host.classList.add('is-tracking');
  });
}

// ------------------------------------------------------------------------------------ metrics

type Metric = readonly [label: string, value: string, tone: string, help: string];

/**
 * What each number means, for a visitor who did not write the engine.
 *
 * These are deliberately not definitions of "what is a Sharpe ratio" — the reader can look that
 * up. They say what *this* run measured and, where it matters, how the number misleads.
 */
const HELP: Readonly<Record<string, string>> = {
  'net profit':
    'Realised and unrealised PnL after every commission and slippage charge the run applied.',
  'total return': 'Net profit over the starting equity of 100,000 USDT. Not annualised.',
  'max drawdown':
    'The deepest peak-to-trough fall in equity, as a share of the peak. What holding this would have felt like at its worst.',
  Sharpe:
    'Mean return over its standard deviation, annualised from the bar interval. It punishes upside volatility as harshly as downside.',
  trades:
    'Round trips closed, with wins and losses. Any position still open at the end is flattened first, so nothing is left unpriced.',
  'win rate':
    'Share of closed trades that made money. On its own it says almost nothing — trend following wins rarely and wins big.',
  'profit factor':
    'Gross profit divided by gross loss. Under 1.0 the strategy loses money; 1.07 means it barely paid for itself.',
  commission: "Total fees charged, at the venue's real published maker and taker rates.",
  'costs ate':
    'Commission as a share of gross profit. This is the number a backtester that skips fees never has to show you.',
};

function metricMarkup([label, value, tone, help]: Metric): string {
  return (
    `<div class="metric"><span class="label">${label}` +
    `<button class="help" type="button" aria-label="What ${label} means">?` +
    `<span class="help__bubble" role="tooltip">${help}</span></button>` +
    `</span><span class="value ${tone}">${value}</span></div>`
  );
}

const renderMetricsInto = (id: string, metrics: readonly Metric[]): void => {
  el(id).innerHTML = metrics.map(metricMarkup).join('');
};

const helpFor = (label: string): string => HELP[label] ?? '';

function renderMetrics(metrics: Metrics, elapsed: number, bars: number): void {
  // Three headline numbers and then the rest. Nine cards of identical weight is a table pretending
  // to be a dashboard: it makes the reader decide what matters before they know what any of it is.
  const lead: readonly Metric[] = [
    [
      'net profit',
      `${money(metrics.netProfit)} USDT`,
      metrics.netProfit >= 0 ? 'up' : 'down',
      helpFor('net profit'),
    ],
    [
      'total return',
      percent(metrics.totalReturn),
      metrics.totalReturn >= 0 ? 'up' : 'down',
      helpFor('total return'),
    ],
    ['max drawdown', percent(metrics.maxDrawdown), 'down', helpFor('max drawdown')],
  ];
  const rest: readonly Metric[] = [
    ['Sharpe', decimal(metrics.sharpe), '', helpFor('Sharpe')],
    [
      'trades',
      `${String(metrics.trades)} (${String(metrics.wins)}W/${String(metrics.losses)}L)`,
      '',
      helpFor('trades'),
    ],
    ['win rate', percent(metrics.winRate), '', helpFor('win rate')],
    ['profit factor', decimal(metrics.profitFactor), '', helpFor('profit factor')],
    ['commission', `${money(metrics.commissionPaid)} USDT`, 'down', helpFor('commission')],
    [
      'costs ate',
      percent(metrics.commissionShareOfGross),
      (metrics.commissionShareOfGross ?? 0) > 0.5 ? 'down' : '',
      helpFor('costs ate'),
    ],
  ];

  renderMetricsInto('headline', lead);
  renderMetricsInto('cards', rest);

  // A run that finishes inside the clock's resolution gets no throughput figure. `performance.now`
  // is deliberately coarsened against timing attacks, and dividing by the zero it then returns
  // printed "∞ bars/s" — a number that says the replay took no time at all.
  const rate =
    elapsed > 0
      ? ` (${((bars / elapsed) * 1000).toLocaleString('en-US', { maximumFractionDigits: 0 })} bars/s)`
      : '';
  const took =
    elapsed > 0 ? `${elapsed.toFixed(elapsed < 10 ? 1 : 0)} ms` : 'under the clock’s resolution';
  el('timing').textContent =
    `${bars.toLocaleString('en-US')} bars replayed in ${took}${rate}, ` +
    `in this tab, on the same kernel the CLI runs.`;

  // The class carries the styling, so a run with nothing to declare draws nothing at all. The
  // container used to be styled unconditionally and left an empty warning box on a clean run,
  // which trains a reader to stop looking at the one place this engine puts its caveats.
  const warnings = metrics.warnings;
  const box = el('warnings');
  box.className = warnings.length === 0 ? '' : 'callout';
  box.innerHTML =
    warnings.length === 0
      ? ''
      : `<h3>What this run could not know</h3><ul>${warnings
          .map((w) => `<li>${w.replace(/[<>&]/g, '')}</li>`)
          .join('')}</ul>`;
}

// --------------------------------------------------------------------------------------- run

const tapes = new Map<MarketSymbol, Tape>();
let active: MarketSymbol = EXAMPLE_SYMBOL;
let sizeInitialised = false;

function readParams(): Params {
  return {
    fastPeriod: Number(field('fast').value),
    slowPeriod: Number(field('slow').value),
    notional: Number(field('notional').value),
    preset: field('preset').value as Params['preset'],
    allowShort: field('short').checked,
  };
}

function run(): void {
  const tape = tapes.get(active);
  if (tape === undefined) return;

  const params = readParams();
  if (params.fastPeriod >= params.slowPeriod) {
    el('error').textContent = 'The fast average has to be shorter than the slow one.';
    return;
  }
  if (!Number.isFinite(params.notional) || params.notional <= 0) {
    el('error').textContent = 'Position size has to be a positive number of USDT.';
    return;
  }
  el('error').textContent = '';

  const qty = quantityFor(tape, params.notional);
  el('derived').textContent = describeQuantity(tape, qty);

  const started = performance.now();
  const result = runBacktest(
    {
      instruments: [tape.instrument],
      strategy: smaCrossover,
      params: {
        fastPeriod: params.fastPeriod,
        slowPeriod: params.slowPeriod,
        qty,
        allowShort: params.allowShort,
      },
      initialCash: String(INITIAL_CASH),
      seed: 20_260_825,
      execution: PRESETS[params.preset](),
      flattenAtEnd: true,
      // The guarded bar view costs about half the throughput and exists to catch a strategy that
      // keeps the bar. Nothing here does, and the demo is the one place where speed is the message.
      barViewMode: 'reuse',
    },
    [tape.chunk],
  );
  const elapsed = performance.now() - started;

  renderMetrics(computeMetrics(result), elapsed, result.stats.bars);

  const ticker = tickerFor(tape.instrument.symbol);
  const curve = result.equityCurve;
  chart(
    'equity',
    { xs: curve.ts, ys: curve.equity, length: curve.length },
    {
      box: CHART_BOX,
      kind: 'equity',
      label: 'Equity curve',
      formatAxis: compact,
      formatValue: (value) => `${money(value)} USDT`,
      baseline: 'min',
    },
    ticker,
  );

  // Drawdown, recomputed from the curve the run just produced.
  const drawdown = new Float64Array(curve.length);
  let peak = -Infinity;
  for (let i = 0; i < curve.length; i++) {
    const value = curve.equity[i] ?? 0;
    if (value > peak) peak = value;
    drawdown[i] = peak === 0 ? 0 : ((value - peak) / peak) * 100;
  }
  chart(
    'drawdown',
    { xs: curve.ts, ys: drawdown, length: curve.length },
    {
      box: SMALL_BOX,
      kind: 'drawdown',
      label: 'Drawdown',
      formatAxis: (value) => `${value.toFixed(1)}%`,
      formatValue: (value) => `${value.toFixed(2)}%`,
      baseline: 0,
    },
    ticker,
  );

  el('results').classList.add('is-ready');
}

// -------------------------------------------------------------------------------------- boot

async function load(symbol: MarketSymbol): Promise<Tape> {
  const cached = tapes.get(symbol);
  if (cached !== undefined) return cached;

  const response = await fetch(`tapes/${symbol}-1h.tape`);
  if (!response.ok) {
    throw new Error(`could not load the tape for ${symbol}: ${String(response.status)}`);
  }
  const file = decodeBarTape(new Uint8Array(await response.arrayBuffer()));
  const tape: Tape = { instrument: file.instrument, chunk: file.chunk };
  tapes.set(symbol, tape);
  return tape;
}

function describeSource(tape: Tape): void {
  el('source').textContent =
    `${tape.instrument.venue}:${tape.instrument.symbol} · ` +
    `${tape.chunk.count.toLocaleString('en-US')} hourly bars · the same files the test suite reads`;
}

async function select(symbol: MarketSymbol): Promise<void> {
  active = symbol;
  for (const button of Array.from(document.querySelectorAll('.market'))) {
    button.setAttribute(
      'aria-pressed',
      button.getAttribute('data-symbol') === symbol ? 'true' : 'false',
    );
  }

  document.body.classList.add('is-loading');
  try {
    const tape = await load(symbol);
    // Only ever on the very first load, and only for the instrument the report used: after that
    // the field belongs to the visitor and re-deriving it would silently discard what they typed.
    if (!sizeInitialised && symbol === EXAMPLE_SYMBOL) {
      const price = (tape.chunk.close[0] ?? 0) / 10 ** tape.instrument.priceExp;
      field('notional').value = String(Math.round(EXAMPLE_SIZE_COINS * price));
      sizeInitialised = true;
    }
    describeSource(tape);
    el('error').textContent = '';
    run();
  } catch (error: unknown) {
    el('error').textContent = String(error);
  } finally {
    document.body.classList.remove('is-loading');
  }
}

function renderMarkets(): void {
  el('markets').innerHTML = MARKETS.map(
    (market) =>
      `<button class="market" type="button" data-symbol="${market.symbol}" aria-pressed="${
        market.symbol === active ? 'true' : 'false'
      }"><span class="market__ticker">${market.ticker}</span>` +
      `<span class="market__name">${market.name}</span></button>`,
  ).join('');

  for (const button of Array.from(document.querySelectorAll('.market'))) {
    button.addEventListener('click', () => {
      const symbol = button.getAttribute('data-symbol') as MarketSymbol | null;
      if (symbol !== null && symbol !== active) void select(symbol);
    });
  }
}

async function boot(): Promise<void> {
  renderMarkets();
  wireCursor('equity');
  wireCursor('drawdown');

  for (const id of ['fast', 'slow', 'notional', 'preset', 'short']) {
    el(id).addEventListener('change', run);
  }
  el('run').addEventListener('click', run);

  await select(active);
}

void boot().catch((error: unknown) => {
  el('error').textContent = String(error);
});
