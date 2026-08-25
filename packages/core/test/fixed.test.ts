import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  PrecisionError,
  formatFixed,
  fromFloat,
  isTickAligned,
  mulDiv,
  mulMulDiv,
  parseFixed,
  pow10,
  roundToTick,
  toFloat,
  weightedAverage,
} from '@tapedeck/core';

describe('parseFixed', () => {
  it('parses without ever touching a float', () => {
    expect(parseFixed('0.1', 8)).toBe(10_000_000);
    expect(parseFixed('123.456', 3)).toBe(123_456);
    expect(parseFixed('-0.5', 2)).toBe(-50);
    expect(parseFixed('  42  ', 2)).toBe(4_200);
    expect(parseFixed('+7.25', 2)).toBe(725);
  });

  it('is exact where float parsing is not', () => {
    // 0.1 + 0.2 !== 0.3 in float64. In fixed point the sum is exact.
    expect(parseFixed('0.1', 8) + parseFixed('0.2', 8)).toBe(parseFixed('0.3', 8));
  });

  it('rounds half-up when the input carries more decimals than the scale', () => {
    expect(parseFixed('1.005', 2)).toBe(101);
    expect(parseFixed('1.004', 2)).toBe(100);
    expect(parseFixed('-1.005', 2)).toBe(-101);
  });

  it('rejects anything that is not a decimal number', () => {
    for (const bad of ['', 'abc', '1.2.3', '1e5', 'NaN', '--1']) {
      expect(() => parseFixed(bad, 2)).toThrow(PrecisionError);
    }
  });

  it('rejects values beyond the safe-integer range', () => {
    expect(() => parseFixed('99999999999999999999', 8)).toThrow(PrecisionError);
  });

  it('round-trips through formatFixed for any safe integer', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1e12, max: 1e12 }),
        fc.integer({ min: 0, max: 8 }),
        (v, exp) => {
          expect(parseFixed(formatFixed(v, exp), exp)).toBe(v);
        },
      ),
    );
  });
});

describe('formatFixed', () => {
  it('keeps exactly the declared number of decimals', () => {
    expect(formatFixed(10_000_000, 8)).toBe('0.10000000');
    expect(formatFixed(-50, 2)).toBe('-0.50');
    expect(formatFixed(4_200, 2)).toBe('42.00');
    expect(formatFixed(1234, 0)).toBe('1234');
  });
});

describe('mulDiv and mulMulDiv', () => {
  it('is exact where float multiplication overflows', () => {
    // A BTC price at 1e2 scale times a quantity at 1e8 scale: the product leaves the safe range,
    // which is precisely the case ADR-0002 exists to handle.
    const price = 7_000_000; // 70000.00
    const qty = 10_000_000_000; // 100.00000000
    const pointValue = 100_000_000; // 1 USDT per point
    expect(mulMulDiv(price, qty, pointValue, 10 ** (2 + 8))).toBe(700_000_000_000_000);
  });

  it('throws instead of silently losing precision', () => {
    expect(() => mulDiv(9_007_199_254_740_991, 1_000, 1)).toThrow(PrecisionError);
    expect(() => mulDiv(1.5, 2, 1)).toThrow(PrecisionError);
    expect(() => mulDiv(1, 2, 0)).toThrow(PrecisionError);
  });

  it('applies each rounding mode as documented', () => {
    expect(mulDiv(5, 1, 2, 'trunc')).toBe(2);
    expect(mulDiv(5, 1, 2, 'floor')).toBe(2);
    expect(mulDiv(5, 1, 2, 'ceil')).toBe(3);
    expect(mulDiv(5, 1, 2, 'half-up')).toBe(3);
    expect(mulDiv(5, 1, 2, 'half-even')).toBe(2);
    expect(mulDiv(7, 1, 2, 'half-even')).toBe(4);

    expect(mulDiv(-5, 1, 2, 'trunc')).toBe(-2);
    expect(mulDiv(-5, 1, 2, 'floor')).toBe(-3);
    expect(mulDiv(-5, 1, 2, 'ceil')).toBe(-2);
    expect(mulDiv(-5, 1, 2, 'half-up')).toBe(-3);
  });

  it('gives the same answer whether it takes the fast path or the bigint path', () => {
    // The fast path is chosen when every intermediate is exactly representable. Multiplying both
    // operands by 2^30 forces the same computation onto the bigint path, and the two must agree.
    const modes = ['trunc', 'floor', 'ceil', 'half-up', 'half-even'] as const;
    const scale = 2 ** 30;
    fc.assert(
      fc.property(
        fc.integer({ min: -1e6, max: 1e6 }),
        fc.integer({ min: -1e6, max: 1e6 }),
        fc.integer({ min: 1, max: 9_973 }),
        fc.constantFrom(...modes),
        (a, b, d, mode) => {
          const fast = mulDiv(a, b, d, mode);
          const slow = mulDiv(a * scale, b * scale, d * scale * scale, mode);
          expect(slow).toBe(fast);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('agrees with exact bigint arithmetic on arbitrary inputs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1e7, max: 1e7 }),
        fc.integer({ min: -1e7, max: 1e7 }),
        fc.integer({ min: 1, max: 1e6 }),
        (a, b, d) => {
          const expected = (BigInt(a) * BigInt(b)) / BigInt(d);
          expect(mulDiv(a, b, d, 'trunc')).toBe(Number(expected));
        },
      ),
    );
  });
});

describe('weightedAverage', () => {
  it('averages an added position the way a broker does', () => {
    expect(weightedAverage(100, 1, 200, 1)).toBe(150);
    expect(weightedAverage(100, 3, 200, 1)).toBe(125);
    expect(weightedAverage(0, 0, 200, 5)).toBe(200);
  });

  it('never leaves the interval spanned by its inputs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1e6 }),
        fc.integer({ min: 1, max: 1e6 }),
        fc.integer({ min: 1, max: 1e4 }),
        fc.integer({ min: 1, max: 1e4 }),
        (v1, v2, w1, w2) => {
          const avg = weightedAverage(v1, w1, v2, w2);
          expect(avg).toBeGreaterThanOrEqual(Math.min(v1, v2));
          expect(avg).toBeLessThanOrEqual(Math.max(v1, v2));
        },
      ),
    );
  });
});

describe('roundToTick', () => {
  it('snaps in the requested direction', () => {
    expect(roundToTick(103, 5, 'down')).toBe(100);
    expect(roundToTick(103, 5, 'up')).toBe(105);
    expect(roundToTick(103, 5, 'nearest')).toBe(105);
    expect(roundToTick(102, 5, 'nearest')).toBe(100);
    expect(roundToTick(100, 5, 'nearest')).toBe(100);
  });

  it('handles negative values without drifting toward zero by accident', () => {
    expect(roundToTick(-103, 5, 'down')).toBe(-105);
    expect(roundToTick(-103, 5, 'up')).toBe(-100);
    expect(roundToTick(-103, 5, 'toward-zero')).toBe(-100);
  });

  it('always produces a tick-aligned value', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1e9, max: 1e9 }),
        fc.integer({ min: 1, max: 1000 }),
        fc.constantFrom('nearest' as const, 'down' as const, 'up' as const, 'toward-zero' as const),
        (value, tick, mode) => {
          expect(isTickAligned(roundToTick(value, tick, mode), tick)).toBe(true);
        },
      ),
    );
  });
});

describe('float conversions', () => {
  it('converts both ways for values a double can hold', () => {
    expect(fromFloat(1.5, 2)).toBe(150);
    expect(fromFloat(-1.5, 2)).toBe(-150);
    expect(toFloat(150, 2)).toBe(1.5);
  });

  it('never produces negative zero, which would break byte-for-byte comparison', () => {
    expect(Object.is(fromFloat(-0.001, 2), 0)).toBe(true);
  });

  it('rejects non-finite input and unsupported exponents', () => {
    expect(() => fromFloat(Number.NaN, 2)).toThrow(PrecisionError);
    expect(() => fromFloat(Number.POSITIVE_INFINITY, 2)).toThrow(PrecisionError);
    expect(() => pow10(16)).toThrow(PrecisionError);
  });
});
