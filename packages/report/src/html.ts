/**
 * The static HTML report.
 *
 * One file, no scripts, no network. Everything is inline: the styles, the SVG, the numbers. It
 * opens from a USB stick, survives being emailed, and prints.
 *
 * The layout puts the modelling caveats above the results on purpose. A report that leads with a
 * Sharpe ratio and hides "40% of these trades depended on an assumption about intrabar order" is a
 * report designed to be misread, and this engine goes to some trouble to know that number.
 */

import { MONEY_EXP, type RunResult, toIso } from '@tapedeck/core';
import type { Metrics } from './metrics.ts';
import { analyseDrawdown } from './metrics.ts';
import {
  CHART_BOX,
  SMALL_BOX,
  type Box,
  type Series,
  areaPath,
  boundsOf,
  downsample,
  histogram,
  linePath,
  scaleX,
  scaleY,
  ticks,
} from './charts.ts';

const MONEY_SCALE = 10 ** MONEY_EXP;
const BUCKETS = 600;
const MAX_TRADE_ROWS = 250;

export interface HtmlReportOptions {
  readonly title?: string | undefined;
  readonly currency?: string | undefined;
  /** Rows shown in the trade table before it is truncated with a note. */
  readonly maxTradeRows?: number | undefined;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Display only: fixed point becomes a float here and nowhere else. */
function toDisplay(value: number): number {
  return value / MONEY_SCALE;
}

function compact(value: number): string {
  const units = toDisplay(value);
  const magnitude = Math.abs(units);
  if (magnitude >= 1_000_000) return `${(units / 1_000_000).toFixed(2)}M`;
  if (magnitude >= 1_000) return `${(units / 1_000).toFixed(1)}k`;
  return units.toFixed(2);
}

function currencyText(value: number, currency: string): string {
  const text = toDisplay(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency === '' ? text : `${text} ${currency}`;
}

function percent(value: number | null, digits = 2): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(digits)}%`;
}

function decimal(value: number | null, digits = 2): string {
  return value === null ? 'n/a' : value.toFixed(digits);
}

function shortDate(micros: number): string {
  return toIso(micros as never).slice(0, 10);
}

/**
 * What each number means, for a reader who did not configure the run.
 *
 * Deliberately not textbook definitions. They say what *this* run measured and, where the number
 * is routinely misread, they say that too. The win rate entry is the clearest case: on its own it
 * is close to meaningless, and a report that prints it without saying so is inviting the mistake.
 */
const HELP: Readonly<Record<string, string>> = {
  'Net profit':
    'Realised and unrealised PnL after every commission and slippage charge this run applied.',
  'Total return': 'Net profit over the starting equity. Not annualised.',
  CAGR: 'Total return expressed as a yearly rate. Over a short run it extrapolates wildly and should be ignored.',
  'Max drawdown':
    'The deepest peak-to-trough fall in equity, as a share of the peak. What holding this would have felt like at its worst.',
  Sharpe:
    'Mean return over its standard deviation, annualised from the bar interval. It punishes upside volatility as harshly as downside.',
  Sortino:
    'Sharpe counting only downside deviation, so a strategy is not penalised for rising fast.',
  Calmar: 'Annual return over the maximum drawdown. How much pain each unit of return cost.',
  'Profit factor':
    'Gross profit divided by gross loss. Under 1.0 the strategy loses money; just above it means it barely paid for itself.',
  Trades:
    'Round trips closed. Any position still open at the end is flattened first, so nothing is left unpriced.',
  'Win rate':
    'Share of closed trades that made money. On its own it says almost nothing: trend following wins rarely and wins big, so read the profit factor instead.',
  Expectancy: 'Average net PnL per closed trade, costs included.',
  Commission: "Total fees charged, at the venue's real published maker and taker rates.",
  Slippage: 'The model that decides how far from the quoted price an order actually filled.',
  Latency:
    'The delay between submitting an order and it reaching the book. Shorter than one bar cannot be honoured on bar data, which is why the run says how often that happened.',
  Liquidity: 'The cap on how much of a bar this run was allowed to take.',
  'Intrabar policy':
    'How a bar that could fill more than one resting order is resolved. Pessimistic means the worse outcome wins, every time.',
  'Bar view mode':
    'Guarded revokes the bar object after the hook returns, so a strategy that keeps a reference is caught rather than silently reading stale prices.',
  Exposure: 'Share of the run spent holding a position rather than flat.',
  'Ambiguous bars':
    'Bars where a stop and a target both sat inside the range, so the order they filled in could not be known from bar data alone.',
};

/**
 * A "?" that reveals an explanation, in CSS alone.
 *
 * No script, because ADR-0013 does not allow one and this does not need one: `:hover` and
 * `:focus-within` do the whole job, so the tooltips survive in the file you download and in the one
 * you email. The button is focusable so a keyboard reaches them too, and `@media print` drops them.
 */
function help(label: string): string {
  const text = HELP[label];
  if (text === undefined) return '';
  return (
    `<span class="help" tabindex="0" role="button" aria-label="What ${escapeHtml(label)} means">?` +
    `<span class="help-bubble" role="tooltip">${escapeHtml(text)}</span></span>`
  );
}

function card(label: string, value: string, tone: 'good' | 'bad' | 'plain' = 'plain'): string {
  return `<div class="card ${tone}"><div class="card-label">${escapeHtml(label)}${help(label)}</div><div class="card-value">${escapeHtml(value)}</div></div>`;
}

/** A `<dt>` in the run panel, with the same explanation affordance the cards carry. */
function term(label: string): string {
  return `<dt>${escapeHtml(label)}${help(label)}</dt>`;
}

function toneOf(value: number): 'good' | 'bad' | 'plain' {
  if (value > 0) return 'good';
  if (value < 0) return 'bad';
  return 'plain';
}

export interface AxisOptions {
  readonly box: Box;
  readonly series: Series;
  readonly formatY: (value: number) => string;
}

/**
 * Horizontal grid lines with their value labels, and dated ticks along the bottom.
 *
 * Exported because the browser demo draws the same two charts and drew them without axes, which is
 * how a `Box` whose `right` and `bottom` were passed as coordinates rather than insets went
 * unnoticed: with nothing else on the canvas there was nothing to look wrong against. Sharing this
 * is the cheap way to keep the two from drifting again.
 */
export function axes(options: AxisOptions): string {
  const { box, series, formatY } = options;
  const bounds = boundsOf(series);
  const yTicks = ticks(bounds.minY, bounds.maxY, 4, formatY, (v) => scaleY(v, bounds, box));
  const xTicks = ticks(bounds.minX, bounds.maxX, 5, shortDate, (v) => scaleX(v, bounds, box));

  const grid = yTicks
    .map(
      (tick) =>
        `<line class="grid" x1="${String(box.left)}" y1="${tick.position.toFixed(1)}" x2="${String(
          box.width - box.right,
        )}" y2="${tick.position.toFixed(1)}" />` +
        `<text class="tick" x="${String(box.left - 8)}" y="${(tick.position + 4).toFixed(1)}" text-anchor="end">${escapeHtml(tick.label)}</text>`,
    )
    .join('');

  // The outermost dates are anchored to their own edge rather than centred on it. Centred, half of
  // each sits outside the viewBox and the last one is served with its day cut off.
  const dates = xTicks
    .map((tick, i) => {
      const anchor = i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle';
      return `<text class="tick" x="${tick.position.toFixed(1)}" y="${String(box.height - 8)}" text-anchor="${anchor}">${escapeHtml(tick.label)}</text>`;
    })
    .join('');

  return grid + dates;
}

function equityChart(result: RunResult, metrics: Metrics, currency: string): string {
  const { equityCurve } = result;
  const series = downsample(equityCurve.ts, equityCurve.equity, equityCurve.length, BUCKETS);
  if (series.length === 0) return '<p class="empty">No equity curve was recorded.</p>';

  const bounds = boundsOf(series);
  const box = CHART_BOX;
  const episode = metrics.maxDrawdownEpisode;

  // Shade the worst drawdown so the number in the card has a place on the picture.
  const shade =
    episode === null
      ? ''
      : (() => {
          const from = scaleX(episode.peakTs, bounds, box);
          const to = scaleX(episode.recoveredTs ?? episode.troughTs, bounds, box);
          return `<rect class="drawdown-span" x="${from.toFixed(1)}" y="${String(box.top)}" width="${Math.max(1, to - from).toFixed(1)}" height="${String(box.height - box.top - box.bottom)}" />`;
        })();

  const initial = scaleY(metrics.initialEquity, bounds, box);

  return `<svg class="chart" viewBox="0 0 ${String(box.width)} ${String(box.height)}" role="img" aria-label="Equity curve">
  ${axes({ box, series, formatY: (value) => compact(value) })}
  ${shade}
  <line class="baseline" x1="${String(box.left)}" y1="${initial.toFixed(1)}" x2="${String(box.width - box.right)}" y2="${initial.toFixed(1)}" />
  <path class="equity-area" d="${areaPath(series, bounds, box, bounds.minY)}" />
  <path class="equity-line" d="${linePath(series, bounds, box)}" />
  <title>Equity, ${escapeHtml(currencyText(metrics.initialEquity, currency))} to ${escapeHtml(currencyText(metrics.finalEquity, currency))}</title>
</svg>`;
}

function drawdownChart(result: RunResult): string {
  const { equityCurve } = result;
  const analysis = analyseDrawdown(equityCurve.ts, equityCurve.equity, equityCurve.length);
  const negated = new Float64Array(equityCurve.length);
  for (let i = 0; i < equityCurve.length; i++) negated[i] = -(analysis.underwater[i] ?? 0) * 100;

  const series = downsample(equityCurve.ts, negated, equityCurve.length, BUCKETS);
  if (series.length === 0) return '';

  const bounds = boundsOf(series);
  const box = SMALL_BOX;
  return `<svg class="chart" viewBox="0 0 ${String(box.width)} ${String(box.height)}" role="img" aria-label="Drawdown">
  ${axes({ box, series, formatY: (value) => `${value.toFixed(1)}%` })}
  <path class="drawdown-area" d="${areaPath(series, bounds, box, 0)}" />
  <path class="drawdown-line" d="${linePath(series, bounds, box)}" />
</svg>`;
}

function tradeHistogram(result: RunResult, currency: string): string {
  const values = result.trades.map((trade) => trade.netPnl);
  const bins = histogram(values, 31);
  if (bins.length === 0) return '<p class="empty">No closed trades to plot.</p>';

  const box = { ...SMALL_BOX, height: 220 };
  const maxCount = bins.reduce((max, bin) => Math.max(max, bin.count), 0);
  const usableWidth = box.width - box.left - box.right;
  const usableHeight = box.height - box.top - box.bottom;
  const barWidth = usableWidth / bins.length;

  const bars = bins
    .map((bin, i) => {
      const height = maxCount === 0 ? 0 : (bin.count / maxCount) * usableHeight;
      const x = box.left + i * barWidth;
      const y = box.top + usableHeight - height;
      const tone = bin.to <= 0 ? 'loss' : bin.from >= 0 ? 'win' : 'mixed';
      return `<rect class="bin ${tone}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, barWidth - 1.5).toFixed(1)}" height="${height.toFixed(1)}"><title>${String(bin.count)} trades between ${escapeHtml(currencyText(bin.from, currency))} and ${escapeHtml(currencyText(bin.to, currency))}</title></rect>`;
    })
    .join('');

  const first = bins[0];
  const last = bins[bins.length - 1];
  const labels =
    first === undefined || last === undefined
      ? ''
      : `<text class="tick" x="${String(box.left)}" y="${String(box.height - 8)}" text-anchor="start">${escapeHtml(compact(first.from))}</text>` +
        `<text class="tick" x="${String(box.width - box.right)}" y="${String(box.height - 8)}" text-anchor="end">${escapeHtml(compact(last.to))}</text>`;

  return `<svg class="chart" viewBox="0 0 ${String(box.width)} ${String(box.height)}" role="img" aria-label="Trade distribution">
  <line class="grid" x1="${String(box.left)}" y1="${String(box.top + usableHeight)}" x2="${String(box.width - box.right)}" y2="${String(box.top + usableHeight)}" />
  ${bars}${labels}
</svg>`;
}

function tradeTable(result: RunResult, currency: string, limit: number): string {
  const shown = result.trades.slice(0, limit);
  const rows = shown
    .map(
      (trade) => `<tr class="${trade.netPnl >= 0 ? 'win' : 'loss'}">
    <td>${String(trade.id)}</td>
    <td>${escapeHtml(trade.symbol)}</td>
    <td>${trade.direction}</td>
    <td class="num">${escapeHtml(toIso(trade.entryTs))}</td>
    <td class="num">${escapeHtml(toIso(trade.exitTs))}</td>
    <td class="num">${String(trade.barsHeld)}</td>
    <td class="num">${escapeHtml(currencyText(trade.grossPnl, ''))}</td>
    <td class="num">${escapeHtml(currencyText(trade.commission, ''))}</td>
    <td class="num strong">${escapeHtml(currencyText(trade.netPnl, currency))}</td>
  </tr>`,
    )
    .join('\n');

  const note =
    result.trades.length > shown.length
      ? `<p class="note">Showing the first ${String(shown.length)} of ${String(result.trades.length)} trades.</p>`
      : '';

  // Nine columns of ISO timestamps do not fit a phone, and a table that cannot fit takes the whole
  // page sideways with it: every heading above it then scrolls too, so the reader is dragging the
  // document left and right to read a number. Scrolling the table inside its own box keeps the
  // overflow where it belongs. Still one file, still no script.
  return `<div class="table-scroll"><table>
  <thead><tr><th>#</th><th>Symbol</th><th>Side</th><th>Entry</th><th>Exit</th><th>Bars</th><th>Gross</th><th>Fees</th><th>Net</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table></div>${note}`;
}

const STYLE = `
/* The site's tokens, inlined. A report is still one file with no script and no network request
   (ADR-0013) — that decision says nothing about colour, so this follows the reader's system
   instead of being the one white page in a dark site. Printing is handled at the bottom: the
   palette is forced back to paper, because "it gets printed" is in the ADR's own context. */
:root {
  color-scheme: dark;
  --bg: #0d1219; --panel: #111823; --panel-2: #161f2b;
  --line: #1e2836; --line-strong: #2a3648;
  --ink: #e8eef8; --ink-dim: #97a6bd; --ink-faint: #7d8ca6;
  --accent: #5aa9ff; --accent-soft: rgba(90, 169, 255, 0.10);
  --up: #35d399; --down: #ff6f6f; --down-soft: rgba(255, 111, 111, 0.12);
  --warn: #f5b544; --warn-soft: rgba(245, 181, 68, 0.08);
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    --bg: #f6f8fb; --panel: #ffffff; --panel-2: #f4f7fb;
    --line: #e4e9f0; --line-strong: #d2dae5;
    --ink: #0b1017; --ink-dim: #55637a; --ink-faint: #646e80;
    --accent: #1d63d8; --accent-soft: rgba(29, 99, 216, 0.08);
    --up: #0b7a51; --down: #b8271f; --down-soft: rgba(184, 39, 31, 0.10);
    --warn: #9a6410; --warn-soft: rgba(154, 100, 16, 0.07);
  }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 0 0 64px; font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: var(--bg); -webkit-font-smoothing: antialiased; }
main { max-width: 1080px; margin: 0 auto; padding: 34px 24px 0; }
h1 { font-size: 27px; margin: 0 0 5px; letter-spacing: -0.022em; font-weight: 650; }
h2 { font-family: var(--mono); font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.09em; color: var(--ink-faint); margin: 40px 0 10px; font-weight: 600; }
.subtitle { color: var(--ink-dim); margin: 0 0 24px; font-size: 14px; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 20px; }
.caveats { border: 1px solid var(--warn); border-left-width: 4px; background: var(--warn-soft); }
.caveats h2 { margin-top: 0; color: var(--warn); }
.caveats ul { margin: 0; padding-left: 20px; color: var(--ink-dim); }
.caveats li { margin-bottom: 8px; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: 12px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 13px 15px; }
.card-label { font-family: var(--mono); font-size: 11px; color: var(--ink-faint); text-transform: uppercase; letter-spacing: 0.06em; }
.card-value { font-family: var(--mono); font-size: 18px; font-weight: 600; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; margin-top: 6px; }
.card.good .card-value { color: var(--up); }
.card.bad .card-value { color: var(--down); }
.chart { width: 100%; height: auto; display: block; }
.grid { stroke: var(--line); stroke-width: 1; }
.tick { fill: var(--ink-faint); font-size: 13px; font-family: var(--mono); }
.baseline { stroke: var(--line-strong); stroke-width: 1; stroke-dasharray: 4 4; }
.equity-line { fill: none; stroke: var(--accent); stroke-width: 1.8; stroke-linejoin: round; }
.equity-area { fill: var(--accent-soft); stroke: none; }
.drawdown-span { fill: var(--down-soft); }
.drawdown-line { fill: none; stroke: var(--down); stroke-width: 1.4; }
.drawdown-area { fill: var(--down-soft); stroke: none; }
.bin { fill: var(--ink-faint); }
.bin.win { fill: var(--up); }
.bin.loss { fill: var(--down); }
.meta { display: grid; grid-template-columns: minmax(120px, 180px) 1fr; gap: 6px 16px; font-size: 14px; }
.meta dt { color: var(--ink-dim); }
.meta dd { margin: 0; min-width: 0; overflow-wrap: anywhere; font-family: var(--mono); font-size: 13px; font-variant-numeric: tabular-nums; }
.table-scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
table { width: 100%; min-width: 640px; border-collapse: collapse; font-size: 13px; background: var(--panel); }
th, td { padding: 8px 11px; text-align: left; border-bottom: 1px solid var(--line); }
th { background: var(--panel-2); font-family: var(--mono); font-weight: 600; color: var(--ink-faint); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
td { color: var(--ink-dim); }
td.num { text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; }
td.strong { font-weight: 600; color: var(--ink); }
tr.win td.strong { color: var(--up); }
tr.loss td.strong { color: var(--down); }
.note, .empty { color: var(--ink-faint); font-size: 13px; margin: 10px 2px 0; }
.card-label { display: flex; align-items: center; gap: 6px; }
.meta dt { display: flex; align-items: center; gap: 6px; }
/* Explanations with no script in them. ADR-0013 forbids one and this does not need one. */
.help { position: relative; flex: none; display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; border: 1px solid var(--line-strong); border-radius: 50%; color: var(--ink-faint); font: 600 9px/1 var(--mono); cursor: help; }
.help:hover, .help:focus, .help:focus-visible { border-color: var(--accent); color: var(--accent); outline: none; }
.help-bubble { position: absolute; bottom: calc(100% + 8px); left: 50%; z-index: 30; width: max-content; max-width: min(260px, 70vw); transform: translateX(-50%) translateY(3px); padding: 9px 11px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--panel-2); color: var(--ink-dim); font: 400 12.5px/1.45 inherit; text-align: left; text-transform: none; letter-spacing: 0; opacity: 0; visibility: hidden; pointer-events: none; box-shadow: 0 8px 24px rgb(0 0 0 / 0.28); transition: opacity .16s ease, transform .16s ease, visibility .16s; }
.help:hover .help-bubble, .help:focus .help-bubble, .help:focus-visible .help-bubble { opacity: 1; visibility: visible; transform: translateX(-50%) translateY(0); }
.cards > .card:first-child .help-bubble { left: 0; transform: translateY(3px); }
.cards > .card:first-child .help:hover .help-bubble, .cards > .card:first-child .help:focus .help-bubble { transform: translateY(0); }
@media (max-width: 600px) { .help-bubble { position: fixed; inset: auto 16px 16px 16px; width: auto; max-width: none; transform: translateY(8px); } .help:hover .help-bubble, .help:focus .help-bubble, .help:focus-visible .help-bubble { transform: none; } }
footer { margin-top: 48px; padding-top: 20px; border-top: 1px solid var(--line); color: var(--ink-faint); font-size: 12px; }
@media (max-width: 720px) { .tick { font-size: 20px; } }
/* On paper the palette goes back to ink on white whatever the screen was set to, and the table
   stops being a scroll box, because a clipped column does not exist once it is printed. */
@media print {
  :root {
    color-scheme: light;
    --bg: #ffffff; --panel: #ffffff; --panel-2: #ffffff;
    --line: #c8ced8; --line-strong: #aab3c0;
    --ink: #000000; --ink-dim: #333c48; --ink-faint: #56606e;
    --accent: #10459c; --accent-soft: rgba(16, 69, 156, 0.08);
    --up: #0a6b47; --down: #97201a; --down-soft: rgba(151, 32, 26, 0.10);
    --warn: #7d5210; --warn-soft: rgba(125, 82, 16, 0.06);
  }
  body { padding: 0; }
  main { padding: 0; max-width: none; }
  .help { display: none; }
  .table-scroll { overflow: visible; }
  table { min-width: 0; }
  .site-topbar { display: none; }
}
`;

/**
 * Renders the whole report as one string of HTML.
 *
 * Takes the metrics as an argument rather than computing them, so the CLI can write the JSON and
 * the HTML from the same numbers and nobody has to wonder whether they agree.
 */
export function renderHtmlReport(
  result: RunResult,
  metrics: Metrics,
  options: HtmlReportOptions = {},
): string {
  const currency = options.currency ?? '';
  const title = options.title ?? `${result.config.strategyId} · Tapedeck report`;
  const limit = options.maxTradeRows ?? MAX_TRADE_ROWS;

  const caveats =
    metrics.warnings.length === 0
      ? ''
      : `<section class="panel caveats">
  <h2>What this run could not know</h2>
  <ul>${metrics.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>
</section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>${escapeHtml(result.config.strategyId)}</h1>
  <p class="subtitle">${escapeHtml(result.config.instruments.join(', '))} &middot; ${escapeHtml(
    metrics.startTs === null ? 'n/a' : toIso(metrics.startTs),
  )} to ${escapeHtml(metrics.endTs === null ? 'n/a' : toIso(metrics.endTs))} &middot; ${String(
    metrics.bars,
  )} bars &middot; seed ${String(result.config.seed)}</p>

  ${caveats}

  <h2>Result</h2>
  <div class="cards">
    ${card('Net profit', currencyText(metrics.netProfit, currency), toneOf(metrics.netProfit))}
    ${card('Total return', percent(metrics.totalReturn), toneOf(metrics.totalReturn))}
    ${card('CAGR', percent(metrics.cagr), toneOf(metrics.cagr ?? 0))}
    ${card('Max drawdown', percent(metrics.maxDrawdown), metrics.maxDrawdown > 0 ? 'bad' : 'plain')}
    ${card('Sharpe', decimal(metrics.sharpe))}
    ${card('Sortino', decimal(metrics.sortino))}
    ${card('Calmar', decimal(metrics.calmar))}
    ${card('Profit factor', decimal(metrics.profitFactor))}
    ${card('Trades', String(metrics.trades))}
    ${card('Win rate', percent(metrics.winRate, 1))}
    ${card('Expectancy', currencyText(metrics.expectancy, currency), toneOf(metrics.expectancy))}
    ${card('Commission', currencyText(metrics.commissionPaid, currency), 'bad')}
  </div>

  <h2>Equity</h2>
  <section class="panel">${equityChart(result, metrics, currency)}</section>

  <h2>Drawdown</h2>
  <section class="panel">${drawdownChart(result)}</section>

  <h2>Trade distribution</h2>
  <section class="panel">${tradeHistogram(result, currency)}</section>

  <h2>Run</h2>
  <section class="panel">
    <dl class="meta">
      ${term('Slippage')}<dd>${escapeHtml(result.config.slippageModel)}</dd>
      ${term('Commission')}<dd>${escapeHtml(result.config.commissionModel)}</dd>
      ${term('Latency')}<dd>${escapeHtml(result.config.latencyModel)}</dd>
      ${term('Liquidity')}<dd>${escapeHtml(result.config.liquidityModel)}</dd>
      ${term('Intrabar policy')}<dd>${escapeHtml(result.config.intrabarPolicy)}</dd>
      ${term('Bar view mode')}<dd>${escapeHtml(result.config.barViewMode)}</dd>
      ${term('Exposure')}<dd>${percent(metrics.exposure, 1)}</dd>
      ${term('Average bars held')}<dd>${decimal(metrics.avgBarsHeld, 1)}</dd>
      ${term('Longest drawdown')}<dd>${String(metrics.longestDrawdownBars)} bars</dd>
      ${term('Ambiguous bars')}<dd>${String(metrics.ambiguousBars)}</dd>
      ${term('Parameters')}<dd>${escapeHtml(JSON.stringify(result.config.params))}</dd>
    </dl>
  </section>

  <h2>Trades</h2>
  ${tradeTable(result, currency, limit)}

  <footer>Generated by Tapedeck. A backtest is not a prediction; the caveats above are part of the result.</footer>
</main>
</body>
</html>
`;
}
