/**
 * The report page, for the run you just configured.
 *
 * The page shipped as a static file: whatever instrument you picked in the demo, clicking through
 * to the report showed Bitcoin, because the file was the CLI example regenerated at build time. It
 * is a fair record and a confusing page. A report that does not describe the run you just did is
 * a report about somebody else's run.
 *
 * **Nothing is carried across.** The demo hands over the configuration in the URL, and this page
 * re-runs the backtest and calls the same `renderHtmlReport` the command line calls. That is only
 * possible because the engine is deterministic: recomputing is guaranteed to reproduce the demo's
 * numbers rather than merely likely to. It also makes the URL shareable, because anyone opening it
 * recalculates the identical report, and it means a link cannot outlive the truth, because there is
 * no stored result to go stale.
 *
 * ADR-0016 argues the exception this makes to ADR-0013. In short: `renderHtmlReport` still returns
 * one self-contained document with no script, the download button below hands you exactly that
 * file, and this script lives on the page around it rather than inside it.
 */

import {
  CHART_BOX,
  SMALL_BOX,
  analyseDrawdown,
  boundsOf,
  computeMetrics,
  downsample,
  renderHtmlReport,
} from '@tapedeck/report';
import type { RunResult } from '@tapedeck/core';
import { attachCursor, ensureCursorGroup, readoutFor } from './cursor.ts';
import { apply, initialLang, t } from './i18n.ts';
import { type RunConfig, describeConfig, execute, fromQuery, loadTape, tickerFor } from './run.ts';

const TAPES = '../demo/tapes/';

/** The same bucket count `renderHtmlReport` uses, so the cursor lands on the drawn points. */
const BUCKETS = 600;

const MONEY = 100_000_000;
const usdt = (value: number): string =>
  `${(value / MONEY).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;

/**
 * Makes the generated charts respond to the pointer, exactly as the demo's do.
 *
 * The report's SVG arrives inert, because the function that draws it is not allowed to emit a
 * script. The series is recomputed here rather than extracted from the markup: parsing coordinates
 * back out of a path would be reading the drawing to recover the data that drew it, and any change
 * to the geometry would silently desynchronise the crosshair from the line.
 */
function wireCharts(result: RunResult): void {
  const curve = result.equityCurve;

  const equity = downsample(curve.ts, curve.equity, curve.length, BUCKETS);

  const analysis = analyseDrawdown(curve.ts, curve.equity, curve.length);
  const negated = new Float64Array(curve.length);
  for (let i = 0; i < curve.length; i++) negated[i] = -(analysis.underwater[i] ?? 0) * 100;
  const drawdown = downsample(curve.ts, negated, curve.length, BUCKETS);

  const panels: readonly (readonly [
    string,
    typeof CHART_BOX,
    typeof equity,
    (v: number) => string,
  ])[] = [
    ['Equity curve', CHART_BOX, equity, usdt],
    ['Drawdown', SMALL_BOX, drawdown, (v: number) => `${v.toFixed(2)}%`],
  ];

  for (const [label, box, series, formatValue] of panels) {
    if (series.length === 0) continue;
    const svg = document.querySelector<SVGSVGElement>(`svg[aria-label="${label}"]`);
    const panel = svg?.closest('section') ?? null;
    if (svg === null || panel === null) continue;

    ensureCursorGroup(svg, box);
    panel.classList.add('chart-panel');
    panel.appendChild(readoutFor(panel));
    const state = { box, bounds: boundsOf(series), series, formatValue };
    attachCursor(panel, () => state);
  }
}

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing #${id}`);
  return node;
}

/**
 * Swaps in a freshly rendered report.
 *
 * `renderHtmlReport` returns a whole document, and only its `<main>` is wanted: the styles are
 * already on this page, produced by the same function, so re-inserting them would just duplicate
 * them. Parsed rather than assigned as `innerHTML` so the browser does the reading, and no part of
 * the generated markup has to be recognised by a regular expression here.
 */
function swapIn(html: string): void {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const fresh = parsed.querySelector('main');
  const current = document.querySelector('main');
  if (fresh === null || current === null) throw new Error('the rendered report had no <main>');

  // The banner lives inside `<main>`, so replacing the children takes it with them. Keeping the
  // node rather than rebuilding it matters: the download handler is bound to a button inside it,
  // and the first version silently lost both the banner and the download once the swap ran.
  const banner = current.querySelector('#banner');
  current.replaceChildren(...Array.from(fresh.childNodes));
  if (banner !== null) current.prepend(banner);
}

/** Offers the report as the file ADR-0013 describes: one document, no script, nothing to fetch. */
function offerDownload(html: string, config: RunConfig): void {
  const button = el('download') as HTMLButtonElement;
  button.hidden = false;
  button.addEventListener('click', () => {
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `tapedeck-${tickerFor(config.market).toLowerCase()}-${config.strategy}.html`;
    link.click();
    // Revoked on the next turn of the loop: revoking synchronously races the download in Safari.
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
  });
}

async function boot(): Promise<void> {
  // Only the chrome translates. The report itself is `renderHtmlReport`'s output and stays English
  // wherever it is opened, which is the point of it being a published artefact (ADR-0016).
  apply(initialLang());
  for (const button of Array.from(document.querySelectorAll<HTMLElement>('[data-lang]'))) {
    button.addEventListener('click', () => {
      const next = button.dataset['lang'];
      if (next === 'pt' || next === 'en') {
        apply(next);
        void boot();
      }
    });
  }

  const banner = el('banner');
  const config = fromQuery(window.location.search);

  if (config === null) {
    // No parameters, or parameters that did not survive validation. The published example is
    // already in the page, so say what it is rather than replacing it with an error.
    banner.className = 'report-banner';
    banner.innerHTML =
      `<span>${t('report.example', 'The published example: a 24/72 crossover on a year of hourly BTCUSDT, regenerated from the committed fixture on every deploy.')}</span>` +
      `<a class="btn btn--ghost btn--small" href="../demo/">${t('report.runYours', 'Run your own →')}</a>`;
    return;
  }

  banner.className = 'report-banner is-live';
  banner.innerHTML = `<span>${t('report.recomputing', 'Recomputing…')}</span>`;

  try {
    const tape = await loadTape(config.market, TAPES);
    const result = execute(tape, config);
    const metrics = computeMetrics(result);
    const html = renderHtmlReport(result, metrics, { currency: tape.instrument.currency });

    swapIn(html);
    wireCharts(result);
    document.title = `${describeConfig(config)} · Tapedeck report`;

    banner.innerHTML =
      `<span><strong>${t('report.yours', 'Your run.')}</strong> ${describeConfig(config)}. ` +
      `${t('report.yoursTail', "Recomputed in this tab from the same kernel and the same tape, so these are the demo's numbers to the cent.")}</span>` +
      `<button class="btn btn--ghost btn--small" id="download" type="button" hidden>${t('report.download', 'Download')}</button>` +
      `<a class="btn btn--ghost btn--small" href="../demo/">${t('report.back', 'Back to the demo')}</a>`;
    offerDownload(html, config);
  } catch (error: unknown) {
    banner.className = 'report-banner is-error';
    banner.textContent = `${t('report.failed', 'Could not compute that run:')} ${String(error)}`;
  }
}

void boot().catch((error: unknown) => {
  el('banner').textContent = String(error);
});
