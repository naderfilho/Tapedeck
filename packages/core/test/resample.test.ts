import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type BarChunk,
  type InstrumentId,
  BarChunkBuilder,
  ConfigError,
  MICROS_PER_HOUR,
  asDuration,
  resampleBars,
  validateBarChunk,
} from '@tapedeck/core';

const ZERO = 0 as InstrumentId;
const HOUR = asDuration(MICROS_PER_HOUR);

/** Hourly bars starting at midnight of the epoch, so bucket boundaries are easy to read. */
function hourly(rows: readonly (readonly [number, number, number, number, number])[]): BarChunk {
  const builder = new BarChunkBuilder(ZERO, HOUR, Math.max(1, rows.length));
  rows.forEach(([o, h, l, c, v], i) => {
    const openTs = i * MICROS_PER_HOUR;
    builder.push(openTs, openTs + MICROS_PER_HOUR, o, h, l, c, v);
  });
  return builder.build();
}

/** A generated hourly tape whose OHLC is always internally consistent. */
const tapeArb = fc
  .array(
    fc.record({
      base: fc.integer({ min: 100, max: 100_000 }),
      up: fc.integer({ min: 0, max: 500 }),
      down: fc.integer({ min: 0, max: 500 }),
      openOffset: fc.integer({ min: 0, max: 500 }),
      closeOffset: fc.integer({ min: 0, max: 500 }),
      volume: fc.integer({ min: 0, max: 1_000_000 }),
    }),
    { minLength: 1, maxLength: 200 },
  )
  .map((rows) =>
    hourly(
      rows.map((row) => {
        const low = row.base;
        const high = row.base + row.up + row.down;
        const open = Math.min(low + row.openOffset, high);
        const close = Math.min(low + row.closeOffset, high);
        return [open, high, low, close, row.volume] as const;
      }),
    ),
  );

describe('resampleBars', () => {
  it('aggregates four hourly bars into one four-hour bar', () => {
    const chunk = hourly([
      [100, 110, 95, 105, 10],
      [105, 120, 100, 118, 20],
      [118, 119, 90, 92, 30],
      [92, 130, 91, 125, 40],
    ]);

    const {
      chunk: out,
      droppedTrailingBars,
      partialBuckets,
    } = resampleBars(chunk, asDuration(4 * MICROS_PER_HOUR));

    expect(out.count).toBe(1);
    expect(out.open[0]).toBe(100); // the first bar's open
    expect(out.high[0]).toBe(130); // the highest high
    expect(out.low[0]).toBe(90); // the lowest low
    expect(out.close[0]).toBe(125); // the last bar's close
    expect(out.volume[0]).toBe(100); // the sum
    expect(out.openTs[0]).toBe(0);
    expect(out.closeTs[0]).toBe(4 * MICROS_PER_HOUR);
    expect(out.timeframe).toBe(4 * MICROS_PER_HOUR);
    expect(droppedTrailingBars).toBe(0);
    expect(partialBuckets).toBe(0);
  });

  it('drops a trailing bucket the tape has not finished, rather than publishing a forming bar', () => {
    // Six hourly bars is one complete 4h bar and half of the next one. Publishing that half would
    // hand a strategy a bar the market was still printing.
    const chunk = hourly(
      Array.from({ length: 6 }, (_, i) => [100 + i, 110 + i, 90 + i, 105 + i, 1] as const),
    );

    const result = resampleBars(chunk, asDuration(4 * MICROS_PER_HOUR));

    expect(result.chunk.count).toBe(1);
    expect(result.droppedTrailingBars).toBe(2);
    expect(result.partialBuckets).toBe(0);
  });

  it('keeps a bucket with a gap in the middle of the tape, and counts it', () => {
    // A venue that printed no candle for 02:00 still printed the other three. The bar is real and
    // it is short a print, which is a fact about the tape the caller has to be able to see.
    const builder = new BarChunkBuilder(ZERO, HOUR, 8);
    for (const hour of [0, 1, 3, 4, 5, 6, 7]) {
      const openTs = hour * MICROS_PER_HOUR;
      builder.push(openTs, openTs + MICROS_PER_HOUR, 100, 110, 90, 105, 1);
    }

    const result = resampleBars(builder.build(), asDuration(4 * MICROS_PER_HOUR));

    expect(result.chunk.count).toBe(2);
    expect(result.partialBuckets).toBe(1);
    expect(result.droppedTrailingBars).toBe(0);
  });

  it('aligns buckets to the epoch rather than to the first bar', () => {
    // A tape that starts at 02:00 belongs to the 00:00–04:00 bar, and the bar it produces is the
    // one every chart draws. Starting the bucket at 02:00 would invent a series of its own.
    const builder = new BarChunkBuilder(ZERO, HOUR, 8);
    for (let hour = 2; hour < 8; hour++) {
      const openTs = hour * MICROS_PER_HOUR;
      builder.push(openTs, openTs + MICROS_PER_HOUR, 100, 110, 90, 105, 1);
    }

    const result = resampleBars(builder.build(), asDuration(4 * MICROS_PER_HOUR));

    expect(result.chunk.openTs[0]).toBe(0);
    expect(result.chunk.count).toBe(2);
    // The 00:00 bucket only ever saw two of its four hours: the tape starts inside it.
    expect(result.partialBuckets).toBe(1);
  });

  it('returns the same chunk when the timeframe is unchanged', () => {
    const chunk = hourly([[100, 110, 95, 105, 10]]);
    expect(resampleBars(chunk, HOUR).chunk).toBe(chunk);
  });

  it('refuses a target that is not a whole multiple of the source', () => {
    const chunk = hourly([[100, 110, 95, 105, 10]]);
    expect(() => resampleBars(chunk, asDuration(90 * 60 * 1_000_000))).toThrow(ConfigError);
    expect(() => resampleBars(chunk, asDuration(MICROS_PER_HOUR / 2))).toThrow(ConfigError);
  });

  it('refuses a chunk that does not say what its own bars are', () => {
    // A tick chunk built into bars by hand, or a decoder that forgot the header field: without a
    // source timeframe there is no ratio, and every bucket would silently contain one bar.
    const builder = new BarChunkBuilder(ZERO, asDuration(0), 4);
    builder.push(0, MICROS_PER_HOUR, 100, 110, 90, 105, 1);
    expect(() => resampleBars(builder.build(), asDuration(MICROS_PER_HOUR))).toThrow(ConfigError);
  });

  it('produces a chunk the engine will accept, for any tape', () => {
    fc.assert(
      fc.property(tapeArb, fc.constantFrom(2, 3, 4, 6, 12, 24), (chunk, multiple) => {
        const result = resampleBars(chunk, asDuration(multiple * MICROS_PER_HOUR));
        validateBarChunk(result.chunk);
      }),
      { numRuns: 200 },
    );
  });

  it('preserves the extremes and the volume of the bars it consumed', () => {
    fc.assert(
      fc.property(tapeArb, fc.constantFrom(2, 4, 6, 12, 24), (chunk, multiple) => {
        const timeframe = multiple * MICROS_PER_HOUR;
        const result = resampleBars(chunk, asDuration(timeframe));

        for (let i = 0; i < result.chunk.count; i++) {
          const start = result.chunk.openTs[i] ?? 0;
          const end = start + timeframe;
          let high = -Infinity;
          let low = Infinity;
          let volume = 0;
          let first = -1;
          let last = -1;
          for (let j = 0; j < chunk.count; j++) {
            const ts = chunk.openTs[j] ?? 0;
            if (ts < start || ts >= end) continue;
            if (first === -1) first = j;
            last = j;
            high = Math.max(high, chunk.high[j] ?? 0);
            low = Math.min(low, chunk.low[j] ?? 0);
            volume += chunk.volume[j] ?? 0;
          }
          expect(result.chunk.high[i]).toBe(high);
          expect(result.chunk.low[i]).toBe(low);
          expect(result.chunk.volume[i]).toBe(volume);
          expect(result.chunk.open[i]).toBe(chunk.open[first] ?? 0);
          expect(result.chunk.close[i]).toBe(chunk.close[last] ?? 0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('is associative: 1h to 4h to 12h is the same series as 1h to 12h', () => {
    // The property that makes a timeframe picker safe. If it did not hold, which route the page
    // took to a daily bar would change the bar, and two visitors could see different candles.
    fc.assert(
      fc.property(tapeArb, (chunk) => {
        const direct = resampleBars(chunk, asDuration(12 * MICROS_PER_HOUR)).chunk;
        const viaFour = resampleBars(
          resampleBars(chunk, asDuration(4 * MICROS_PER_HOUR)).chunk,
          asDuration(12 * MICROS_PER_HOUR),
        ).chunk;

        expect(viaFour.count).toBe(direct.count);
        for (let i = 0; i < direct.count; i++) {
          expect(viaFour.openTs[i]).toBe(direct.openTs[i]);
          expect(viaFour.open[i]).toBe(direct.open[i]);
          expect(viaFour.high[i]).toBe(direct.high[i]);
          expect(viaFour.low[i]).toBe(direct.low[i]);
          expect(viaFour.close[i]).toBe(direct.close[i]);
          expect(viaFour.volume[i]).toBe(direct.volume[i]);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('never publishes a bar that reaches past the end of the source tape', () => {
    fc.assert(
      fc.property(tapeArb, fc.constantFrom(2, 4, 24), (chunk, multiple) => {
        const result = resampleBars(chunk, asDuration(multiple * MICROS_PER_HOUR));
        const lastSourceClose = chunk.closeTs[chunk.count - 1] ?? 0;
        for (let i = 0; i < result.chunk.count; i++) {
          expect(result.chunk.closeTs[i] ?? 0).toBeLessThanOrEqual(lastSourceClose);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('accounts for every source bar exactly once', () => {
    fc.assert(
      fc.property(tapeArb, fc.constantFrom(2, 3, 4, 24), (chunk, multiple) => {
        const result = resampleBars(chunk, asDuration(multiple * MICROS_PER_HOUR));
        let volume = 0;
        for (let i = 0; i < result.chunk.count; i++) volume += result.chunk.volume[i] ?? 0;

        let dropped = 0;
        for (let i = chunk.count - result.droppedTrailingBars; i < chunk.count; i++) {
          dropped += chunk.volume[i] ?? 0;
        }
        let total = 0;
        for (let i = 0; i < chunk.count; i++) total += chunk.volume[i] ?? 0;

        expect(volume + dropped).toBe(total);
      }),
      { numRuns: 200 },
    );
  });
});
