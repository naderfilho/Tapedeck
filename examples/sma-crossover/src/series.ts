/**
 * A deterministic synthetic price series.
 *
 * Phase 1 has no data adapters yet, and real B3 data cannot be redistributed, so the example runs
 * on a seeded random walk with a slow drift cycle. It is labelled synthetic everywhere it appears:
 * a strategy result computed on invented prices says something about the *engine*, and nothing at
 * all about the strategy. Real BTCUSDT fixtures arrive with the data adapters in phase 3.
 */

import {
  type BarChunk,
  type Instrument,
  BarChunkBuilder,
  MICROS_PER_MINUTE,
  asDuration,
  createRng,
  fromIso,
  roundToTick,
} from '@tapedeck/core';

export interface SeriesOptions {
  readonly instrument: Instrument;
  readonly bars: number;
  /** Starting price as a decimal string, in the instrument's own units. */
  readonly startPrice: number;
  readonly seed?: number;
  readonly timeframe?: number;
  readonly startTs?: number;
}

export function syntheticSeries(options: SeriesOptions): BarChunk {
  const { instrument, bars: count } = options;
  const timeframe = options.timeframe ?? MICROS_PER_MINUTE;
  const startTs = options.startTs ?? fromIso('2026-01-01T00:00:00.000Z');
  const rng = createRng(options.seed ?? 20260825, 'synthetic-series');
  const builder = new BarChunkBuilder(instrument.id, asDuration(timeframe), count);

  const tick = instrument.tickSize;
  let price = roundToTick(options.startPrice, tick);

  for (let i = 0; i < count; i++) {
    // A slow sine gives the crossover something to cross; the noise makes it work for it.
    const drift = Math.sin(i / 120) * 4;
    const shock = (rng.nextFloat() - 0.5) * 8;
    const open = price;
    const close = Math.max(tick, roundToTick(open + drift + shock, tick));
    const wick = roundToTick(Math.abs(shock) + tick, tick, 'up');
    const high = Math.max(open, close) + wick;
    const low = Math.max(tick, Math.min(open, close) - wick);
    const volume = 500 + rng.nextInt(0, 500);

    const openTs = startTs + i * timeframe;
    builder.push(openTs, openTs + timeframe, open, high, low, close, volume);
    price = close;
  }

  return builder.build();
}
