import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type InstrumentId,
  BarChunkBuilder,
  INSTRUMENTS,
  MICROS_PER_HOUR,
  MarketDataError,
  TickChunkBuilder,
  asDuration,
} from '@tapedeck/core';
import {
  readBarTapeFile,
  readBarTapeFileSync,
  readTickTapeFile,
  writeBarTapeFile,
  writeBarTapeFileSync,
  writeTickTapeFile,
} from '../src/index.ts';

const directory = mkdtempSync(join(tmpdir(), 'tapedeck-tape-'));
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

const SPEC = INSTRUMENTS.BTCUSDT;
const ZERO = 0 as InstrumentId;

function bars(count: number) {
  const builder = new BarChunkBuilder(ZERO, asDuration(MICROS_PER_HOUR), count);
  for (let i = 0; i < count; i++) {
    const openTs = i * MICROS_PER_HOUR;
    const price = 7_000_000 + i;
    builder.push(openTs, openTs + MICROS_PER_HOUR, price, price + 5, price - 5, price + 1, 100 + i);
  }
  return builder.build();
}

describe('tape files', () => {
  it('round-trips bars asynchronously', async () => {
    const path = join(directory, 'async.tape');
    const chunk = bars(64);
    await writeBarTapeFile(path, { instrument: SPEC, chunk, source: 'test' });

    const file = await readBarTapeFile(path);
    expect(file.chunk.count).toBe(64);
    expect(Array.from(file.chunk.close)).toEqual(Array.from(chunk.close));
    expect(file.instrument.symbol).toBe('BTCUSDT');
  });

  it('round-trips bars synchronously and stamps the requested instrument id', () => {
    const path = join(directory, 'sync.tape');
    writeBarTapeFileSync(path, { instrument: SPEC, chunk: bars(8), source: 'test' });

    const file = readBarTapeFileSync(path, 2 as InstrumentId);
    expect(file.chunk.instrumentId).toBe(2);
    expect(file.chunk.count).toBe(8);
  });

  it('round-trips ticks', async () => {
    const path = join(directory, 'ticks.tape');
    const builder = new TickChunkBuilder(ZERO, 3);
    builder.push(1_000, 7_000_000, 5, 1);
    builder.push(2_000, 7_000_100, 3, -1);
    await writeTickTapeFile(path, { instrument: SPEC, chunk: builder.build(), source: 'test' });

    const file = await readTickTapeFile(path, 1 as InstrumentId);
    expect(file.chunk.count).toBe(2);
    expect(file.chunk.instrumentId).toBe(1);
    expect(Array.from(file.chunk.aggressor)).toEqual([1, -1]);
  });

  it('refuses to read a file that is not a tape', async () => {
    const path = join(directory, 'not-a-tape.txt');
    writeBarTapeFileSync(path, { instrument: SPEC, chunk: bars(1), source: 'test' });
    await expect(readTickTapeFile(path)).rejects.toThrow(MarketDataError);
  });
});
