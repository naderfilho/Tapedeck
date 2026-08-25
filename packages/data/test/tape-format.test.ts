import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  type BarChunk,
  type InstrumentId,
  type InstrumentSpec,
  BarChunkBuilder,
  INSTRUMENTS,
  MICROS_PER_HOUR,
  MarketDataError,
  TickChunkBuilder,
  asDuration,
  validateBarChunk,
} from '@tapedeck/core';
import { decodeBarTape, decodeTickTape, encodeBarTape, encodeTickTape } from '../src/index.ts';

const SPEC: InstrumentSpec = INSTRUMENTS.BTCUSDT;
const ZERO = 0 as InstrumentId;

function sampleBars(count: number): BarChunk {
  const builder = new BarChunkBuilder(ZERO, asDuration(MICROS_PER_HOUR), Math.max(1, count));
  for (let i = 0; i < count; i++) {
    const openTs = i * MICROS_PER_HOUR;
    const base = 7_000_000 + i * 137;
    builder.push(openTs, openTs + MICROS_PER_HOUR, base, base + 500, base - 400, base + 60, 1_000 + i);
  }
  return builder.build();
}

describe('bar tapes', () => {
  it('round-trips every column exactly', () => {
    const chunk = sampleBars(500);
    const file = decodeBarTape(encodeBarTape({ instrument: SPEC, chunk, source: 'test' }));

    expect(file.chunk.count).toBe(500);
    expect(Array.from(file.chunk.open)).toEqual(Array.from(chunk.open));
    expect(Array.from(file.chunk.high)).toEqual(Array.from(chunk.high));
    expect(Array.from(file.chunk.low)).toEqual(Array.from(chunk.low));
    expect(Array.from(file.chunk.close)).toEqual(Array.from(chunk.close));
    expect(Array.from(file.chunk.volume)).toEqual(Array.from(chunk.volume));
    expect(Array.from(file.chunk.openTs)).toEqual(Array.from(chunk.openTs));
    expect(Array.from(file.chunk.closeTs)).toEqual(Array.from(chunk.closeTs));
    expect(() => {
      validateBarChunk(file.chunk);
    }).not.toThrow();
  });

  it('carries the instrument and the provenance in a readable header', () => {
    const bytes = encodeBarTape({
      instrument: SPEC,
      chunk: sampleBars(3),
      source: 'binance:BTCUSDT:1h',
      createdBy: 'tapedeck-test',
    });
    const file = decodeBarTape(bytes);

    expect(file.instrument).toEqual(SPEC);
    expect(file.header.kind).toBe('bars');
    expect(file.header.source).toBe('binance:BTCUSDT:1h');
    expect(file.header.createdBy).toBe('tapedeck-test');
    expect(file.header.timeframe).toBe(MICROS_PER_HOUR);

    // The header is plain JSON on purpose: looking at the first bytes of a file should tell you
    // what you are holding.
    expect(Buffer.from(bytes.buffer, bytes.byteOffset, 64).toString('ascii')).toContain('TAPEDCK1');
  });

  it('stamps the instrument id the caller asked for', () => {
    const bytes = encodeBarTape({ instrument: SPEC, chunk: sampleBars(2), source: 'test' });
    expect(decodeBarTape(bytes, 3 as InstrumentId).chunk.instrumentId).toBe(3);
  });

  it('handles an empty chunk', () => {
    const chunk = new BarChunkBuilder(ZERO, asDuration(MICROS_PER_HOUR)).build();
    const file = decodeBarTape(encodeBarTape({ instrument: SPEC, chunk, source: 'test' }));
    expect(file.chunk.count).toBe(0);
    expect(file.chunk.open).toHaveLength(0);
  });

  it('reads correctly from a buffer that is not eight-byte aligned', () => {
    // Node pools small buffers, so a file read can land on any byte offset; a `Float64Array` view
    // requires an aligned start, and the decoder must copy rather than throw.
    const bytes = encodeBarTape({ instrument: SPEC, chunk: sampleBars(20), source: 'test' });
    const padded = new Uint8Array(bytes.byteLength + 3);
    padded.set(bytes, 3);
    const misaligned = padded.subarray(3);
    expect(misaligned.byteOffset % 8).not.toBe(0);

    const file = decodeBarTape(misaligned);
    expect(Array.from(file.chunk.close)).toEqual(Array.from(sampleBars(20).close));
  });

  it('survives any chunk a builder can produce', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            base: fc.integer({ min: 1, max: 50_000_000 }),
            span: fc.integer({ min: 0, max: 5_000 }),
            volume: fc.integer({ min: 0, max: 1_000_000 }),
          }),
          { maxLength: 200 },
        ),
        (rows) => {
          const builder = new BarChunkBuilder(ZERO, asDuration(MICROS_PER_HOUR), rows.length + 1);
          rows.forEach((row, i) => {
            const openTs = i * MICROS_PER_HOUR;
            builder.push(
              openTs,
              openTs + MICROS_PER_HOUR,
              row.base,
              row.base + row.span,
              row.base,
              row.base + row.span,
              row.volume,
            );
          });
          const original = builder.build();
          const decoded = decodeBarTape(
            encodeBarTape({ instrument: SPEC, chunk: original, source: 'test' }),
          ).chunk;
          expect(Array.from(decoded.high)).toEqual(Array.from(original.high));
          expect(Array.from(decoded.volume)).toEqual(Array.from(original.volume));
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('tick tapes', () => {
  it('round-trips prices, sizes and the aggressor column', () => {
    const builder = new TickChunkBuilder(ZERO, 4);
    builder.push(1_000, 7_000_000, 5, 1);
    builder.push(2_000, 7_000_100, 3, -1);
    builder.push(3_000, 7_000_050, 1, 0);
    const chunk = builder.build();

    const file = decodeTickTape(encodeTickTape({ instrument: SPEC, chunk, source: 'test' }));
    expect(file.header.kind).toBe('ticks');
    expect(Array.from(file.chunk.ts)).toEqual([1_000, 2_000, 3_000]);
    expect(Array.from(file.chunk.price)).toEqual([7_000_000, 7_000_100, 7_000_050]);
    expect(Array.from(file.chunk.aggressor)).toEqual([1, -1, 0]);
  });
});

describe('rejecting damaged files', () => {
  it('refuses a file that is not a tape', () => {
    expect(() => decodeBarTape(new TextEncoder().encode('not a tape at all, really'))).toThrow(
      MarketDataError,
    );
  });

  it('refuses a file too short to hold a header', () => {
    expect(() => decodeBarTape(new Uint8Array(4))).toThrow(/too short/);
  });

  it('refuses a truncated file rather than reading past the end', () => {
    const bytes = encodeBarTape({ instrument: SPEC, chunk: sampleBars(100), source: 'test' });
    expect(() => decodeBarTape(bytes.subarray(0, bytes.byteLength - 64))).toThrow(/truncated/);
  });

  it('refuses a header that is not JSON', () => {
    const bytes = encodeBarTape({ instrument: SPEC, chunk: sampleBars(2), source: 'test' });
    const damaged = Uint8Array.from(bytes);
    damaged[13] = 0x7b; // turn the header into something JSON cannot parse
    expect(() => decodeBarTape(damaged)).toThrow(/not valid JSON/);
  });

  it('refuses to read a tick tape as bars', () => {
    const builder = new TickChunkBuilder(ZERO, 1);
    builder.push(1, 2, 3, 0);
    const bytes = encodeTickTape({ instrument: SPEC, chunk: builder.build(), source: 'test' });
    expect(() => decodeBarTape(bytes)).toThrow(/expected a bar tape/);
  });
});
