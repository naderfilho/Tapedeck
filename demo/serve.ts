/**
 * A static server for `site/`, so the demo can be looked at before it is published.
 *
 * It exists because the demo fetches the `.tape` over HTTP, which `file://` refuses. Twenty lines
 * of `node:http` rather than a dependency: this serves four file types to one person on localhost,
 * and anything more would be a package to keep up to date for no gain.
 */

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../site', import.meta.url)));
const port = Number(process.env['PORT'] ?? 4173);

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  // Without this the fallback below hands a stylesheet out as `application/octet-stream`, and a
  // browser in standards mode refuses to apply it — the page renders with no styling at all and
  // nothing in the console says why.
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.tape': 'application/octet-stream',
};

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  // `normalize` collapses `..` before the join, so a path cannot climb out of `site/`.
  let path = join(root, normalize(url.pathname));
  if (!path.startsWith(root)) {
    response.writeHead(403).end('forbidden');
    return;
  }
  try {
    if (statSync(path).isDirectory()) path = join(path, 'index.html');
  } catch {
    response.writeHead(404).end('not found');
    return;
  }
  try {
    statSync(path);
  } catch {
    response.writeHead(404).end('not found');
    return;
  }
  response.writeHead(200, {
    'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    // `demo.js` keeps its name across rebuilds, and with no header on it a browser applies
    // heuristic freshness and reuses the bundle it already has. That served a fixed page with a
    // stale script — new stylesheet, old chart code — which looks like the fix not having worked.
    // This server exists to look at what was just built, so it never answers with anything else.
    'cache-control': 'no-store',
  });
  createReadStream(path).pipe(response);
}).listen(port, () => {
  console.log(`site/ on http://localhost:${String(port)}/`);
});
