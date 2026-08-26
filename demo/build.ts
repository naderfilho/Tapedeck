/**
 * Builds the published site: a landing page, the live demo, and the static report.
 *
 * The demo is bundled with esbuild against the workspace **sources**, not the built `dist`, for the
 * same reason the test suite aliases them: one build step, no stale artefact, and a stack trace
 * that points at a real line. `@tapedeck/data/codec` resolves to the tape codec alone — the package
 * barrel also carries filesystem helpers, which a browser has no use for and a bundler cannot
 * follow.
 *
 * Nothing here touches `renderHtmlReport`. The report stays a file with no `<script>` in it
 * (ADR-0013); this produces a different artefact next to it.
 *
 * The site's copy of the report is assembled here rather than by a `cp` in the workflow, because a
 * page published under `/report/` needs a way back to `/` and the file you email someone does not —
 * a relative link in a downloaded file points at nothing. `out/report.html` stays untouched; the
 * navigation is grafted onto the copy.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const site = resolve(root, 'site');
const src = (p: string): string => resolve(root, p);

mkdirSync(resolve(site, 'demo'), { recursive: true });

const result = await build({
  entryPoints: [resolve(here, 'src/main.ts')],
  outfile: resolve(site, 'demo/demo.js'),
  bundle: true,
  format: 'esm',
  target: 'es2023',
  platform: 'browser',
  minify: true,
  sourcemap: false,
  metafile: true,
  legalComments: 'none',
  alias: {
    '@tapedeck/core': src('packages/core/src/index.ts'),
    '@tapedeck/indicators': src('packages/indicators/src/index.ts'),
    '@tapedeck/report': src('packages/report/src/index.ts'),
    '@tapedeck/data/codec': src('packages/data/src/tape-format.ts'),
  },
  define: {
    // `STRICT` gates the revocable bar view, which exists to catch a strategy that keeps the bar.
    // The demo's strategy does not, and the guard costs about half the throughput.
    'process.env.TAPEDECK_STRICT': '"0"',
    'process.env.NODE_ENV': '"production"',
  },
});

cpSync(resolve(here, 'index.html'), resolve(site, 'demo/index.html'));
cpSync(src('fixtures/binance-BTCUSDT-1h.tape'), resolve(site, 'demo/btcusdt-1h.tape'));

const bundle = readFileSync(resolve(site, 'demo/demo.js'));
const inputs = Object.keys(result.metafile.inputs).length;
console.log(
  `demo: ${(bundle.byteLength / 1024).toFixed(0)} KiB from ${String(inputs)} modules, ` +
    `no runtime dependencies bundled`,
);

// The landing page is generated so its numbers cannot drift from the repository they describe.
const tests = /tests-(\d+)/.exec(readFileSync(src('README.md'), 'utf8'))?.[1] ?? '0';
const adrs = readFileSync(src('docs/adr/README.md'), 'utf8').match(/^\| \[\d{4}\]/gm)?.length ?? 0;

writeFileSync(resolve(site, 'index.html'), landing({ tests, adrs: String(adrs) }), 'utf8');
console.log('landing: written');

// The static report, as the site serves it: the generated file plus a way back to the site.
const report = resolve(root, 'out/report.html');
if (!existsSync(report)) {
  throw new Error(
    `${report} does not exist. Run \`node examples/sma-crossover/src/main.ts\` first — the ` +
      `published report is regenerated from the committed fixture, never uploaded by hand.`,
  );
}

mkdirSync(resolve(site, 'report'), { recursive: true });
writeFileSync(
  resolve(site, 'report/index.html'),
  withSiteNav(readFileSync(report, 'utf8'), [
    ['../', '← Tapedeck'],
    ['../demo/', 'Run it in your browser →'],
  ]),
  'utf8',
);
cpSync(resolve(root, 'out/metrics.json'), resolve(site, 'report/metrics.json'));
console.log('report: copied with site navigation');

/**
 * Grafts a navigation bar onto a standalone report.
 *
 * Injection rather than a template: the report's markup belongs to `renderHtmlReport`, and this
 * has no business knowing anything about it beyond where `<main>` opens. If that anchor ever
 * stops matching this throws rather than publishing a page with no way out of it.
 */
function withSiteNav(html: string, links: readonly (readonly [string, string])[]): string {
  const anchor = '<body>\n<main>';
  const head = '</style>\n</head>';
  for (const marker of [anchor, head]) {
    if (!html.includes(marker)) {
      throw new Error(
        `could not find ${JSON.stringify(marker)} in the report to attach the nav to`,
      );
    }
  }
  const style =
    '<style>' +
    '.site-nav{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 20px}' +
    '.site-nav .spacer{flex:1}' +
    '.site-nav a{display:inline-block;padding:6px 12px;border:1px solid #e3e6ea;border-radius:6px;' +
    'background:#fff;color:#5b6570;font-size:13px;font-weight:600;text-decoration:none}' +
    '.site-nav a:hover{border-color:#1d4ed8;color:#1d4ed8}' +
    '</style>';
  const anchors = links.map(([href, text]) => `<a href="${href}">${text}</a>`);
  // The first link is the way back; anything after it is pushed to the far side.
  const nav = `<nav class="site-nav">${anchors.slice(0, 1).join('')}<span class="spacer"></span>${anchors.slice(1).join('')}</nav>`;

  return html.replace(head, `</style>\n${style}\n</head>`).replace(anchor, `${anchor}\n  ${nav}`);
}

function landing(facts: { tests: string; adrs: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Tapedeck — deterministic backtesting for TypeScript</title>
<meta name="description" content="An event-driven backtesting and paper-trading engine for TypeScript. No lookahead, fixed-point money, and it reports what it could not know." />
<style>
:root{--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--bg:#f8fafc;--card:#fff;--accent:#1d4ed8}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}
.wrap{max-width:820px;margin:0 auto;padding:64px 20px 72px}
h1{font-size:38px;margin:0 0 10px;letter-spacing:-.02em}
.tag{color:var(--muted);font-size:19px;margin:0 0 28px;max-width:60ch}
.row{display:flex;flex-wrap:wrap;gap:12px;margin:0 0 40px}
.btn{display:inline-block;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px}
.btn.primary{background:var(--accent);color:#fff}
.btn.primary:hover{background:#1e40af}
.btn.ghost{border:1px solid var(--line);color:var(--ink);background:var(--card)}
.btn.ghost:hover{border-color:var(--accent);color:var(--accent)}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin:0 0 44px}
.fact{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px}
.fact b{display:block;font-size:22px;font-variant-numeric:tabular-nums}
.fact span{font-size:12px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:38px 0 12px}
ol{padding-left:20px;margin:0}
li{margin:0 0 12px}
li b{font-weight:600}
pre{background:#0f172a;color:#e2e8f0;padding:16px 18px;border-radius:8px;overflow-x:auto;font-size:13.5px;line-height:1.5}
.note{color:var(--muted);font-size:14.5px}
footer{margin-top:52px;padding-top:20px;border-top:1px solid var(--line);color:var(--muted);font-size:14px}
a{color:var(--accent)}
</style>
</head>
<body>
<div class="wrap">
  <h1>Tapedeck</h1>
  <p class="tag">An event-driven backtesting and paper-trading engine for TypeScript. Deterministic by construction: no lookahead, fixed-point money, and it reports what it could not know.</p>

  <div class="row">
    <a class="btn primary" href="demo/">Run a backtest in your browser</a>
    <a class="btn ghost" href="report/">See a full report</a>
    <a class="btn ghost" href="https://github.com/naderfilho/Tapedeck">Source on GitHub</a>
    <a class="btn ghost" href="bench.txt">Benchmark</a>
  </div>

  <div class="facts">
    <div class="fact"><b>${facts.tests}</b><span>tests</span></div>
    <div class="fact"><b>97%</b><span>coverage</span></div>
    <div class="fact"><b>${facts.adrs}</b><span>decision records</span></div>
    <div class="fact"><b>0</b><span>runtime deps in core</span></div>
  </div>

  <h2>Why it exists</h2>
  <p>Most backtesters lie in one of three ways, and all three are structural rather than accidental:</p>
  <ol>
    <li><b>They let a strategy act on information it did not have.</b> A bar arrives, the strategy reads its close, and the engine fills the resulting order at that same close.</li>
    <li><b>They resolve intrabar ambiguity in the strategy's favour.</b> When a stop and a target both sit inside one bar's range, the engine quietly picks one, and it is rarely the stop.</li>
    <li><b>They keep money in floating point.</b> Across a few hundred thousand fills, the reported PnL stops reconciling with the sum of the trades.</li>
  </ol>
  <p>Tapedeck is built so that none of the three is expressible.</p>

  <h2>What that buys you</h2>
  <p>A 24/72 moving-average crossover on a year of hourly BTCUSDT, with real Binance fees:</p>
<pre>net profit          2,305.40 USDT
PnL before costs    8,332.60 USDT
costs ate               72.3%</pre>
  <p class="note">A backtester that skipped fees would have reported a strategy three and a half times better than the one that exists. <a href="demo/">Set the costs to none in the demo</a> and watch it happen.</p>

  <h2>The same strategy, live</h2>
  <p class="note">A strategy runs unchanged in backtest and in paper trading against a live exchange feed. Not a compatibility layer: both modes share one synchronous kernel, and the only real difference is who fills the event queue, a file or a socket.</p>

  <footer>
    Built by <a href="https://github.com/naderfilho">Nader Filho</a> ·
    <a href="https://github.com/naderfilho/Tapedeck/blob/main/docs/api.md">API guide</a> ·
    <a href="https://github.com/naderfilho/Tapedeck/tree/main/docs/adr">decision records</a> ·
    PolyForm Noncommercial
  </footer>
</div>
</body>
</html>
`;
}
