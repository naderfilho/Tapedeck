/**
 * Everything the commands do to the outside world, behind one interface.
 *
 * The commands are ordinary functions taking this object, so the tests drive them directly and
 * assert on what was written, instead of spawning a process and grepping stdout. A CLI whose only
 * test is "it printed something" is a CLI nobody has actually checked.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface CliIo {
  log(message: string): void;
  error(message: string): void;
  readFile(path: string): Uint8Array;
  writeFile(path: string, contents: string | Uint8Array): void;
  /** Dynamic import, injectable so a test can hand over a strategy without touching the disk. */
  importModule(path: string): Promise<Record<string, unknown>>;
}

export const nodeIo: CliIo = {
  log: (message) => {
    process.stdout.write(`${message}\n`);
  },
  error: (message) => {
    process.stderr.write(`${message}\n`);
  },
  readFile: (path) => readFileSync(path),
  writeFile: (path, contents) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  },
  importModule: async (path) => (await import(pathToFileURL(path).href)) as Record<string, unknown>,
};
