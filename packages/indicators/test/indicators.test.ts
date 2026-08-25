import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { type BarSample, MICROS_PER_DAY, MICROS_PER_HOUR, sourceOf } from '@tapedeck/core';
import {
  Atr,
  BollingerBands,
  Macd,
  Rsi,
  Sma,
  Vwap,
  atr,
  rma,
  stats,
  bollinger,
  ema,
  fromSource,
  macd,
  rsi,
  sma,
  vwap,
} from '../src/index.ts';

function bar(partial: Partial<BarSample> & { close: number }): BarSample {
  const close = partial.close;
  return {
    ts: partial.ts ?? 0,
    open: partial.open ?? close,
    high: partial.high ?? close,
    low: partial.low ?? close,
    close,
    volume: partial.volume ?? 1,
  };
}

describe('Rsi', () => {
  it('needs one more sample than its period, because the first change needs two prices', () => {
    const indicator = new Rsi(3);
    expect(indicator.update(10)).toBeNull();
    expect(indicator.update(11)).toBeNull();
    expect(indicator.update(12)).toBeNull();
    expect(indicator.update(13)).not.toBeNull();
    expect(indicator.ready).toBe(true);
  });

  it('reports 100 for an unbroken advance and 0 for an unbroken decline', () => {
    const rising = new Rsi(5);
    const falling = new Rsi(5);
    for (let i = 0; i < 30; i++) {
      rising.update(100 + i);
      falling.update(100 - i);
    }
    expect(rising.value).toBe(100);
    expect(falling.value).toBe(0);
  });

  it('sits at the midpoint when a flat series has neither gains nor losses', () => {
    const indicator = new Rsi(5);
    for (let i = 0; i < 30; i++) indicator.update(100);
    expect(indicator.value).toBe(50);
  });

  it('stays inside its bounds for any series', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 1, max: 1_000, noNaN: true }), { minLength: 30, maxLength: 200 }),
        (values) => {
          const indicator = new Rsi(14);
          for (const value of values) {
            const result = indicator.update(value);
            if (result === null) continue;
            expect(result).toBeGreaterThanOrEqual(0);
            expect(result).toBeLessThanOrEqual(100);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('clears its state on reset', () => {
    const indicator = new Rsi(3);
    for (let i = 0; i < 10; i++) indicator.update(100 + i);
    indicator.reset();
    expect(indicator.value).toBeNull();
    expect(indicator.update(50)).toBeNull();
  });
});

describe('BollingerBands', () => {
  it('centres on the simple average and spreads by the standard deviation', () => {
    const bands = new BollingerBands(4, 2);
    const reference = new Sma(4);
    let last: ReturnType<BollingerBands['update']> = null;
    for (const value of [2, 4, 4, 4]) {
      last = bands.update(value);
      reference.update(value);
    }
    expect(last?.middle).toBe(reference.value);
    // Population standard deviation of [2, 4, 4, 4] is sqrt(0.75).
    expect((last?.upper ?? 0) - (last?.lower ?? 0)).toBeCloseTo(4 * Math.sqrt(0.75), 10);
  });

  it('collapses to a line with zero bandwidth on a flat series', () => {
    const bands = new BollingerBands(5);
    let last: ReturnType<BollingerBands['update']> = null;
    for (let i = 0; i < 10; i++) last = bands.update(100);
    expect(last?.upper).toBe(100);
    expect(last?.lower).toBe(100);
    expect(last?.bandwidth).toBe(0);
  });

  it('keeps the bands ordered and symmetric on any series', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 1, max: 10_000, noNaN: true }), {
          minLength: 25,
          maxLength: 150,
        }),
        (values) => {
          const bands = new BollingerBands(20, 2);
          for (const value of values) {
            const result = bands.update(value);
            if (result === null) continue;
            expect(result.upper).toBeGreaterThanOrEqual(result.middle);
            expect(result.lower).toBeLessThanOrEqual(result.middle);
            expect(result.upper - result.middle).toBeCloseTo(result.middle - result.lower, 6);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Macd', () => {
  it('refuses a fast period that is not faster', () => {
    expect(() => new Macd(26, 26)).toThrow(RangeError);
  });

  it('is defined only once the signal line has enough history', () => {
    const indicator = new Macd(3, 6, 3);
    let firstDefined = -1;
    for (let i = 0; i < 30; i++) {
      const result = indicator.update(100 + Math.sin(i));
      if (result !== null && firstDefined === -1) firstDefined = i;
    }
    // slow (6) fills the difference, then the signal EMA needs its own 3 samples.
    expect(firstDefined).toBe(6 + 3 - 1 - 1);
  });

  it('goes to zero on a constant series', () => {
    const indicator = new Macd(3, 6, 3);
    let last: ReturnType<Macd['update']> = null;
    for (let i = 0; i < 60; i++) last = indicator.update(100);
    expect(last?.macd).toBeCloseTo(0, 9);
    expect(last?.histogram).toBeCloseTo(0, 9);
  });

  it('always reports the histogram as the gap between line and signal', () => {
    const indicator = new Macd();
    for (let i = 0; i < 200; i++) {
      const result = indicator.update(100 + Math.sin(i / 7) * 10);
      if (result === null) continue;
      expect(result.histogram).toBeCloseTo(result.macd - result.signal, 12);
    }
  });

  it('turns positive when the fast average overtakes the slow one', () => {
    const indicator = new Macd(3, 10, 3);
    for (let i = 0; i < 40; i++) indicator.update(100);
    for (let i = 0; i < 20; i++) indicator.update(100 + i * 5);
    expect(indicator.value?.macd ?? 0).toBeGreaterThan(0);
  });
});

describe('Atr', () => {
  it('uses the bar range alone until there is a previous close', () => {
    const indicator = new Atr(1);
    expect(indicator.update(bar({ open: 10, high: 12, low: 8, close: 11 }))).toBe(4);
  });

  it('counts a gap as volatility even when the bar itself is small', () => {
    const indicator = new Atr(1);
    indicator.update(bar({ open: 100, high: 100, low: 100, close: 100 }));
    // The bar spans one point but opened twenty above the previous close.
    const value = indicator.update(bar({ open: 120, high: 121, low: 120, close: 121 }));
    expect(value).toBe(21);
  });

  it('is never negative and never below the average bar range', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            low: fc.double({ min: 1, max: 100, noNaN: true }),
            span: fc.double({ min: 0, max: 20, noNaN: true }),
          }),
          { minLength: 20, maxLength: 100 },
        ),
        (rows) => {
          const indicator = new Atr(14);
          for (const row of rows) {
            const value = indicator.update(
              bar({
                open: row.low,
                high: row.low + row.span,
                low: row.low,
                close: row.low + row.span,
              }),
            );
            if (value !== null) expect(value).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Vwap', () => {
  it('weights price by volume', () => {
    const indicator = new Vwap({ reset: 'never', source: 'close' });
    indicator.update(bar({ close: 100, volume: 1 }));
    expect(indicator.value).toBe(100);
    indicator.update(bar({ close: 200, volume: 3 }));
    expect(indicator.value).toBe((100 * 1 + 200 * 3) / 4);
  });

  it('restarts at UTC midnight when session-scoped', () => {
    const indicator = new Vwap({ reset: 'day', source: 'close' });
    indicator.update(bar({ ts: 10 * MICROS_PER_HOUR, close: 100, volume: 10 }));
    indicator.update(bar({ ts: 11 * MICROS_PER_HOUR, close: 200, volume: 10 }));
    expect(indicator.value).toBe(150);

    indicator.update(bar({ ts: MICROS_PER_DAY + MICROS_PER_HOUR, close: 300, volume: 5 }));
    expect(indicator.value).toBe(300);
  });

  it('runs across days when told never to reset', () => {
    const indicator = new Vwap({ reset: 'never', source: 'close' });
    indicator.update(bar({ ts: 0, close: 100, volume: 10 }));
    indicator.update(bar({ ts: MICROS_PER_DAY * 5, close: 200, volume: 10 }));
    expect(indicator.value).toBe(150);
  });

  it('ignores bars that printed no volume instead of pricing them at zero', () => {
    const indicator = new Vwap({ reset: 'never', source: 'close' });
    expect(indicator.update(bar({ close: 100, volume: 0 }))).toBeNull();
    indicator.update(bar({ close: 100, volume: 5 }));
    indicator.update(bar({ close: 999, volume: 0 }));
    expect(indicator.value).toBe(100);
  });

  it('defaults to the typical price', () => {
    const indicator = new Vwap();
    const sample = bar({ ts: 0, open: 10, high: 12, low: 6, close: 9, volume: 1 });
    expect(indicator.update(sample)).toBeCloseTo(sourceOf(sample, 'hlc3'), 12);
  });
});

describe('bar-level factories', () => {
  it('feed the chosen price into the underlying value indicator', () => {
    const onClose = sma({ period: 2 });
    const onHigh = sma({ period: 2, source: 'high' });
    const bars = [
      bar({ open: 1, high: 10, low: 0, close: 2 }),
      bar({ open: 2, high: 20, low: 1, close: 4 }),
    ];
    for (const sample of bars) {
      onClose.update(sample);
      onHigh.update(sample);
    }
    expect(onClose.value).toBe(3);
    expect(onHigh.value).toBe(15);
  });

  it('names itself after the indicator and the source it reads', () => {
    expect(sma({ period: 20 }).name).toBe('sma(20)@close');
    expect(ema({ period: 9, source: 'hl2' }).name).toBe('ema(9)@hl2');
    expect(rsi().name).toBe('rsi(14)@close');
    expect(bollinger().name).toBe('bollinger(20,2)@close');
    expect(macd().name).toBe('macd(12,26,9)@close');
    expect(atr().name).toBe('atr(14)');
    expect(vwap().name).toBe('vwap(day,hlc3)');
  });

  it('forwards ready and reset through the adapter', () => {
    const indicator = fromSource(new Sma(2), 'close');
    expect(indicator.ready).toBe(false);
    indicator.update(bar({ close: 1 }));
    indicator.update(bar({ close: 3 }));
    expect(indicator.ready).toBe(true);
    expect(indicator.value).toBe(2);
    indicator.reset();
    expect(indicator.ready).toBe(false);
  });
});

describe('reset', () => {
  it('returns every indicator to the state it started in', () => {
    const sample = bar({ ts: 1, open: 10, high: 12, low: 8, close: 11, volume: 4 });

    const indicators = [
      new BollingerBands(2),
      new Macd(2, 3, 2),
      new Atr(2),
      new Vwap({ reset: 'never' }),
      new Rsi(2),
    ] as const;

    for (const indicator of indicators) {
      for (let i = 0; i < 20; i++) {
        if (indicator instanceof Atr || indicator instanceof Vwap) indicator.update(sample);
        else indicator.update(10 + i);
      }
      expect(indicator.ready).toBe(true);
      indicator.reset();
      expect(indicator.ready).toBe(false);
      expect(indicator.value).toBeNull();
    }
  });
});

describe('composition helpers', () => {
  it('exposes Wilder smoothing and rolling statistics as bar indicators', () => {
    const wilder = rma({ period: 2 });
    const spread = stats({ period: 2 });
    for (const close of [10, 20]) {
      wilder.update(bar({ close }));
      spread.update(bar({ close }));
    }
    expect(wilder.value).toBe(15);
    expect(spread.value?.mean).toBe(15);
    expect(spread.value?.stdDev).toBe(5);
    expect(wilder.name).toBe('rma(2)@close');
    expect(spread.name).toBe('stats(2)@close');
  });
});

describe('sourceOf', () => {
  it('computes each blended price', () => {
    const sample = bar({ open: 4, high: 10, low: 2, close: 8 });
    expect(sourceOf(sample, 'open')).toBe(4);
    expect(sourceOf(sample, 'high')).toBe(10);
    expect(sourceOf(sample, 'low')).toBe(2);
    expect(sourceOf(sample, 'close')).toBe(8);
    expect(sourceOf(sample, 'hl2')).toBe(6);
    expect(sourceOf(sample, 'hlc3')).toBeCloseTo((10 + 2 + 8) / 3, 12);
    expect(sourceOf(sample, 'ohlc4')).toBe(6);
  });
});
