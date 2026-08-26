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
 *
 * The landing page is a real file rather than a template literal, so prettier and an editor's HTML
 * tooling can see it. It carries `{{placeholders}}` for the few numbers that describe the
 * repository, which are substituted here so they cannot drift from it.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/**
 * The monogram, defined once and substituted into every page that shows a header.
 *
 * Drawn rather than embedded: a header slot is 24 pixels, and a raster logo at 24 pixels is a
 * smudge on a retina screen and a halo on a light background wherever its transparency was cut
 * out of a dark original. The T takes `currentColor` so it inverts with the theme; the D keeps the
 * brand blue in both, because that is the part people recognise.
 */
const BRAND_MARK =
  '<svg class="mark" width="24" height="24" viewBox="0 0 100 100" fill="none" aria-hidden="true"><defs><linearGradient id="td-c" x1="52" y1="12" x2="96" y2="88" gradientUnits="userSpaceOnUse"><stop stop-color="var(--brand-1, #6ab8ff)"/><stop offset="1" stop-color="var(--brand-2, #0f4fbd)"/></linearGradient></defs><path d="M54 12h8c20 0 34 16 34 38 0 24-16 42-37 42h-8l5-18h4c11 0 19-11 19-24 0-13-7-21-18-21h-12z" fill="url(#td-c)"/><path d="M8 12h48l-4 17H37L25 88H10l12-59H4z" fill="currentColor"/><path d="M5 82l19-11 17 7 20-18" stroke="var(--brand-line, #3d9bff)" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * The full lockup, for the one place with room for it.
 *
 * Same drawing with the detail put back: the candlesticks inside the bowl of the D and the trend
 * line's nodes. They are the first thing to disappear at header size, which is why the mark above
 * drops them rather than rendering them as three grey specks.
 */
const BRAND_FULL =
  '<svg class="mark-full" width="104" height="104" viewBox="0 0 128 128" fill="none" aria-hidden="true"><defs><linearGradient id="td-f" x1="64" y1="14" x2="122" y2="110" gradientUnits="userSpaceOnUse"><stop stop-color="var(--brand-1, #6ab8ff)"/><stop offset=".55" stop-color="#2b86ec"/><stop offset="1" stop-color="var(--brand-2, #0f4fbd)"/></linearGradient><linearGradient id="td-t" x1="12" y1="14" x2="66" y2="98" gradientUnits="userSpaceOnUse"><stop stop-color="currentColor"/><stop offset="1" stop-color="currentColor" stop-opacity=".78"/></linearGradient></defs><path d="M68 14h9c24 0 43 20 43 47 0 29-20 51-46 51h-9l6-21h4c14 0 24-13 24-29 0-15-9-25-23-25H62z" fill="url(#td-f)"/><path d="M12 14h56l-5 20H47L34 96H16l13-62H7z" fill="url(#td-t)"/><g stroke-linecap="round"><path d="M56 50v22" stroke="currentColor" stroke-width="1.4" opacity=".85"/><rect x="53.6" y="55" width="4.8" height="13" rx="1.2" fill="currentColor" opacity=".85"/><path d="M66 44v22" stroke="var(--brand-line, #3d9bff)" stroke-width="1.4"/><rect x="63.6" y="49" width="4.8" height="13" rx="1.2" fill="var(--brand-line, #3d9bff)"/><path d="M76 38v22" stroke="currentColor" stroke-width="1.4" opacity=".85"/><rect x="73.6" y="43" width="4.8" height="13" rx="1.2" fill="currentColor" opacity=".85"/><path d="M86 32v21" stroke="var(--brand-line, #3d9bff)" stroke-width="1.4"/><rect x="83.6" y="36" width="4.8" height="13" rx="1.2" fill="var(--brand-line, #3d9bff)"/><path d="M96 28v20" stroke="currentColor" stroke-width="1.4" opacity=".85"/><rect x="93.6" y="32" width="4.8" height="12" rx="1.2" fill="currentColor" opacity=".85"/></g><path d="M10 100l22-12 19 7 23-21 22-13" stroke="var(--brand-line, #3d9bff)" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/><g fill="var(--brand-line, #3d9bff)"><circle cx="32" cy="88" r="4.2"/><circle cx="51" cy="95" r="4.2"/><circle cx="74" cy="74" r="4.2"/><circle cx="96" cy="61" r="4.2"/></g></svg>';

/**
 * The tab icon, which cannot inherit anything.
 *
 * A favicon renders against whatever chrome the browser paints, so `currentColor` is no use and the
 * T is pinned to a light grey that survives both. Sixteen pixels of monogram is all the detail
 * there is room for.
 */
const FAVICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<defs><linearGradient id="f" x1="52" y1="14" x2="94" y2="86" gradientUnits="userSpaceOnUse">' +
  '<stop stop-color="#5cb0ff"/><stop offset="1" stop-color="#1358c9"/></linearGradient></defs>' +
  '<path d="M58 14h6c22 0 36 15 36 36S86 86 64 86h-14l4-18h10c11 0 18-8 18-18s-7-18-18-18h-8z" fill="url(#f)"/>' +
  '<path d="M6 14h58l-4 18H44L32 86H12L24 32H2z" fill="#e8eef8"/>' +
  '<path d="M8 78l18-10 16 8 20-18" stroke="#3d9bff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
  '</svg>\n';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const site = resolve(root, 'site');
const src = (p: string): string => resolve(root, p);

// A build that never clears its output publishes whatever the last one left behind. Renaming the
// BTC tape left the old path sitting in `site/` and being served; on a fresh CI clone it would
// have vanished, which is the kind of difference that only ever shows up in production.
rmSync(site, { recursive: true, force: true });
mkdirSync(resolve(site, 'demo'), { recursive: true });
mkdirSync(resolve(site, 'assets'), { recursive: true });

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

// The landing page's only script is its language toggle. It never touches the engine, so it skips
// the workspace aliases the demo bundle needs.
const home = await build({
  entryPoints: [resolve(here, 'src/home.ts')],
  outfile: resolve(site, 'assets/home.js'),
  bundle: true,
  format: 'esm',
  target: 'es2023',
  platform: 'browser',
  minify: true,
  legalComments: 'none',
});
if (home.errors.length > 0) throw new Error('the home bundle failed');

writeFileSync(
  resolve(site, 'demo/index.html'),
  fill(readFileSync(resolve(here, 'index.html'), 'utf8'), {
    brandMark: BRAND_MARK,
    brandFull: BRAND_FULL,
  }),
  'utf8',
);
writeFileSync(resolve(site, 'assets/favicon.svg'), FAVICON, 'utf8');
cpSync(resolve(here, 'site.css'), resolve(site, 'assets/site.css'));

/**
 * The instruments the demo offers, and the only place their list is written down twice — the other
 * is `MARKETS` in `demo/src/main.ts`. A symbol here without a fixture is a 404 the visitor sees, so
 * the copy throws instead of shipping a broken picker.
 */
const TAPES = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
mkdirSync(resolve(site, 'demo/tapes'), { recursive: true });
for (const symbol of TAPES) {
  const from = src(`fixtures/binance-${symbol}-1h.tape`);
  if (!existsSync(from)) {
    throw new Error(`${from} is missing. Run \`corepack pnpm fixtures\` to fetch the tapes.`);
  }
  cpSync(from, resolve(site, `demo/tapes/${symbol}-1h.tape`));
}
console.log(`tapes: ${String(TAPES.length)} instruments copied`);

const bundle = readFileSync(resolve(site, 'demo/demo.js'));
const inputs = Object.keys(result.metafile.inputs).length;
console.log(
  `demo: ${(bundle.byteLength / 1024).toFixed(0)} KiB from ${String(inputs)} modules, ` +
    `no runtime dependencies bundled`,
);

// The landing page's numbers are substituted so they cannot drift from the repository.
const tests = /tests-(\d+)/.exec(readFileSync(src('README.md'), 'utf8'))?.[1] ?? '0';
const adrs = readFileSync(src('docs/adr/README.md'), 'utf8').match(/^\| \[\d{4}\]/gm)?.length ?? 0;

/**
 * The result the landing page quotes, read from the run that just happened.
 *
 * These three figures were typed into the page by hand. That is exactly the failure this project
 * exists to complain about — a published number with no link to the run that produced it, which
 * stays on the page after the run stops producing it. They come out of `out/metrics.json` now, so
 * the landing page cannot claim a profit the report does not show.
 */
interface MetricsJson {
  readonly equity: { readonly netProfit: string };
  readonly costs: { readonly commissionPaid: string; readonly shareOfGross: number };
}
const metricsPath = resolve(root, 'out/metrics.json');
if (!existsSync(metricsPath)) throw new Error(`${metricsPath} does not exist; run the example`);
const metrics = JSON.parse(readFileSync(metricsPath, 'utf8')) as MetricsJson;

const usd = (value: string): string =>
  Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const netProfit = Number(metrics.equity.netProfit);
const commission = Number(metrics.costs.commissionPaid);
const share = metrics.costs.shareOfGross;

writeFileSync(
  resolve(site, 'index.html'),
  fill(readFileSync(resolve(here, 'landing.html'), 'utf8'), {
    brandMark: BRAND_MARK,
    brandFull: BRAND_FULL,
    tests,
    adrs: String(adrs),
    netProfit: usd(metrics.equity.netProfit),
    commission: usd(metrics.costs.commissionPaid),
    grossPnl: usd(String(netProfit + commission)),
    costShare: (share * 100).toFixed(0),
    costSharePrecise: (share * 100).toFixed(1),
  }),
  'utf8',
);
console.log(
  `landing: written (${tests} tests, ${String(adrs)} ADRs, ` +
    `net ${usd(metrics.equity.netProfit)} USDT from the run just replayed)`,
);

// The static report, as the site serves it: the generated file plus a way back to the site.
const report = resolve(root, 'out/report.html');
if (!existsSync(report)) {
  throw new Error(
    `${report} does not exist. Run \`node examples/sma-crossover/src/main.ts\` first — the ` +
      `published report is regenerated from the committed fixture, never uploaded by hand.`,
  );
}

mkdirSync(resolve(site, 'report'), { recursive: true });
const reportBundle = await build({
  entryPoints: [resolve(here, 'src/report.ts')],
  outfile: resolve(site, 'report/report.js'),
  bundle: true,
  format: 'esm',
  target: 'es2023',
  platform: 'browser',
  minify: true,
  legalComments: 'none',
  alias: {
    '@tapedeck/core': src('packages/core/src/index.ts'),
    '@tapedeck/indicators': src('packages/indicators/src/index.ts'),
    '@tapedeck/report': src('packages/report/src/index.ts'),
    '@tapedeck/data/codec': src('packages/data/src/tape-format.ts'),
  },
  define: {
    'process.env.TAPEDECK_STRICT': '"0"',
    'process.env.NODE_ENV': '"production"',
  },
});
if (reportBundle.errors.length > 0) throw new Error('the report bundle failed');

writeFileSync(resolve(site, 'report/index.html'), withSiteChrome(readFileSync(report, 'utf8')));
cpSync(resolve(root, 'out/metrics.json'), resolve(site, 'report/metrics.json'));
console.log('report: copied with the site header and a recomputing script');

/**
 * The benchmark, with the provenance that makes it worth publishing at all.
 *
 * This used to be shell in the Pages workflow, which meant Vercel published a site whose
 * "Benchmark" link 404ed. A throughput number with no date and no machine attached is a boast; the
 * header is the part that makes it a measurement, so it lives here where every deploy runs it.
 */
const bench = resolve(root, 'bench.txt');
if (existsSync(bench)) {
  const commit =
    process.env['VERCEL_GIT_COMMIT_SHA'] ?? process.env['GITHUB_SHA'] ?? 'a local working tree';
  writeFileSync(
    resolve(site, 'bench.txt'),
    [
      'Tapedeck benchmark',
      `run    ${new Date().toISOString()}`,
      `commit ${commit}`,
      `runner ${process.platform}-${process.arch}, node ${process.version}`,
      '',
      readFileSync(bench, 'utf8'),
    ].join('\n'),
    'utf8',
  );
  console.log('bench: published');
} else {
  console.warn(`bench: ${bench} is missing, the site will not carry one (run \`pnpm site:build\`)`);
}

/** Substitutes `{{name}}` placeholders, and refuses to ship a page with one left in it. */
function fill(template: string, values: Readonly<Record<string, string>>): string {
  const out = template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`no value for the placeholder {{${name}}}`);
    return value;
  });
  const leftover = /\{\{\w+\}\}/.exec(out);
  if (leftover !== null) throw new Error(`unsubstituted placeholder ${leftover[0]}`);
  return out;
}

/**
 * Grafts the site's header onto a standalone report.
 *
 * The bar is styled inline rather than linked to `assets/site.css`, because the page it lands on
 * has to keep working as a file on a USB stick with no `assets/` next to it (ADR-0013). It draws
 * its colours from the tokens `renderHtmlReport` already defines, so the header follows whatever
 * theme the report is in instead of pinning one — including the print block, which hides it.
 *
 * Injection rather than a template: the report's markup belongs to `renderHtmlReport`, and this
 * has no business knowing anything about it beyond where `<main>` opens. If that anchor ever stops
 * matching this throws rather than publishing a page with no way out of it.
 */
function withSiteChrome(html: string): string {
  const anchor = '<body>\n<main>';
  const head = '</style>\n</head>';
  for (const marker of [anchor, head]) {
    if (!html.includes(marker)) {
      throw new Error(
        `could not find ${JSON.stringify(marker)} in the report to attach the bar to`,
      );
    }
  }

  const style =
    '<style>' +
    // The bar sits above `main`, which already carries the report's own top padding; without this
    // the page opens with 34px of gap under the header.
    'main{padding-top:26px}' +
    '.site-topbar{position:sticky;top:0;z-index:20;' +
    'background:color-mix(in srgb, var(--bg) 86%, transparent);' +
    'backdrop-filter:saturate(1.6) blur(12px);border-bottom:1px solid var(--line)}' +
    '.site-topbar__inner{max-width:1080px;margin:0 auto;padding:0 24px;height:58px;' +
    'display:flex;align-items:center;gap:20px}' +
    '.site-brand{display:inline-flex;align-items:center;gap:9px;color:var(--ink);' +
    'text-decoration:none;font-weight:650;font-size:15.5px;letter-spacing:-.01em}' +
    '.site-brand svg{display:block}' +
    '.site-nav{display:flex;align-items:center;gap:4px;margin-left:auto}' +
    '.site-nav a{padding:7px 11px;border-radius:8px;color:var(--ink-dim);text-decoration:none;' +
    'font-size:14px;font-weight:550;white-space:nowrap}' +
    '.site-nav a:hover{color:var(--ink);background:var(--panel-2)}' +
    '.site-nav a[aria-current=page]{color:var(--ink);background:var(--panel-2)}' +
    '.langs{display:inline-flex;padding:2px;border:1px solid var(--line);border-radius:8px;' +
    'background:var(--panel-2);margin-left:8px}' +
    '.lang{padding:4px 9px;border:0;border-radius:6px;background:transparent;color:var(--ink-faint);' +
    'font:600 11.5px/1 ui-monospace,Menlo,Consolas,monospace;cursor:pointer}' +
    '.lang[aria-pressed=true]{background:var(--panel);color:var(--ink)}' +
    // The banner says which run is on the page. It is the one part of the report that has to be
    // read before the numbers, which is the same reason the caveats sit where they do.
    '.report-banner{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:center;' +
    'margin:0 0 26px;padding:12px 16px;border:1px solid var(--line);border-radius:12px;' +
    'background:var(--panel);color:var(--ink-dim);font-size:13.5px;line-height:1.5}' +
    '.report-banner:empty{display:none}' +
    '.report-banner span{flex:1;min-width:220px}' +
    '.report-banner strong{color:var(--ink)}' +
    '.report-banner.is-live{border-color:color-mix(in srgb, var(--accent) 45%, var(--line))}' +
    '.report-banner.is-error{border-color:var(--down);color:var(--down)}' +
    '.btn{display:inline-flex;align-items:center;gap:8px;padding:11px 18px;border-radius:8px;' +
    'border:1px solid transparent;font:600 15px/1 inherit;text-decoration:none;cursor:pointer}' +
    '.btn--ghost{border-color:var(--line-strong);color:var(--ink);background:var(--panel)}' +
    '.btn--ghost:hover{border-color:var(--accent);color:var(--accent)}' +
    '.btn--small{padding:7px 12px;font-size:13px}' +
    '@media print{.report-banner{display:none}}' +
    '@media (max-width:640px){.site-nav a.optional{display:none}' +
    '.site-nav{min-width:0;overflow-x:auto;scrollbar-width:none}' +
    '.site-nav a,.site-nav .langs{flex:none}}' +
    '</style>';

  const bar =
    '<header class="site-topbar"><div class="site-topbar__inner">' +
    `<a class="site-brand" href="../">${BRAND_MARK}Tapedeck</a>` +
    '<nav class="site-nav">' +
    '<a href="../demo/">Demo</a>' +
    '<a href="./" aria-current="page">Report</a>' +
    '<a class="optional" href="../bench.txt">Benchmark</a>' +
    '<a href="https://github.com/naderfilho/Tapedeck">GitHub</a>' +
    '<div class="langs" role="group" aria-label="Language">' +
    '<button class="lang" type="button" data-lang="en" aria-pressed="true">EN</button>' +
    '<button class="lang" type="button" data-lang="pt" aria-pressed="false">PT</button>' +
    '</div>' +
    '</nav></div></header>';

  const close = '</main>\n</body>';
  if (!html.includes(close)) {
    throw new Error(`could not find ${JSON.stringify(close)} to attach the report script to`);
  }

  return html
    .replace(head, `</style>\n${style}\n</head>`)
    .replace(anchor, `<body>\n${bar}\n<main>\n  <div id="banner"></div>`)
    .replace(close, '</main>\n<script type="module" src="./report.js"></script>\n</body>');
}
