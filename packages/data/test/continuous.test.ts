/**
 * Stitching contracts into a continuous series.
 *
 * The tests are built on contracts whose gap at the roll is known by construction, so the
 * assertions can be exact rather than approximate. The property that matters most is the one at
 * the bottom: **point differences survive the stitch**. That is the whole reason a futures
 * backtest can use an adjusted series at all, and it is the thing ratio-adjustment breaks.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  type BarChunk,
  type Contract,
  type InstrumentId,
  B3,
  B3_SERIES,
  BarChunkBuilder,
  ConfigError,
  MICROS_PER_DAY,
  TradingCalendar,
  asDuration,
  asTimestamp,
  contractOf,
  fromIso,
} from '@tapedeck/core';
import { type ContractBars, stitchContinuous } from '../src/index.ts';

const calendar = new TradingCalendar(B3);
const DAY = asDuration(MICROS_PER_DAY);

/** Daily bars starting at `fromIso`, each a flat candle at the given close. */
function daily(startIso: string, closes: readonly number[], volumes?: readonly number[]): BarChunk {
  const start = fromIso(startIso);
  const builder = new BarChunkBuilder(0 as InstrumentId, DAY, Math.max(1, closes.length));
  closes.forEach((close, i) => {
    const openTs = start + i * MICROS_PER_DAY;
    builder.push(
      openTs,
      openTs + MICROS_PER_DAY,
      close,
      close + 2,
      close - 2,
      close,
      volumes?.[i] ?? 1_000,
    );
  });
  return builder.build();
}

/** Two overlapping contracts with a known basis between them. */
function pair(options: {
  readonly frontCloses: readonly number[];
  readonly backCloses: readonly number[];
  readonly frontVolumes?: readonly number[];
  readonly backVolumes?: readonly number[];
}): ContractBars[] {
  const front = contractOf(B3_SERIES.WIN, calendar, 2025, 6);
  const back = contractOf(B3_SERIES.WIN, calendar, 2025, 8);
  return [
    {
      contract: front,
      chunk: daily('2025-06-02T21:00:00Z', options.frontCloses, options.frontVolumes),
    },
    {
      contract: back,
      chunk: daily('2025-06-02T21:00:00Z', options.backCloses, options.backVolumes),
    },
  ];
}

/** A contract whose roll date is a plain day index, for tests that do not care about B3 rules. */
function syntheticContract(symbol: string, rollDay: number, expiryDay: number): Contract {
  return {
    symbol,
    root: 'XX',
    year: 2025,
    month: 1,
    expiry: asTimestamp(fromIso('2025-06-02T21:00:00Z') + expiryDay * MICROS_PER_DAY),
    rollsAt: asTimestamp(fromIso('2025-06-02T21:00:00Z') + rollDay * MICROS_PER_DAY),
  };
}

describe('what a stitch does to prices', () => {
  it('leaves the last contract alone and shifts the history onto it', () => {
    // Front trades at 100..104, back is a constant 10 points above it. Rolling on day 2 means the
    // series should read 110, 111, 112 (front, shifted by the 10-point basis) then the back's own
    // 113, 114 — no jump, and the right-hand end untouched.
    const contracts: ContractBars[] = [
      {
        contract: syntheticContract('FRONT', 2, 3),
        chunk: daily('2025-06-02T21:00:00Z', [100, 101, 102, 103]),
      },
      {
        contract: syntheticContract('BACK', 9, 10),
        chunk: daily('2025-06-02T21:00:00Z', [110, 111, 112, 113, 114]),
      },
    ];
    const series = stitchContinuous({ contracts });

    expect(Array.from(series.chunk.close)).toEqual([110, 111, 112, 113, 114]);
    expect(series.rolls).toHaveLength(1);
    expect(series.rolls[0]?.gap).toBe(10);
    expect(series.rolls[0]?.from).toBe('FRONT');
    expect(series.rolls[0]?.to).toBe('BACK');
  });

  it('shifts open, high and low by the same amount, so the candle keeps its shape', () => {
    const contracts: ContractBars[] = [
      {
        contract: syntheticContract('FRONT', 1, 2),
        chunk: daily('2025-06-02T21:00:00Z', [100, 101]),
      },
      {
        contract: syntheticContract('BACK', 9, 10),
        chunk: daily('2025-06-02T21:00:00Z', [110, 111, 112]),
      },
    ];
    const series = stitchContinuous({ contracts });
    for (let i = 0; i < series.chunk.count; i++) {
      expect((series.chunk.high[i] ?? 0) - (series.chunk.close[i] ?? 0)).toBe(2);
      expect((series.chunk.close[i] ?? 0) - (series.chunk.low[i] ?? 0)).toBe(2);
    }
  });

  it('leaves the jump in when asked for no adjustment, and says so', () => {
    const contracts: ContractBars[] = [
      {
        contract: syntheticContract('FRONT', 2, 3),
        chunk: daily('2025-06-02T21:00:00Z', [100, 101, 102, 103]),
      },
      {
        contract: syntheticContract('BACK', 9, 10),
        chunk: daily('2025-06-02T21:00:00Z', [110, 111, 112, 113, 114]),
      },
    ];
    const series = stitchContinuous({ contracts, method: 'none' });
    // Two bars from the front and three from the back: the contract rolling on day 2 keeps
    // every bar closing at or before day 2, which is bars 0 and 1.
    expect(Array.from(series.chunk.close)).toEqual([100, 101, 112, 113, 114]);
    expect(series.warnings.join(' ')).toContain('jumps by the full');
  });
});

describe('the difference between the two adjustments', () => {
  const contracts: ContractBars[] = [
    {
      contract: syntheticContract('FRONT', 2, 3),
      chunk: daily('2025-06-02T21:00:00Z', [100, 110, 120, 130]),
    },
    {
      contract: syntheticContract('BACK', 9, 10),
      chunk: daily('2025-06-02T21:00:00Z', [140, 150, 160, 170, 180]),
    },
  ];

  it('difference keeps point moves exact, which is what a futures PnL is made of', () => {
    const series = stitchContinuous({ contracts, method: 'difference' });
    // The front moved 100 -> 110 -> 120: ten points a day, whatever the basis was.
    const closes = Array.from(series.chunk.close);
    expect((closes[1] ?? 0) - (closes[0] ?? 0)).toBe(10);
    expect((closes[2] ?? 0) - (closes[1] ?? 0)).toBe(10);
  });

  it('ratio keeps percentage moves exact, and distorts the points', () => {
    const series = stitchContinuous({ contracts, method: 'ratio' });
    const closes = Array.from(series.chunk.close);
    // The front's first move was +10%, and it is *approximately* still that. It cannot be exact:
    // an adjusted price has to be rounded back to the instrument's price scale, so the return is
    // preserved only to within that rounding. Ratio adjustment on fixed-point prices trades one
    // kind of exactness for another and does not fully deliver either.
    expect((closes[1] ?? 0) / (closes[0] ?? 1)).toBeCloseTo(1.1, 1);
    // But it is no longer ten points, which is what a contract actually pays out.
    expect((closes[1] ?? 0) - (closes[0] ?? 0)).not.toBe(10);
    expect(series.warnings.join(' ')).toContain('distorts point differences');
  });

  it('preserves every point difference inside a contract, for any prices and any basis', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 50, max: 2_000 }), { minLength: 3, maxLength: 30 }),
        fc.integer({ min: -400, max: 400 }),
        (frontCloses, basis) => {
          const backCloses = frontCloses.map((close) => close + basis + 5);
          const contracts: ContractBars[] = [
            {
              contract: syntheticContract('FRONT', 1, 2),
              chunk: daily('2025-06-02T21:00:00Z', frontCloses),
            },
            {
              contract: syntheticContract('BACK', 900, 901),
              chunk: daily('2025-06-02T21:00:00Z', backCloses),
            },
          ];
          const closes = Array.from(stitchContinuous({ contracts }).chunk.close);
          // The first two bars come from the front contract; their difference must survive intact.
          expect((closes[1] ?? 0) - (closes[0] ?? 0)).toBe(
            (frontCloses[1] ?? 0) - (frontCloses[0] ?? 0),
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('rolling on measured volume instead of on a rule', () => {
  it('rolls the session the next contract out-trades the current one', () => {
    // The back contract overtakes on the third bar, well before the rule would have rolled.
    const contracts = pair({
      frontCloses: [100, 101, 102, 103, 104],
      backCloses: [110, 111, 112, 113, 114],
      frontVolumes: [900, 800, 100, 50, 10],
      backVolumes: [10, 50, 700, 900, 990],
    });
    const series = stitchContinuous({ contracts, rollOn: 'volume' });

    expect(series.rolls[0]?.trigger).toBe('volume');
    // Two bars from the front, then the back takes over.
    expect(series.chunk.count).toBe(5);
    expect(Array.from(series.chunk.close)).toEqual([110, 111, 112, 113, 114]);
  });

  it('falls back to the rule when volume never crosses, and admits it', () => {
    const contracts = pair({
      frontCloses: [100, 101, 102],
      backCloses: [110, 111, 112],
      frontVolumes: [900, 900, 900],
      backVolumes: [1, 1, 1],
    });
    const series = stitchContinuous({ contracts, rollOn: 'volume' });
    expect(series.rolls[0]?.trigger).toBe('rule');
    expect(series.warnings.join(' ')).toContain("fell back to the series' rule");
  });
});

describe('what it refuses to do quietly', () => {
  it('warns when adjustment pushes a price to zero or below', () => {
    // A basis larger than the early prices: back-adjusting takes them under water. The engine
    // rejects orders at a non-positive price, so this must be said now and not discovered later.
    // Deep backwardation: the back contract trades far below the front, so back-adjusting shifts
    // the history *down* and takes it under water. In contango the shift is upward and this
    // cannot happen, which is why the direction matters.
    const contracts: ContractBars[] = [
      {
        contract: syntheticContract('FRONT', 1, 2),
        chunk: daily('2025-06-02T21:00:00Z', [500, 500]),
      },
      {
        contract: syntheticContract('BACK', 9, 10),
        chunk: daily('2025-06-02T21:00:00Z', [1, 1, 1]),
      },
    ];
    const shifted = stitchContinuous({ contracts, method: 'difference' });
    expect(shifted.warnings.join(' ')).toContain('at or below zero');
  });

  it('says when it could not measure a gap, instead of pretending it was zero', () => {
    // The back contract has no bar on the day the front rolls, so the basis is unmeasurable.
    const front = daily('2025-06-02T21:00:00Z', [100, 101, 102]);
    const back = daily('2025-06-06T21:00:00Z', [110, 111]);
    const contracts: ContractBars[] = [
      { contract: syntheticContract('FRONT', 1, 2), chunk: front },
      { contract: syntheticContract('BACK', 9, 10), chunk: back },
    ];
    const series = stitchContinuous({ contracts });
    expect(series.warnings.join(' ')).toContain('could not be measured');
    expect(series.rolls[0]?.gap).toBe(0);
  });

  it('always warns that adjusted prices never traded', () => {
    const series = stitchContinuous({
      contracts: pair({ frontCloses: [100, 101, 102], backCloses: [110, 111, 112] }),
    });
    expect(series.warnings.join(' ')).toContain('never traded at the value shown');
  });

  it('refuses contracts on different timeframes', () => {
    const hourly = new BarChunkBuilder(0 as InstrumentId, asDuration(3_600_000_000), 2);
    hourly.push(0, 3_600_000_000, 100, 100, 100, 100, 1);
    const contracts: ContractBars[] = [
      {
        contract: syntheticContract('FRONT', 1, 2),
        chunk: daily('2025-06-02T21:00:00Z', [100, 101]),
      },
      { contract: syntheticContract('BACK', 9, 10), chunk: hourly.build() },
    ];
    expect(() => stitchContinuous({ contracts })).toThrow(/share one timeframe/);
  });

  it('refuses to build a series out of nothing', () => {
    expect(() => stitchContinuous({ contracts: [] })).toThrow(ConfigError);
  });
});

describe('the shape of the output', () => {
  it('is one chunk in strict time order, with no bar counted twice', () => {
    const contracts = pair({
      frontCloses: [100, 101, 102, 103],
      backCloses: [110, 111, 112, 113, 114],
    });
    const series = stitchContinuous({ contracts, rollOn: 'rule' });
    for (let i = 1; i < series.chunk.count; i++) {
      expect(series.chunk.closeTs[i] ?? 0).toBeGreaterThan(series.chunk.closeTs[i - 1] ?? 0);
    }
  });

  it('carries volume through unadjusted, from whichever contract the bar came from', () => {
    const contracts: ContractBars[] = [
      {
        contract: syntheticContract('FRONT', 1, 2),
        chunk: daily('2025-06-02T21:00:00Z', [100, 101], [777, 778]),
      },
      {
        contract: syntheticContract('BACK', 9, 10),
        chunk: daily('2025-06-02T21:00:00Z', [110, 111, 112], [11, 12, 13]),
      },
    ];
    const series = stitchContinuous({ contracts });
    // One bar from the front (it rolls on day 1), two from the back.
    expect(Array.from(series.chunk.volume)).toEqual([777, 12, 13]);
  });
});
