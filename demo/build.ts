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

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/** The same mark the two hand-written pages carry, so the three headers are one header. */
const BRAND_MARK =
  '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
  '<rect x="0.75" y="3.75" width="18.5" height="12.5" rx="3" stroke="currentColor" stroke-width="1.5"/>' +
  '<circle cx="6.6" cy="10" r="2.1" stroke="currentColor" stroke-width="1.5"/>' +
  '<circle cx="13.4" cy="10" r="2.1" stroke="currentColor" stroke-width="1.5"/></svg>';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const site = resolve(root, 'site');
const src = (p: string): string => resolve(root, p);

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

cpSync(resolve(here, 'index.html'), resolve(site, 'demo/index.html'));
cpSync(resolve(here, 'site.css'), resolve(site, 'assets/site.css'));
cpSync(src('fixtures/binance-BTCUSDT-1h.tape'), resolve(site, 'demo/btcusdt-1h.tape'));

const bundle = readFileSync(resolve(site, 'demo/demo.js'));
const inputs = Object.keys(result.metafile.inputs).length;
console.log(
  `demo: ${(bundle.byteLength / 1024).toFixed(0)} KiB from ${String(inputs)} modules, ` +
    `no runtime dependencies bundled`,
);

// The landing page's numbers are substituted so they cannot drift from the repository.
const tests = /tests-(\d+)/.exec(readFileSync(src('README.md'), 'utf8'))?.[1] ?? '0';
const adrs = readFileSync(src('docs/adr/README.md'), 'utf8').match(/^\| \[\d{4}\]/gm)?.length ?? 0;

writeFileSync(
  resolve(site, 'index.html'),
  fill(readFileSync(resolve(here, 'landing.html'), 'utf8'), {
    tests,
    adrs: String(adrs),
  }),
  'utf8',
);
console.log(`landing: written (${tests} tests, ${String(adrs)} ADRs)`);

// The static report, as the site serves it: the generated file plus a way back to the site.
const report = resolve(root, 'out/report.html');
if (!existsSync(report)) {
  throw new Error(
    `${report} does not exist. Run \`node examples/sma-crossover/src/main.ts\` first — the ` +
      `published report is regenerated from the committed fixture, never uploaded by hand.`,
  );
}

mkdirSync(resolve(site, 'report'), { recursive: true });
writeFileSync(resolve(site, 'report/index.html'), withSiteChrome(readFileSync(report, 'utf8')));
cpSync(resolve(root, 'out/metrics.json'), resolve(site, 'report/metrics.json'));
console.log('report: copied with the site header');

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
    '@media (max-width:640px){.site-nav a.optional{display:none}}' +
    '</style>';

  const bar =
    '<header class="site-topbar"><div class="site-topbar__inner">' +
    `<a class="site-brand" href="../">${BRAND_MARK}Tapedeck</a>` +
    '<nav class="site-nav">' +
    '<a href="../demo/">Demo</a>' +
    '<a href="./" aria-current="page">Report</a>' +
    '<a class="optional" href="../bench.txt">Benchmark</a>' +
    '<a href="https://github.com/naderfilho/Tapedeck">GitHub</a>' +
    '</nav></div></header>';

  return html
    .replace(head, `</style>\n${style}\n</head>`)
    .replace(anchor, `<body>\n${bar}\n<main>`);
}
