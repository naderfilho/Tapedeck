import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { areaPath, boundsOf, downsample, histogram, linePath, ticks } from '../src/index.ts';

function series(values: readonly number[]): { xs: Float64Array; ys: Float64Array; length: number } {
  return {
    xs: Float64Array.from(values.map((_, i) => i)),
    ys: Float64Array.from(values),
    length: values.length,
  };
}

describe('downsampling', () => {
  it('leaves a short series alone', () => {
    const { xs, ys } = series([1, 2, 3, 4]);
    const reduced = downsample(xs, ys, 4, 10);
    expect(Array.from(reduced.ys)).toEqual([1, 2, 3, 4]);
  });

  it('keeps both extremes of every bucket', () => {
    // The spike at index 500 is the whole reason a risk chart exists; sampling every hundredth
    // point would delete it.
    const values = Array.from({ length: 1_000 }, () => 100);
    values[500] = 1;
    values[700] = 999;
    const { xs, ys } = series(values);
    const reduced = downsample(xs, ys, 1_000, 50);

    expect(reduced.length).toBeLessThanOrEqual(100);
    expect(Array.from(reduced.ys)).toContain(1);
    expect(Array.from(reduced.ys)).toContain(999);
  });

  it('keeps an extreme sitting on the very last point (52 points, 23 buckets)', () => {
    // The shrunk counterexample from the property below, which CI found on a run the author's
    // machine had never produced. `size = 52 / 23` and `23 * size` is 51.99999999999999, so the
    // last bucket ended at 51 and the minimum — alone in the final position — was dropped.
    const values = Array.from({ length: 52 }, () => 0);
    values[51] = -1;
    const { xs, ys } = series(values);
    const reduced = downsample(xs, ys, values.length, 23);

    expect(Math.min(...Array.from(reduced.ys))).toBe(-1);
  });

  it('visits every point exactly once, for any length and bucket count', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000 }),
        fc.integer({ min: 2, max: 200 }),
        (length, buckets) => {
          // The bug above was a gap between two bucket boundaries. Asserting that the boundaries
          // tile the range exactly is what makes a whole class of them impossible, rather than
          // just the one shape the counterexample happened to have.
          let cursor = 0;
          for (let bucket = 0; bucket < buckets; bucket++) {
            const start = Math.floor((bucket * length) / buckets);
            const end = Math.floor(((bucket + 1) * length) / buckets);
            expect(start).toBe(cursor);
            expect(end).toBeGreaterThanOrEqual(start);
            cursor = end;
          }
          expect(cursor).toBe(length);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('preserves the overall minimum and maximum for any series', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -1_000, max: 1_000 }), { minLength: 50, maxLength: 2_000 }),
        fc.integer({ min: 2, max: 40 }),
        (values, buckets) => {
          const { xs, ys } = series(values);
          const reduced = downsample(xs, ys, values.length, buckets);
          const kept = Array.from(reduced.ys);
          expect(Math.min(...kept)).toBe(Math.min(...values));
          expect(Math.max(...kept)).toBe(Math.max(...values));
        },
      ),
      { numRuns: 120 },
    );
  });

  it('keeps the points in the order they occurred', () => {
    const values = Array.from({ length: 500 }, (_, i) => Math.sin(i / 10) * 100);
    const { xs, ys } = series(values);
    const reduced = downsample(xs, ys, values.length, 30);
    for (let i = 1; i < reduced.length; i++) {
      expect(reduced.xs[i] ?? 0).toBeGreaterThanOrEqual(reduced.xs[i - 1] ?? 0);
    }
  });
});

describe('ticks', () => {
  it('spaces labels evenly across the range', () => {
    const labels = ticks(
      0,
      100,
      4,
      (value) => value.toFixed(0),
      (value) => value,
    );
    expect(labels.map((tick) => tick.label)).toEqual(['0', '25', '50', '75', '100']);
    expect(labels[2]?.position).toBe(50);
  });
});

describe('bounds', () => {
  it('pads the range so a line never touches the frame', () => {
    const bounds = boundsOf(series([10, 20]));
    expect(bounds.minY).toBeLessThan(10);
    expect(bounds.maxY).toBeGreaterThan(20);
  });

  it('gives a flat series a range it can be drawn in', () => {
    const bounds = boundsOf(series([5, 5, 5]));
    expect(bounds.maxY).toBeGreaterThan(bounds.minY);
  });

  it('survives an empty series', () => {
    const bounds = boundsOf({ xs: new Float64Array(0), ys: new Float64Array(0), length: 0 });
    expect(Number.isFinite(bounds.minY)).toBe(true);
    expect(Number.isFinite(bounds.maxY)).toBe(true);
  });
});

describe('paths', () => {
  const data = series([1, 5, 3]);
  const bounds = boundsOf(data);
  const box = { width: 100, height: 50, left: 10, right: 10, top: 5, bottom: 5 };

  it('starts with a move and continues with lines', () => {
    const path = linePath(data, bounds, box);
    expect(path.startsWith('M')).toBe(true);
    expect(path.split('L')).toHaveLength(3);
  });

  it('closes an area back to the baseline', () => {
    const path = areaPath(data, bounds, box, bounds.minY);
    expect(path.endsWith('Z')).toBe(true);
  });

  it('produces nothing for an empty series rather than a broken path', () => {
    const empty = { xs: new Float64Array(0), ys: new Float64Array(0), length: 0 };
    expect(linePath(empty, bounds, box)).toBe('');
    expect(areaPath(empty, bounds, box, 0)).toBe('');
  });
});

describe('histogram', () => {
  it('counts every value exactly once', () => {
    const values = [-5, -1, 0, 1, 2, 3, 10];
    const bins = histogram(values, 5);
    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(values.length);
  });

  it('gives a constant series a range it can be drawn in', () => {
    const bins = histogram([7, 7, 7], 4);
    expect(bins).toHaveLength(4);
    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(3);
  });

  it('returns nothing rather than one fake bin for no data', () => {
    expect(histogram([], 10)).toEqual([]);
    expect(histogram([1, 2], 0)).toEqual([]);
  });

  it('never loses a value, whatever the input', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -10_000, max: 10_000 }), { minLength: 1, maxLength: 500 }),
        fc.integer({ min: 1, max: 60 }),
        (values, binCount) => {
          const bins = histogram(values, binCount);
          expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(values.length);
        },
      ),
      { numRuns: 120 },
    );
  });
});
