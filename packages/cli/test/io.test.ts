/**
 * The real IO adapter, exercised against a real temporary directory.
 *
 * Everything else in the CLI is tested against a fake filesystem, which is only worth doing if the
 * real one has been checked at least once.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeIo } from '../src/index.ts';

const directory = mkdtempSync(join(tmpdir(), 'tapedeck-io-'));
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

function capture(stream: 'stdout' | 'stderr', run: () => void): string {
  const target = process[stream];
  const original = target.write.bind(target);
  let captured = '';
  target.write = (chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  };
  try {
    run();
  } finally {
    target.write = original;
  }
  return captured;
}

describe('nodeIo', () => {
  it('writes a file, creating the directories it needs', () => {
    const path = join(directory, 'nested', 'deeper', 'out.txt');
    nodeIo.writeFile(path, 'hello');
    expect(readFileSync(path, 'utf8')).toBe('hello');
  });

  it('writes bytes as bytes', () => {
    const path = join(directory, 'bytes.bin');
    nodeIo.writeFile(path, new Uint8Array([1, 2, 3]));
    expect(Array.from(readFileSync(path))).toEqual([1, 2, 3]);
  });

  it('reads a file back', () => {
    const path = join(directory, 'read.txt');
    writeFileSync(path, 'contents', 'utf8');
    expect(Buffer.from(nodeIo.readFile(path)).toString('utf8')).toBe('contents');
  });

  it('imports a module from a path, which is how a strategy is loaded', async () => {
    const path = join(directory, 'strategy.mjs');
    writeFileSync(path, 'export default function factory() { return { id: "loaded" }; }\n', 'utf8');
    const module = await nodeIo.importModule(path);
    expect(typeof module['default']).toBe('function');
  });

  it('sends its output to the right stream', () => {
    expect(
      capture('stdout', () => {
        nodeIo.log('to stdout');
      }),
    ).toBe('to stdout\n');
    expect(
      capture('stderr', () => {
        nodeIo.error('to stderr');
      }),
    ).toBe('to stderr\n');
  });
});
