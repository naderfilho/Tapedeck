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
  type CostPreset,
  DEFAULT_STRATEGY,
  DEFAULT_TIMEFRAME,
  EXAMPLE_MARKET,
  EXAMPLE_SIZE_COINS,
  PRESET_LABELS,
  type ParamSpec,
  type ParamValue,
  type RunConfig,
  STRATEGIES,
  type StrategySpec,
  TIMEFRAMES,
  type Tape,
  type TapeView,
  type Values,
  defaultPresetFor,
  describeQuantity,
  execute,
  fromQuery,
  loadTape,
  marketsByVenue,
  presetsFor,
  quantityFor,
  quoteOf,
  strategyById,
  toQuery,
  viewOf,
} from './run.ts';
import { type CursorState, attachCursor, readoutFor } from './cursor.ts';
import { setup, t } from './i18n.ts';

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
  'total return':
    'Net profit over the starting equity of 100,000 in the quote currency. Not annualised.',
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

/** Label and bubble for one metric, in the reader's language. */
const m = (key: string, english: string): string => t(`metric.${key}`, english);
const h = (key: string, english: string): string => t(`helpm.${key}`, helpFor(english));

function renderMetrics(
  metrics: Metrics,
  elapsed: number,
  bars: number,
  config: RunConfig,
  view: TapeView,
): void {
  // Every money figure is in the market's own quote currency, which is USDT on Binance and dollars
  // on Coinbase. Printing "USDT" over a Coinbase run would be a small lie in a large font.
  const quote = quoteOf(config.market);
  // Three headline numbers and then the rest. Nine cards of identical weight is a table pretending
  // to be a dashboard: it makes the reader decide what matters before they know what any of it is.
  const lead: readonly Metric[] = [
    [
      m('netProfit', 'net profit'),
      `${money(metrics.netProfit)} ${quote}`,
      metrics.netProfit >= 0 ? 'up' : 'down',
      h('netProfit', 'net profit'),
    ],
    [
      m('totalReturn', 'total return'),
      percent(metrics.totalReturn),
      metrics.totalReturn >= 0 ? 'up' : 'down',
      h('totalReturn', 'total return'),
    ],
    [
      m('maxDrawdown', 'max drawdown'),
      percent(metrics.maxDrawdown),
      'down',
      h('maxDrawdown', 'max drawdown'),
    ],
  ];
  const rest: readonly Metric[] = [
    [m('sharpe', 'Sharpe'), decimal(metrics.sharpe), '', h('sharpe', 'Sharpe')],
    [
      m('trades', 'trades'),
      `${String(metrics.trades)} (${String(metrics.wins)}W/${String(metrics.losses)}L)`,
      '',
      h('trades', 'trades'),
    ],
    [m('winRate', 'win rate'), percent(metrics.winRate), '', h('winRate', 'win rate')],
    [
      m('profitFactor', 'profit factor'),
      decimal(metrics.profitFactor),
      '',
      h('profitFactor', 'profit factor'),
    ],
    [
      m('commission', 'commission'),
      `${money(metrics.commissionPaid)} ${quote}`,
      'down',
      h('commission', 'commission'),
    ],
    [
      m('costsAte', 'costs ate'),
      percent(metrics.commissionShareOfGross),
      (metrics.commissionShareOfGross ?? 0) > 0.5 ? 'down' : '',
      h('costsAte', 'costs ate'),
    ],
  ];

  renderMetricsInto('headline', lead);
  renderMetricsInto('cards', rest);

  // A run that finishes inside the clock's resolution gets no throughput figure. `performance.now`
  // is deliberately coarsened against timing attacks, and dividing by the zero it then returns
  // printed "∞ bars/s", a number that says the replay took no time at all.
  const rate =
    elapsed > 0
      ? ` (${((bars / elapsed) * 1000).toLocaleString('en-US', { maximumFractionDigits: 0 })} ${t('demo.rate', 'bars/s')})`
      : '';
  const took =
    elapsed > 0
      ? `${elapsed.toFixed(elapsed < 10 ? 1 : 0)} ms`
      : t('demo.subTick', 'under the clock’s resolution');
  el('timing').textContent =
    `${bars.toLocaleString('en-US')} ${t('demo.replayed', 'bars replayed in')} ${took}${rate}, ` +
    t('demo.inTab', 'in this tab, on the same kernel the CLI runs.');

  // The class carries the styling, so a run with nothing to declare draws nothing at all. The
  // container used to be styled unconditionally and left an empty warning box on a clean run,
  // which trains a reader to stop looking at the one place this engine puts its caveats.
  // What the engine could not know, plus what the *tape* could not say. The second list is new
  // with the timeframe picker: aggregating an hourly tape onto a slower clock can only be as
  // complete as the hours underneath it, and both Coinbase tapes have holes where the venue
  // printed nothing for five hours at a stretch.
  const warnings = [...metrics.warnings, ...aggregationNotes(view)];
  const box = el('warnings');
  box.className = warnings.length === 0 ? '' : 'callout';
  box.innerHTML =
    warnings.length === 0
      ? ''
      : `<h3>${t('warn.title', 'What this run could not know')}</h3><ul>${warnings
          .map((w) => `<li>${w.replace(/[<>&]/g, '')}</li>`)
          .join('')}</ul>`;
}

/**
 * What aggregating the tape cost, in the engine's own voice.
 *
 * Printed with the run's caveats rather than under the chart, for the same reason everything else
 * here is: a number you cannot fully trust should not be read before the reason you cannot.
 */
function aggregationNotes(view: TapeView): readonly string[] {
  const notes: string[] = [];
  if (view.partialBuckets > 0) {
    notes.push(
      `${String(view.partialBuckets)} ${t(
        'warn.partial',
        'bar(s) were built from fewer hours than the timeframe implies, because the venue printed no candle for part of them. They are real bars that saw less of the market, not gaps that were filled in.',
      )}`,
    );
  }
  if (view.droppedTrailingBars > 0) {
    notes.push(
      `${String(view.droppedTrailingBars)} ${t(
        'warn.trailing',
        'hour(s) at the end of the tape did not complete a bar on this timeframe and were left out rather than published as a bar that had not finished forming.',
      )}`,
    );
  }
  return notes;
}

// --------------------------------------------------------------------------------------- run

const tapes = new Map<string, Tape>();
let active = EXAMPLE_MARKET;
let activeTimeframe = DEFAULT_TIMEFRAME;
let activeStrategy = DEFAULT_STRATEGY;
let sizeInitialised = false;

/** Reads the form back into the shape the engine takes, per the selected strategy's own spec. */
function readConfig(): RunConfig {
  const spec = strategyById(activeStrategy);
  const params: Record<string, ParamValue> = {};
  for (const param of spec?.params ?? []) {
    const input = document.getElementById(`p-${param.key}`) as HTMLInputElement | null;
    if (input === null) continue;
    params[param.key] = param.kind === 'bool' ? input.checked : Number(input.value);
  }
  return {
    market: active,
    timeframe: activeTimeframe,
    strategy: activeStrategy,
    params,
    notional: Number(field('notional').value),
    preset: field('preset').value as CostPreset,
  };
}

function run(): void {
  const tape = tapes.get(active);
  if (tape === undefined) return;

  const config = readConfig();
  if (!Number.isFinite(config.notional) || config.notional <= 0) {
    el('error').textContent = t('demo.badSize', 'Position size has to be a positive number.');
    return;
  }
  el('error').textContent = '';

  // The run happens on the selected clock, so the quantity is derived from that tape rather than
  // from the hourly one it was aggregated out of.
  const view = viewOf(tape, config.timeframe);
  el('derived').textContent =
    `≈ ${describeQuantity(view.tape, quantityFor(view.tape, config.notional))}`;

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

  renderMetrics(computeMetrics(result), elapsed, result.stats.bars, config, view);
  const curve = result.equityCurve;
  chart(
    'equity',
    { xs: curve.ts, ys: curve.equity, length: curve.length },
    {
      box: CHART_BOX,
      kind: 'equity',
      label: 'Equity curve',
      formatAxis: compact,
      formatValue: (value) => `${money(value)} ${quoteOf(config.market)}`,
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

  rememberInUrl(config);
  el('results').classList.add('is-ready');
}

// -------------------------------------------------------------------------------------- boot

async function load(id: string): Promise<Tape> {
  const tape = await loadTape(id, 'tapes/');
  tapes.set(id, tape);
  return tape;
}

/**
 * The line under the heading: which file is loaded, and how much of a year is really in it.
 *
 * The bar count is not decoration. Both Coinbase tapes hold 8,750 hours rather than 8,760, because
 * the venue printed nothing for two five-hour stretches, and a page that rounds that up to "a year
 * of data" is hiding the first thing an engineer would want to know about its inputs.
 */
function describeSource(tape: Tape): void {
  const frame = activeTimeframe === '1h' ? '' : ` → ${activeTimeframe}`;
  el('source').textContent =
    `${tape.instrument.venue}:${tape.instrument.symbol} · ` +
    `${tape.chunk.count.toLocaleString('en-US')} ${t('demo.source', 'hourly bars · the same files the test suite reads')}${frame}`;
}

async function select(id: string): Promise<void> {
  const previous = active;
  active = id;
  renderMarkets();

  // The cost setting belongs to a venue. Moving to a market on the other one takes the setting with
  // it, rather than leaving Binance's fees priced against a Coinbase tape.
  renderCosts(
    defaultPresetFor(previous) === defaultPresetFor(id)
      ? (field('preset').value as CostPreset)
      : defaultPresetFor(id),
  );

  document.body.classList.add('is-loading');
  try {
    const tape = await load(id);
    // Only ever on the very first load, and only for the instrument the report used: after that
    // the field belongs to the visitor and re-deriving it would silently discard what they typed.
    if (!sizeInitialised && id === EXAMPLE_MARKET) {
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

/**
 * The market picker, grouped by venue.
 *
 * Grouped rather than a flat row of twelve, because the venue is not a label on a market here — it
 * decides which fees apply, and BTC appears under both on purpose.
 */
function renderMarkets(): void {
  el('markets').innerHTML = marketsByVenue()
    .map(
      ([venue, markets]) =>
        `<div class="markets__group"><span class="markets__venue">${venue}</span>` +
        markets
          .map(
            (market) =>
              `<button class="market" type="button" data-market="${market.id}" aria-pressed="${
                market.id === active ? 'true' : 'false'
              }"><span class="market__ticker">${market.ticker}</span>` +
              `<span class="market__name">${market.name}</span></button>`,
          )
          .join('') +
        '</div>',
    )
    .join('');

  for (const button of Array.from(document.querySelectorAll('.market'))) {
    button.addEventListener('click', () => {
      const id = button.getAttribute('data-market');
      if (id !== null && id !== active) void select(id);
    });
  }
}

/** The bar-clock chips. Switching one re-aggregates the tape already in memory. */
function renderTimeframes(): void {
  el('timeframes').innerHTML = TIMEFRAMES.map(
    (frame) =>
      `<button class="tf" type="button" data-tf="${frame.id}" aria-pressed="${
        frame.id === activeTimeframe ? 'true' : 'false'
      }">${frame.label}</button>`,
  ).join('');

  for (const button of Array.from(document.querySelectorAll('.tf'))) {
    button.addEventListener('click', () => {
      const id = button.getAttribute('data-tf');
      if (id === null || id === activeTimeframe) return;
      activeTimeframe = id;
      renderTimeframes();
      const tape = tapes.get(active);
      if (tape !== undefined) describeSource(tape);
      run();
    });
  }
}

/**
 * The cost options, rebuilt for whichever venue the selected market trades on.
 *
 * Built here rather than written into the markup because the list is not fixed: three of the five
 * settings are transcriptions of one exchange's fee schedule, and offering one of them against the
 * other exchange's tape is exactly the flattering-by-accident failure this page argues against.
 */
function renderCosts(selected: CostPreset): void {
  const allowed = presetsFor(active);
  const choice = allowed.includes(selected) ? selected : defaultPresetFor(active);
  field('preset').innerHTML = allowed
    .map(
      (preset) =>
        `<option value="${preset}"${preset === choice ? ' selected' : ''}>` +
        `${t(`costs.${preset}`, PRESET_LABELS[preset])}</option>`,
    )
    .join('');
}

async function boot(): Promise<void> {
  // A shared link wins over the example defaults, and skips the size initialisation in `select`.
  const shared = fromQuery(window.location.search);
  if (shared !== null) {
    active = shared.market;
    activeTimeframe = shared.timeframe;
    activeStrategy = shared.strategy;
  }

  // The language is applied before anything is drawn, because half of this page is built by
  // script: the strategy chips and the cost options are rendered through `t()`, and rendering them
  // first meant a Portuguese page opened with an English picker on it until something re-ran.
  setup(rerender);

  renderMarkets();
  renderTimeframes();
  renderCosts(shared?.preset ?? defaultPresetFor(active));
  for (const id of ['equity', 'drawdown']) {
    attachCursor(el(id), () => chartStates.get(id) ?? null);
  }

  renderStrategies();
  renderParams(shared?.params ?? strategyById(activeStrategy)?.defaults ?? {});
  if (shared !== null) {
    field('notional').value = String(shared.notional);
    sizeInitialised = true;
  }

  for (const id of ['notional', 'preset']) {
    el(id).addEventListener('change', run);
  }
  el('run').addEventListener('click', run);
  await wireSharing();

  await select(active);
}

/**
 * Redraws everything the language toggle touches, then re-runs.
 *
 * The market chips, the cost options and the metric cards are all built by script, so switching
 * language has to rebuild them rather than only swapping the static copy around them.
 */
function rerender(): void {
  renderCosts(field('preset').value as CostPreset);
  renderStrategies();
  const tape = tapes.get(active);
  if (tape === undefined) return;
  describeSource(tape);
  run();
}

void boot().catch((error: unknown) => {
  el('error').textContent = String(error);
});

// ------------------------------------------------------------------ sharing and saving

/**
 * Keeps the address bar holding the run on screen.
 *
 * This is the entire sharing mechanism. A run is fully described by its configuration and the
 * engine is deterministic, so the URL is the artefact: whoever opens it recomputes the same numbers
 * rather than being shown a stored copy. No account, no row, nothing to go stale. The button below
 * only saves a click.
 */
function rememberInUrl(config: RunConfig): void {
  const url = `${window.location.pathname}?${toQuery(config)}`;
  window.history.replaceState(null, '', url);
}

async function wireSharing(): Promise<void> {
  el('share').addEventListener('click', () => {
    void navigator.clipboard.writeText(window.location.href).then(() => {
      const note = el('share-note');
      const original = note.textContent;
      note.textContent = t('action.shareCopied', 'Link copied.');
      setTimeout(() => {
        note.textContent = original;
      }, 2400);
    });
  });
  await Promise.resolve();
}

// -------------------------------------------------------------- the strategy picker and its form

/**
 * Draws the strategy chips and the blurb under them.
 *
 * The blurb is not decoration. Three strategies with no explanation is three buttons; three
 * strategies each saying what shape of result to expect is the point of having three.
 */
function renderStrategies(): void {
  el('strategies').innerHTML = STRATEGIES.map(
    (spec) =>
      `<button class="strategy" type="button" data-strategy="${spec.id}" aria-pressed="${
        spec.id === activeStrategy ? 'true' : 'false'
      }">${t(`strategy.${spec.id}`, spec.name)}</button>`,
  ).join('');

  const spec = strategyById(activeStrategy);
  el('strategy-blurb').textContent = spec === undefined ? '' : t(`blurb.${spec.id}`, spec.blurb);

  for (const button of Array.from(document.querySelectorAll('.strategy'))) {
    button.addEventListener('click', () => {
      const id = button.getAttribute('data-strategy');
      if (id === null || id === activeStrategy || strategyById(id) === undefined) return;
      activeStrategy = id;
      renderStrategies();
      renderParams(strategyById(id)?.defaults ?? {});
      run();
    });
  }
}

function paramMarkup(spec: StrategySpec, param: ParamSpec, value: ParamValue): string {
  const label =
    `<span><span>${t(`param.${param.key}`, param.label)}</span>` +
    `<button class="help" type="button" aria-label="What ${param.label} does">?` +
    `<span class="help__bubble" role="tooltip">${t(`helpp.${spec.id}.${param.key}`, param.help)}</span>` +
    `</button></span>`;

  if (param.kind === 'bool') {
    return (
      `<label class="switch"><input id="p-${param.key}" type="checkbox"${value === true ? ' checked' : ''} />` +
      `${label}</label>`
    );
  }
  const step = param.step ?? (param.kind === 'int' ? 1 : 0.1);
  return (
    `<label class="field">${label}` +
    `<input id="p-${param.key}" type="number" value="${String(value)}"` +
    (param.min === undefined ? '' : ` min="${String(param.min)}"`) +
    (param.max === undefined ? '' : ` max="${String(param.max)}"`) +
    ` step="${String(step)}" /></label>`
  );
}

/** Rebuilds the parameter controls for whichever strategy is selected. */
function renderParams(values: Values): void {
  const spec = strategyById(activeStrategy);
  if (spec === undefined) return;
  el('params').innerHTML = spec.params
    .map((param) => paramMarkup(spec, param, values[param.key] ?? spec.defaults[param.key] ?? 0))
    .join('');

  // Re-bound every render, because the inputs are new nodes. Cheap, and it keeps the listener and
  // the element it reads from being separate concerns that can fall out of step.
  for (const param of spec.params) {
    document.getElementById(`p-${param.key}`)?.addEventListener('change', run);
  }
}
