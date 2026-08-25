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

function card(label: string, value: string, tone: 'good' | 'bad' | 'plain' = 'plain'): string {
  return `<div class="card ${tone}"><div class="card-label">${escapeHtml(label)}</div><div class="card-value">${escapeHtml(value)}</div></div>`;
}

function toneOf(value: number): 'good' | 'bad' | 'plain' {
  if (value > 0) return 'good';
  if (value < 0) return 'bad';
  return 'plain';
}

interface AxisOptions {
  readonly box: Box;
  readonly series: Series;
  readonly formatY: (value: number) => string;
}

function axes(options: AxisOptions): string {
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

  const dates = xTicks
    .map(
      (tick) =>
        `<text class="tick" x="${tick.position.toFixed(1)}" y="${String(box.height - 8)}" text-anchor="middle">${escapeHtml(tick.label)}</text>`,
    )
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

  return `<table>
  <thead><tr><th>#</th><th>Symbol</th><th>Side</th><th>Entry</th><th>Exit</th><th>Bars</th><th>Gross</th><th>Fees</th><th>Net</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>${note}`;
}

const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 32px 24px 64px; font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #14171a; background: #f6f7f9; }
main { max-width: 1080px; margin: 0 auto; }
h1 { font-size: 24px; margin: 0 0 4px; letter-spacing: -0.01em; }
h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.08em; color: #5b6570; margin: 40px 0 12px; font-weight: 600; }
.subtitle { color: #5b6570; margin: 0 0 24px; font-size: 14px; }
.panel { background: #fff; border: 1px solid #e3e6ea; border-radius: 10px; padding: 20px; }
.caveats { border-left: 4px solid #c2801a; background: #fff8ec; }
.caveats h2 { margin-top: 0; color: #8a5a10; }
.caveats ul { margin: 0; padding-left: 20px; }
.caveats li { margin-bottom: 8px; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: 12px; }
.card { background: #fff; border: 1px solid #e3e6ea; border-radius: 10px; padding: 12px 14px; }
.card-label { font-size: 12px; color: #5b6570; text-transform: uppercase; letter-spacing: 0.05em; }
.card-value { font-size: 20px; font-variant-numeric: tabular-nums; margin-top: 4px; }
.card.good .card-value { color: #0f7b4f; }
.card.bad .card-value { color: #b3261e; }
.chart { width: 100%; height: auto; display: block; }
.grid { stroke: #e3e6ea; stroke-width: 1; }
.tick { fill: #7a8590; font-size: 11px; font-family: inherit; }
.baseline { stroke: #b9c0c8; stroke-width: 1; stroke-dasharray: 4 4; }
.equity-line { fill: none; stroke: #1f6feb; stroke-width: 1.6; stroke-linejoin: round; }
.equity-area { fill: rgba(31, 111, 235, 0.08); stroke: none; }
.drawdown-span { fill: rgba(179, 38, 30, 0.08); }
.drawdown-line { fill: none; stroke: #b3261e; stroke-width: 1.2; }
.drawdown-area { fill: rgba(179, 38, 30, 0.12); stroke: none; }
.bin { fill: #8a95a1; }
.bin.win { fill: #0f7b4f; }
.bin.loss { fill: #b3261e; }
.meta { display: grid; grid-template-columns: 180px 1fr; gap: 4px 16px; font-size: 14px; }
.meta dt { color: #5b6570; }
.meta dd { margin: 0; font-variant-numeric: tabular-nums; }
table { width: 100%; border-collapse: collapse; font-size: 13px; background: #fff; border: 1px solid #e3e6ea; border-radius: 10px; overflow: hidden; }
th, td { padding: 7px 10px; text-align: left; border-bottom: 1px solid #eef0f3; }
th { background: #fafbfc; font-weight: 600; color: #5b6570; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
td.strong { font-weight: 600; }
tr.win td.strong { color: #0f7b4f; }
tr.loss td.strong { color: #b3261e; }
.note, .empty { color: #7a8590; font-size: 13px; margin: 10px 2px 0; }
footer { margin-top: 48px; color: #7a8590; font-size: 12px; }
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
  const title = options.title ?? `${result.config.strategyId} — Tapedeck report`;
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
      <dt>Slippage</dt><dd>${escapeHtml(result.config.slippageModel)}</dd>
      <dt>Commission</dt><dd>${escapeHtml(result.config.commissionModel)}</dd>
      <dt>Latency</dt><dd>${escapeHtml(result.config.latencyModel)}</dd>
      <dt>Liquidity</dt><dd>${escapeHtml(result.config.liquidityModel)}</dd>
      <dt>Intrabar policy</dt><dd>${escapeHtml(result.config.intrabarPolicy)}</dd>
      <dt>Bar view mode</dt><dd>${escapeHtml(result.config.barViewMode)}</dd>
      <dt>Exposure</dt><dd>${percent(metrics.exposure, 1)}</dd>
      <dt>Average bars held</dt><dd>${decimal(metrics.avgBarsHeld, 1)}</dd>
      <dt>Longest drawdown</dt><dd>${String(metrics.longestDrawdownBars)} bars</dd>
      <dt>Ambiguous bars</dt><dd>${String(metrics.ambiguousBars)}</dd>
      <dt>Parameters</dt><dd>${escapeHtml(JSON.stringify(result.config.params))}</dd>
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
