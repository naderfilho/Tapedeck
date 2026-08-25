import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BarChunk,
  type InstrumentSpec,
  INSTRUMENTS,
  MICROS_PER_HOUR,
  MICROS_PER_MINUTE,
  MarketDataError,
  asDuration,
  asTimestamp,
  fromIso,
} from '@tapedeck/core';
import { CsvBarProvider, parseTimestamp, splitCsvLine } from '../src/index.ts';

const directory = mkdtempSync(join(tmpdir(), 'tapedeck-csv-'));
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

let fileCounter = 0;
function writeCsv(contents: string): string {
  const path = join(directory, `bars-${String(fileCounter++)}.csv`);
  writeFileSync(path, contents, 'utf8');
  return path;
}

const SPEC: InstrumentSpec = INSTRUMENTS.BTCUSDT;

async function readAll(provider: CsvBarProvider, options: {
  from?: number;
  to?: number;
  chunkSize?: number;
}): Promise<BarChunk[]> {
  const chunks: BarChunk[] = [];
  for await (const chunk of provider.bars({
    symbol: 'BTCUSDT',
    timeframe: asDuration(MICROS_PER_HOUR),
    from: asTimestamp(options.from ?? 0),
    to: asTimestamp(options.to ?? Number.MAX_SAFE_INTEGER),
    chunkSize: options.chunkSize,
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('splitCsvLine', () => {
  it('splits plain fields', () => {
    expect(splitCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
    expect(splitCsvLine('a;b', ';')).toEqual(['a', 'b']);
  });

  it('respects quoted fields that contain the delimiter', () => {
    expect(splitCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
  });

  it('unescapes a doubled quote inside a quoted field', () => {
    expect(splitCsvLine('a,"say ""hi""",c')).toEqual(['a', 'say "hi"', 'c']);
  });

  it('keeps empty fields rather than dropping them', () => {
    expect(splitCsvLine('a,,c')).toEqual(['a', '', 'c']);
    expect(splitCsvLine(',')).toEqual(['', '']);
  });
});

describe('parseTimestamp', () => {
  it('accepts each supported unit', () => {
    expect(parseTimestamp('1', 's')).toBe(1_000_000);
    expect(parseTimestamp('1000', 'ms')).toBe(1_000_000);
    expect(parseTimestamp('1000000', 'us')).toBe(1_000_000);
    expect(parseTimestamp('2026-01-01T00:00:00.000Z', 'iso')).toBe(fromIso('2026-01-01T00:00:00.000Z'));
  });

  it('rejects something that is not a number', () => {
    expect(() => parseTimestamp('yesterday', 'ms')).toThrow(MarketDataError);
  });
});

describe('CsvBarProvider', () => {
  const hourMs = 3_600_000;
  const startMs = fromIso('2026-01-01T00:00:00.000Z') / 1_000;

  it('reads bars and converts prices exactly', async () => {
    const path = writeCsv(
      [
        'timestamp,open,high,low,close,volume',
        `${String(startMs)},70000.12,70500.99,69000.01,70123.45,12.34567`,
        `${String(startMs + hourMs)},70123.45,71000.00,70000.00,70900.10,8.5`,
      ].join('\n'),
    );

    const provider = new CsvBarProvider({
      file: path,
      instrument: SPEC,
      timeframe: asDuration(MICROS_PER_HOUR),
    });
    const [chunk] = await readAll(provider, {});

    expect(chunk?.count).toBe(2);
    expect(chunk?.open[0]).toBe(7_000_012);
    expect(chunk?.volume[0]).toBe(1_234_567);
    expect(chunk?.closeTs[0]).toBe((chunk?.openTs[0] ?? 0) + MICROS_PER_HOUR);
    expect(await provider.describe()).toEqual(SPEC);
  });

  it('accepts renamed columns and a different delimiter', async () => {
    const path = writeCsv(
      ['when;o;h;l;c;vol', `${String(startMs)};1.00;2.00;0.50;1.50;10`].join('\n'),
    );
    const provider = new CsvBarProvider({
      file: path,
      instrument: SPEC,
      timeframe: asDuration(MICROS_PER_HOUR),
      delimiter: ';',
      columns: { ts: 'when', open: 'o', high: 'h', low: 'l', close: 'c', volume: 'vol' },
    });
    const [chunk] = await readAll(provider, {});
    expect(chunk?.close[0]).toBe(150);
  });

  it('reads ISO timestamps and treats them as the bar close when told to', async () => {
    const path = writeCsv(
      ['timestamp,open,high,low,close,volume', '2026-01-01T01:00:00.000Z,1,2,0.5,1.5,10'].join('\n'),
    );
    const provider = new CsvBarProvider({
      file: path,
      instrument: SPEC,
      timeframe: asDuration(MICROS_PER_HOUR),
      timestampUnit: 'iso',
      timestampIs: 'close',
    });
    const [chunk] = await readAll(provider, {});
    expect(chunk?.openTs[0]).toBe(fromIso('2026-01-01T00:00:00.000Z'));
    expect(chunk?.closeTs[0]).toBe(fromIso('2026-01-01T01:00:00.000Z'));
  });

  it('keeps only the bars inside the requested range', async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      [String(startMs + i * hourMs), '1', '2', '0.5', '1.5', '10'].join(','),
    );
    const path = writeCsv(['timestamp,open,high,low,close,volume', ...rows].join('\n'));
    const provider = new CsvBarProvider({
      file: path,
      instrument: SPEC,
      timeframe: asDuration(MICROS_PER_HOUR),
    });

    const from = fromIso('2026-01-01T03:00:00.000Z');
    const to = fromIso('2026-01-01T06:00:00.000Z');
    const [chunk] = await readAll(provider, { from, to });
    expect(chunk?.count).toBe(3);
    expect(chunk?.openTs[0]).toBe(from);
  });

  it('yields several chunks for a long file', async () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      [String(startMs + i * hourMs), '1', '2', '0.5', '1.5', '10'].join(','),
    );
    const path = writeCsv(['timestamp,open,high,low,close,volume', ...rows].join('\n'));
    const provider = new CsvBarProvider({
      file: path,
      instrument: SPEC,
      timeframe: asDuration(MICROS_PER_HOUR),
    });
    const chunks = await readAll(provider, { chunkSize: 10 });
    expect(chunks.map((chunk) => chunk.count)).toEqual([10, 10, 5]);
  });

  it('tolerates CRLF line endings and blank lines', async () => {
    const path = writeCsv(
      `timestamp,open,high,low,close,volume\r\n${String(startMs)},1,2,0.5,1.5,10\r\n\r\n`,
    );
    const provider = new CsvBarProvider({
      file: path,
      instrument: SPEC,
      timeframe: asDuration(MICROS_PER_HOUR),
    });
    const [chunk] = await readAll(provider, {});
    expect(chunk?.count).toBe(1);
  });

  it('names the column it could not find', async () => {
    const path = writeCsv(['timestamp,open,high,low,close', `${String(startMs)},1,2,0.5,1.5`].join('\n'));
    const provider = new CsvBarProvider({
      file: path,
      instrument: SPEC,
      timeframe: asDuration(MICROS_PER_HOUR),
    });
    await expect(readAll(provider, {})).rejects.toThrow(/missing the volume column/);
  });

  it('reports the line number when a row is short', async () => {
    const path = writeCsv(
      ['timestamp,open,high,low,close,volume', `${String(startMs)},1,2,0.5`].join('\n'),
    );
    const provider = new CsvBarProvider({
      file: path,
      instrument: SPEC,
      timeframe: asDuration(MICROS_PER_HOUR),
    });
    await expect(readAll(provider, {})).rejects.toThrow(/line 2 has too few columns/);
  });

  it('rejects an empty file rather than reporting zero bars', async () => {
    const path = writeCsv('');
    const provider = new CsvBarProvider({
      file: path,
      instrument: SPEC,
      timeframe: asDuration(MICROS_PER_MINUTE),
    });
    await expect(readAll(provider, {})).rejects.toThrow(/no header row/);
  });
});
