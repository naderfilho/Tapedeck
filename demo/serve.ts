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
  response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
  createReadStream(path).pipe(response);
}).listen(port, () => {
  console.log(`site/ on http://localhost:${String(port)}/`);
});
