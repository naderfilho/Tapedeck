import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Ema, Rma, RollingStats, Sma } from '../src/index.ts';

/** Deliberately naive: recomputes the whole window on every call. The reference to beat. */
function naiveMean(values: readonly number[], end: number, period: number): number {
  let sum = 0;
  for (let i = end - period + 1; i <= end; i++) sum += values[i] ?? 0;
  return sum / period;
}

function naiveStdDev(values: readonly number[], end: number, period: number): number {
  const mean = naiveMean(values, end, period);
  let sum = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const deviation = (values[i] ?? 0) - mean;
    sum += deviation * deviation;
  }
  return Math.sqrt(sum / period);
}

/**
 * Compares floats the way floats should be compared: relative to their magnitude.
 *
 * An absolute tolerance is meaningless here — the same implementation would "pass" on prices near
 * one and "fail" on prices near a million while being exactly as accurate.
 */
function expectClose(actual: number | null | undefined, expected: number, relative = 1e-10): void {
  expect(actual).not.toBeNull();
  const tolerance = Math.max(1e-9, Math.abs(expected) * relative);
  expect(Math.abs((actual ?? Number.NaN) - expected)).toBeLessThanOrEqual(tolerance);
}

const series = (options: { min: number; max: number; length?: number }) =>
  fc.array(fc.double({ min: options.min, max: options.max, noNaN: true }), {
    minLength: options.length ?? 40,
    maxLength: 300,
  });

describe('Sma', () => {
  it('is undefined until the window is full', () => {
    const sma = new Sma(3);
    expect(sma.update(1)).toBeNull();
    expect(sma.update(2)).toBeNull();
    expect(sma.ready).toBe(false);
    expect(sma.update(3)).toBe(2);
    expect(sma.ready).toBe(true);
    expect(sma.value).toBe(2);
  });

  it('slides', () => {
    const sma = new Sma(3);
    for (const v of [1, 2, 3]) sma.update(v);
    expect(sma.update(4)).toBe(3);
    expect(sma.update(5)).toBe(4);
  });

  it('matches a full recomputation on any series', () => {
    fc.assert(
      fc.property(
        series({ min: -1e6, max: 1e6 }),
        fc.integer({ min: 1, max: 30 }),
        (values, period) => {
          const sma = new Sma(period);
          values.forEach((value, i) => {
            const incremental = sma.update(value);
            if (i + 1 < period) {
              expect(incremental).toBeNull();
              return;
            }
            expectClose(incremental, naiveMean(values, i, period));
          });
        },
      ),
      { numRuns: 150 },
    );
  });

  it('does not drift over a long series, because the window is resynchronised', () => {
    // Without periodic resynchronisation, add-and-subtract bookkeeping accumulates error without
    // bound. Two hundred thousand updates is a short backtest and a long time for a rolling sum.
    const period = 20;
    const sma = new Sma(period);
    const values: number[] = [];
    for (let i = 0; i < 200_000; i++) {
      const value = 1_000_000 + Math.sin(i / 97) * 1_000 + (i % 7) * 0.1;
      values.push(value);
      sma.update(value);
    }
    expectClose(sma.value, naiveMean(values, values.length - 1, period));
  });

  it('clears its state on reset', () => {
    const sma = new Sma(2);
    sma.update(10);
    sma.update(20);
    expect(sma.value).toBe(15);
    sma.reset();
    expect(sma.ready).toBe(false);
    expect(sma.value).toBeNull();
    expect(sma.update(4)).toBeNull();
  });

  it('rejects a period that cannot define an average', () => {
    expect(() => new Sma(0)).toThrow(RangeError);
    expect(() => new Sma(1.5)).toThrow(RangeError);
  });
});

describe('RollingStats', () => {
  it('reports mean, population variance and standard deviation', () => {
    const stats = new RollingStats(4);
    for (const v of [2, 4, 4, 4]) stats.update(v);
    expect(stats.value?.mean).toBe(3.5);
    expect(stats.value?.variance).toBeCloseTo(0.75, 12);
    expect(stats.value?.stdDev).toBeCloseTo(Math.sqrt(0.75), 12);
  });

  it('reports zero spread for a constant window without going negative', () => {
    const stats = new RollingStats(5);
    for (let i = 0; i < 20; i++) stats.update(42);
    expect(stats.value?.variance).toBe(0);
    expect(stats.value?.stdDev).toBe(0);
  });

  it('stays accurate where the textbook formula collapses', () => {
    // Large values with a tiny spread: exactly the shape of a fixed-point price series. The naive
    // `E[x^2] - E[x]^2` squares ~1e9 into ~1e18, where a double's spacing is larger than the
    // variance being measured, and the answer comes out as noise — or negative.
    const period = 20;
    const values = Array.from({ length: period }, (_, i) => 1_000_000_000 + i);
    const stats = new RollingStats(period);
    for (const value of values) stats.update(value);

    const expected = naiveStdDev(values, values.length - 1, period);
    expectClose(stats.value?.stdDev, expected);

    // The formula this implementation refuses to use, shown failing on the same input.
    let sum = 0;
    let sumSq = 0;
    for (const value of values) {
      sum += value;
      sumSq += value * value;
    }
    const textbook = sumSq / period - (sum / period) ** 2;
    expect(Math.abs(Math.sqrt(Math.max(0, textbook)) - expected)).toBeGreaterThan(expected * 0.01);
  });

  it('recovers exactly after an outlier leaves the window', () => {
    // Shrunk from a property-test failure. Two enormous values pass through a window of small
    // ones; removing their contribution by subtraction leaves an absolute error far larger than
    // everything that remains, and every later value inherits it until the accumulator is rebuilt.
    const period = 10;
    const values = [
      ...Array.from({ length: 24 }, () => 0),
      -88760.1274256953,
      77470.51315108237,
      0,
      0,
      0,
      0,
      0.000006412812922462764,
      0,
      -3.761951492247022,
      0,
      0,
      0,
      0,
      0,
    ];
    const stats = new RollingStats(period);
    values.forEach((value, i) => {
      const incremental = stats.update(value);
      if (i + 1 < period) return;
      expectClose(incremental?.stdDev, naiveStdDev(values, i, period));
    });
  });

  it('matches a full recomputation on any series', () => {
    fc.assert(
      fc.property(
        series({ min: -1e5, max: 1e5 }),
        fc.integer({ min: 2, max: 30 }),
        (values, period) => {
          const stats = new RollingStats(period);
          values.forEach((value, i) => {
            const incremental = stats.update(value);
            if (i + 1 < period) return;
            expectClose(incremental?.mean, naiveMean(values, i, period));
            expectClose(incremental?.stdDev, naiveStdDev(values, i, period), 1e-10);
          });
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe('Ema', () => {
  it('is seeded with the simple average of the first period samples', () => {
    const ema = new Ema(3);
    expect(ema.update(1)).toBeNull();
    expect(ema.update(2)).toBeNull();
    expect(ema.update(3)).toBe(2);

    // alpha = 2 / (3 + 1) = 0.5
    expect(ema.update(5)).toBeCloseTo(0.5 * 5 + 0.5 * 2, 12);
  });

  it('converges towards a constant input', () => {
    const ema = new Ema(10);
    for (let i = 0; i < 500; i++) ema.update(100);
    expect(ema.value).toBeCloseTo(100, 9);
  });

  it('reacts faster than a longer average', () => {
    const fast = new Ema(5);
    const slow = new Ema(50);
    for (let i = 0; i < 100; i++) {
      fast.update(100);
      slow.update(100);
    }
    for (let i = 0; i < 5; i++) {
      fast.update(200);
      slow.update(200);
    }
    expect(fast.value ?? 0).toBeGreaterThan(slow.value ?? 0);
  });

  it('stays inside the range of everything it has seen', () => {
    fc.assert(
      fc.property(
        series({ min: -1_000, max: 1_000 }),
        fc.integer({ min: 1, max: 20 }),
        (values, period) => {
          const ema = new Ema(period);
          for (const value of values) ema.update(value);
          if (!ema.ready) return;
          expect(ema.value ?? 0).toBeGreaterThanOrEqual(Math.min(...values) - 1e-9);
          expect(ema.value ?? 0).toBeLessThanOrEqual(Math.max(...values) + 1e-9);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Rma', () => {
  it('smooths more slowly than an EMA of the same period', () => {
    const ema = new Ema(14);
    const rma = new Rma(14);
    for (let i = 0; i < 50; i++) {
      ema.update(100);
      rma.update(100);
    }
    ema.update(200);
    rma.update(200);
    // alpha is 1/14 rather than 2/15, so Wilder's average moves about half as far.
    expect(ema.value ?? 0).toBeGreaterThan(rma.value ?? 0);
    expect(rma.alpha).toBeCloseTo(1 / 14, 12);
  });
});
