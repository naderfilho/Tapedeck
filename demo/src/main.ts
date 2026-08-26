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
 * different job: a report is a record, and this is a demonstration. Everything interactive below,
 * the crosshair, the tooltips and the transitions, exists here and can never leak into the report,
 * because the report has no `<script>` to run it.
 */

import {
  type Box,
  CHART_BOX,
  type Metrics,
  SMALL_BOX,
  areaPath,
  axes,
  boundsOf,
  computeMetrics,
  downsample,
  linePath,
} from '@tapedeck/report';
import {
  EXAMPLE_SIZE_COINS,
  EXAMPLE_SYMBOL,
  MARKETS,
  type MarketSymbol,
  type RunConfig,
  type Tape,
  describeQuantity,
  execute,
  loadTape,
  quantityFor,
  toQuery,
} from './run.ts';
import { type CursorState, attachCursor, readoutFor } from './cursor.ts';

const MONEY = 100_000_000;

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

const chartStates = new Map<string, CursorState>();

/**
 * Draws one line chart with the report's own boxes, axes and path builders.
 *
 * The box used to be built here, `right: width - 14` and `bottom: height - 26`, on the assumption
 * that those fields were coordinates. They are insets, so the usable width came out negative and
 * both charts collapsed into a 32×14 scribble in the top-left corner. Nothing here computes
 * geometry any more; `CHART_BOX` and `SMALL_BOX` are the report's, and so is `axes`.
 */
function chart(
  target: string,
  series: { xs: Float64Array; ys: Float64Array; length: number },
  options: ChartOptions,
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
  chartStates.set(target, { box, bounds, series: reduced, formatValue });

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
  host.appendChild(readoutFor(host));
}

// ------------------------------------------------------------------------------------ metrics

type Metric = readonly [label: string, value: string, tone: string, help: string];

/**
 * What each number means, for a visitor who did not write the engine.
 *
 * These are deliberately not definitions of "what is a Sharpe ratio". The reader can look that
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
    'Share of closed trades that made money. On its own it says almost nothing. Trend following wins rarely and wins big.',
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
  // printed "∞ bars/s", a number that says the replay took no time at all.
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

function readConfig(): RunConfig {
  return {
    symbol: active,
    fastPeriod: Number(field('fast').value),
    slowPeriod: Number(field('slow').value),
    notional: Number(field('notional').value),
    preset: field('preset').value as RunConfig['preset'],
    allowShort: field('short').checked,
  };
}

function run(): void {
  const tape = tapes.get(active);
  if (tape === undefined) return;

  const config = readConfig();
  if (config.fastPeriod >= config.slowPeriod) {
    el('error').textContent = 'The fast average has to be shorter than the slow one.';
    return;
  }
  if (!Number.isFinite(config.notional) || config.notional <= 0) {
    el('error').textContent = 'Position size has to be a positive number of USDT.';
    return;
  }
  el('error').textContent = '';

  el('derived').textContent = `≈ ${describeQuantity(tape, quantityFor(tape, config.notional))}`;

  const started = performance.now();
  // `execute` is shared with the report page, which is the only reason the two can be trusted to
  // agree. Duplicating the call here would make them agree until somebody changed one of them.
  const result = execute(tape, config);
  const elapsed = performance.now() - started;

  // Both the nav link and the button carry the configuration, so the report opens on this run
  // rather than on the committed example.
  const query = toQuery(config);
  for (const link of Array.from(document.querySelectorAll('[data-report-link]'))) {
    link.setAttribute('href', `../report/?${query}`);
  }

  renderMetrics(computeMetrics(result), elapsed, result.stats.bars);
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
  );

  el('results').classList.add('is-ready');
}

// -------------------------------------------------------------------------------------- boot

async function load(symbol: MarketSymbol): Promise<Tape> {
  const tape = await loadTape(symbol, 'tapes/');
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
  for (const id of ['equity', 'drawdown']) {
    attachCursor(el(id), () => chartStates.get(id) ?? null);
  }

  for (const id of ['fast', 'slow', 'notional', 'preset', 'short']) {
    el(id).addEventListener('change', run);
  }
  el('run').addEventListener('click', run);

  await select(active);
}

void boot().catch((error: unknown) => {
  el('error').textContent = String(error);
});
