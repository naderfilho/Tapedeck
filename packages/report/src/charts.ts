/**
 * Hand-rolled SVG charting.
 *
 * There is no chart library here and no `<script>` in the output. A report is a file you can open
 * from a USB stick in five years, email to someone, or attach to a pull request, and every one of
 * those breaks the moment it needs a CDN. Inline SVG is also the only form of chart that survives
 * a print dialogue.
 *
 * The only interesting piece is the downsampling. An equity curve with a million points would
 * produce a path a browser refuses to render, and naive sampling — take every hundredth point —
 * deletes exactly the spikes a risk chart exists to show. Bucketed min/max keeps both extremes of
 * every bucket, so the drawdown you see is the drawdown that happened.
 */

export interface Series {
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly length: number;
}

export interface Bounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/**
 * Reduces a series to at most `buckets * 2` points, keeping the minimum and maximum of every
 * bucket in the order they occurred.
 */
export function downsample(
  xs: Float64Array,
  ys: Float64Array,
  length: number,
  buckets: number,
): Series {
  if (length <= buckets * 2) {
    return { xs: xs.subarray(0, length), ys: ys.subarray(0, length), length };
  }

  const outX = new Float64Array(buckets * 2);
  const outY = new Float64Array(buckets * 2);
  let written = 0;

  for (let bucket = 0; bucket < buckets; bucket++) {
    // Boundaries are computed as `bucket * length / buckets` and not as `bucket * (length /
    // buckets)`. The two are the same in arithmetic and not in floating point: for 52 points in
    // 23 buckets, `23 * (52 / 23)` is 51.99999999999999, so the last bucket ended one short and
    // the final point of the series was never examined. Multiplying first keeps the numerator an
    // exact integer, and the last bucket's end is then exactly `length`.
    const start = Math.floor((bucket * length) / buckets);
    const end = Math.floor(((bucket + 1) * length) / buckets);
    if (end <= start) continue;

    let minIndex = start;
    let maxIndex = start;
    for (let i = start + 1; i < end; i++) {
      const value = ys[i] ?? 0;
      if (value < (ys[minIndex] ?? 0)) minIndex = i;
      if (value > (ys[maxIndex] ?? 0)) maxIndex = i;
    }

    const first = Math.min(minIndex, maxIndex);
    const second = Math.max(minIndex, maxIndex);
    outX[written] = xs[first] ?? 0;
    outY[written] = ys[first] ?? 0;
    written++;
    if (second !== first) {
      outX[written] = xs[second] ?? 0;
      outY[written] = ys[second] ?? 0;
      written++;
    }
  }

  return { xs: outX.subarray(0, written), ys: outY.subarray(0, written), length: written };
}

export function boundsOf(series: Series, padding = 0.02): Bounds {
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < series.length; i++) {
    const value = series.ys[i] ?? 0;
    if (value < minY) minY = value;
    if (value > maxY) maxY = value;
  }
  if (!Number.isFinite(minY)) {
    minY = 0;
    maxY = 1;
  }
  if (minY === maxY) {
    minY -= 1;
    maxY += 1;
  }
  const margin = (maxY - minY) * padding;
  return {
    minX: series.xs[0] ?? 0,
    maxX: series.xs[series.length - 1] ?? 1,
    minY: minY - margin,
    maxY: maxY + margin,
  };
}

export interface Box {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export const CHART_BOX: Box = {
  width: 1000,
  height: 320,
  left: 72,
  right: 16,
  top: 16,
  bottom: 32,
};
export const SMALL_BOX: Box = {
  width: 1000,
  height: 160,
  left: 72,
  right: 16,
  top: 12,
  bottom: 28,
};

export function scaleX(value: number, bounds: Bounds, box: Box): number {
  const span = bounds.maxX - bounds.minX;
  const usable = box.width - box.left - box.right;
  return box.left + (span === 0 ? 0 : ((value - bounds.minX) / span) * usable);
}

export function scaleY(value: number, bounds: Bounds, box: Box): number {
  const span = bounds.maxY - bounds.minY;
  const usable = box.height - box.top - box.bottom;
  return box.top + usable - (span === 0 ? 0 : ((value - bounds.minY) / span) * usable);
}

function round(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

export function linePath(series: Series, bounds: Bounds, box: Box): string {
  if (series.length === 0) return '';
  const parts: string[] = [];
  for (let i = 0; i < series.length; i++) {
    const x = round(scaleX(series.xs[i] ?? 0, bounds, box));
    const y = round(scaleY(series.ys[i] ?? 0, bounds, box));
    parts.push(`${i === 0 ? 'M' : 'L'}${x} ${y}`);
  }
  return parts.join(' ');
}

/** Closes a line down to a baseline value, for a filled area. */
export function areaPath(series: Series, bounds: Bounds, box: Box, baseline: number): string {
  if (series.length === 0) return '';
  const base = round(scaleY(baseline, bounds, box));
  const first = round(scaleX(series.xs[0] ?? 0, bounds, box));
  const last = round(scaleX(series.xs[series.length - 1] ?? 0, bounds, box));
  return `${linePath(series, bounds, box)} L${last} ${base} L${first} ${base} Z`;
}

export interface Tick {
  readonly value: number;
  readonly position: number;
  readonly label: string;
}

/** Evenly spaced ticks. Deliberately not "nice" round numbers: the extremes matter more here. */
export function ticks(
  min: number,
  max: number,
  count: number,
  format: (value: number) => string,
  position: (value: number) => number,
): Tick[] {
  const out: Tick[] = [];
  for (let i = 0; i <= count; i++) {
    const value = min + ((max - min) * i) / count;
    out.push({ value, position: position(value), label: format(value) });
  }
  return out;
}

export interface HistogramBin {
  readonly from: number;
  readonly to: number;
  readonly count: number;
}

/** Equal-width bins over the observed range. Empty input produces no bins rather than one fake one. */
export function histogram(values: readonly number[], binCount: number): HistogramBin[] {
  if (values.length === 0 || binCount < 1) return [];
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const width = (max - min) / binCount;
  const counts = new Array<number>(binCount).fill(0);
  for (const value of values) {
    const index = Math.min(binCount - 1, Math.floor((value - min) / width));
    counts[index] = (counts[index] ?? 0) + 1;
  }
  return counts.map((count, i) => ({ from: min + i * width, to: min + (i + 1) * width, count }));
}
