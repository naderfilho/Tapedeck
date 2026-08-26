/**
 * `@tapedeck/report` — metrics and a self-contained HTML report.
 *
 * Zero runtime dependencies, including for the charts: the output is one HTML file with inline
 * styles and inline SVG, no `<script>` and no network. A report should still open in five years.
 *
 * Two conventions worth knowing before reading a number here:
 *
 * - **Money stays exact.** Net profit, drawdown depth and expectancy are fixed-point integers
 *   taken straight from the ledger; only ratios are floats.
 * - **Undefined is `null`, not zero.** A profit factor with no losses, a Sharpe with one bar, a
 *   CAGR over a zero-length run: each reports `null` rather than a number that would be read as a
 *   result.
 */

export {
  type DrawdownAnalysis,
  type DrawdownEpisode,
  type Metrics,
  type MetricsOptions,
  analyseDrawdown,
  computeMetrics,
  inferPeriodsPerYear,
} from './metrics.ts';

export {
  type MetricsJson,
  SIGNIFICANT_DIGITS,
  formatMetrics,
  metricsToJson,
  metricsToJsonString,
  roundSignificant,
} from './format.ts';

export {
  type Bounds,
  type Box,
  type HistogramBin,
  type Series,
  type Tick,
  CHART_BOX,
  SMALL_BOX,
  areaPath,
  boundsOf,
  downsample,
  histogram,
  linePath,
  scaleX,
  scaleY,
  ticks,
} from './charts.ts';

export { type AxisOptions, type HtmlReportOptions, axes, renderHtmlReport } from './html.ts';
