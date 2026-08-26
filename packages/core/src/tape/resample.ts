/**
 * Aggregating a tape onto a slower clock.
 *
 * A year of hourly candles is also a year of four-hourly candles and a year of daily ones, so the
 * slower series are derived rather than downloaded. The arithmetic is exact — a maximum, a minimum,
 * a first, a last and a sum over integers — so a resampled tape is as fixed-point as the one it came
 * from, and no price is averaged into existence.
 *
 * Two rules:
 *
 * - **Buckets are aligned to the epoch, not to the first bar.** A 4h bar starting at 00:00 UTC is
 *   the bar every venue and every chart means by "4h". Starting the first bucket wherever the tape
 *   happens to begin would produce a series that agrees with nothing, including itself after the
 *   file is re-cut.
 * - **A trailing bucket the source does not cover is dropped**, for the same reason the data
 *   providers drop a candle whose close lies past the requested end: it would hand a strategy a bar
 *   the market had not finished printing.
 *
 * Interior gaps are different. A bucket missing a source bar in the middle of the tape is all the
 * venue printed, so it is kept and counted in {@link ResampleResult.partialBuckets} for the caller
 * to report.
 */

import type { Duration } from '../time/timestamp.ts';
import { ConfigError } from '../util/errors.ts';
import { type BarChunk, BarChunkBuilder } from './chunk.ts';

export interface ResampleResult {
  readonly chunk: BarChunk;
  /** Source bars at the end that did not complete their bucket, and were left out. */
  readonly droppedTrailingBars: number;
  /**
   * Buckets built from fewer source bars than the ratio implies — a gap in the tape, not an error.
   * The bar is real; it just saw less of the market than its neighbours.
   */
  readonly partialBuckets: number;
}

/**
 * Rebuilds a chunk on a slower timeframe.
 *
 * The target must be a whole multiple of the source: 1h into 4h, 1h into 1d. Anything else — 1h
 * into 90m — cannot be assembled from whole source bars, and inventing the boundary would mean
 * inventing prices inside it.
 *
 * Returns the same chunk untouched when the timeframes match, so `resample(x, x.timeframe)` costs
 * nothing.
 */
export function resampleBars(chunk: BarChunk, timeframe: Duration): ResampleResult {
  const source = chunk.timeframe;
  if (source <= 0) {
    throw new ConfigError('the source chunk has no timeframe to resample from', { source });
  }
  if (timeframe < source || timeframe % source !== 0) {
    throw new ConfigError(
      'a resampled timeframe must be a whole multiple of the source timeframe',
      { source, timeframe },
    );
  }
  if (timeframe === source) {
    return { chunk, droppedTrailingBars: 0, partialBuckets: 0 };
  }

  const ratio = timeframe / source;
  const builder = new BarChunkBuilder(
    chunk.instrumentId,
    timeframe,
    Math.ceil(chunk.count / ratio),
  );
  let partialBuckets = 0;

  // One pass, one open bucket. `bucketStart === -1` means "nothing open yet", which no real
  // timestamp can collide with because timestamps here are microseconds since the epoch.
  let bucketStart = -1;
  let bucketEnd = -1;
  let open = 0;
  let high = 0;
  let low = 0;
  let close = 0;
  let volume = 0;
  let closeTs = 0;
  let bars = 0;

  const flush = (): void => {
    if (bars === 0) return;
    if (bars < ratio) partialBuckets++;
    builder.push(bucketStart, closeTs, open, high, low, close, volume);
  };

  for (let i = 0; i < chunk.count; i++) {
    const barOpenTs = chunk.openTs[i] ?? 0;
    const start = Math.floor(barOpenTs / timeframe) * timeframe;

    if (start !== bucketStart) {
      flush();
      bucketStart = start;
      bucketEnd = start + timeframe;
      open = chunk.open[i] ?? 0;
      high = chunk.high[i] ?? 0;
      low = chunk.low[i] ?? 0;
      volume = 0;
      bars = 0;
    } else {
      const barHigh = chunk.high[i] ?? 0;
      const barLow = chunk.low[i] ?? 0;
      if (barHigh > high) high = barHigh;
      if (barLow < low) low = barLow;
    }

    close = chunk.close[i] ?? 0;
    closeTs = chunk.closeTs[i] ?? 0;
    volume += chunk.volume[i] ?? 0;
    bars++;
  }

  // The last bucket is the only one whose shortfall means "still forming" rather than "gap": every
  // earlier one was closed by the arrival of a bar belonging to a later bucket.
  let droppedTrailingBars = 0;
  if (bars > 0 && closeTs >= bucketEnd) {
    flush();
  } else {
    droppedTrailingBars = bars;
  }

  return { chunk: builder.build(), droppedTrailingBars, partialBuckets };
}
