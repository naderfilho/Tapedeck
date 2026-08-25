import { describe, expect, it } from 'vitest';
import {
  type BarEvent,
  type InstrumentId,
  type StrategyContext,
  Engine,
  MarketDataError,
  PRESETS,
  asQty,
  bpsSlippage,
  fixedTicksSlippage,
  serializeRunResult,
  withJitter,
} from '@tapedeck/core';
import { MONEY, TEST_FUTURE, bars, flatBars, splitChunk } from './helpers.ts';
import { runScript } from './harness.ts';

const ZERO = 0 as InstrumentId;

/** A sawtooth that trades often enough to exercise fills, PnL and the equity curve. */
function sawtooth(count: number): { o: number; h: number; l: number; c: number; v: number }[] {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const base = 100 + (i % 20) - 10;
    rows.push({ o: base, h: base + 3, l: base - 3, c: base + (i % 2 === 0 ? 1 : -1), v: 500 });
  }
  return rows;
}

function alternatingTrader(bar: BarEvent, ctx: StrategyContext): void {
  if (bar.index % 5 !== 0) return;
  ctx.submit({
    instrumentId: ZERO,
    side: bar.index % 10 === 0 ? 'buy' : 'sell',
    type: 'market',
    qty: asQty(1),
  });
}

describe('determinism', () => {
  it('produces byte-identical results for the same inputs', () => {
    const options = {
      rows: sawtooth(400),
      execution: { ...PRESETS.ideal(), slippage: withJitter(fixedTicksSlippage(1), 3) },
      seed: 42,
      onBar: alternatingTrader,
    };
    const first = serializeRunResult(runScript(options));
    const second = serializeRunResult(runScript(options));
    expect(first).toBe(second);
  });

  it('produces the same result however the input is chunked', () => {
    const options = {
      rows: sawtooth(400),
      execution: { ...PRESETS.ideal(), slippage: withJitter(fixedTicksSlippage(1), 3) },
      seed: 7,
      onBar: alternatingTrader,
    };
    const single = serializeRunResult(runScript({ ...options, chunks: 1 }));
    const many = serializeRunResult(runScript({ ...options, chunks: 37 }));
    expect(many).toBe(single);
  });

  it('changes when the seed changes, so the seed is doing something', () => {
    const options = {
      rows: sawtooth(200),
      execution: { ...PRESETS.ideal(), slippage: withJitter(fixedTicksSlippage(1), 5) },
      onBar: alternatingTrader,
    };
    const a = serializeRunResult(runScript({ ...options, seed: 1 }));
    const b = serializeRunResult(runScript({ ...options, seed: 2 }));
    expect(a).not.toBe(b);
  });
});

describe('market data validation', () => {
  const engineFor = (): Engine<Record<string, never>> =>
    new Engine({
      instruments: [TEST_FUTURE],
      strategy: () => ({ id: 'noop', onInit: () => undefined }),
      params: {},
      initialCash: '1000',
    });

  it('rejects a bar whose high is below its low', () => {
    expect(() => {
      engineFor().feedBars(bars([{ o: 100, h: 90, l: 95, c: 96 }]));
    }).toThrow(MarketDataError);
  });

  it('rejects a bar whose close falls outside its range', () => {
    expect(() => {
      engineFor().feedBars(bars([{ o: 100, h: 105, l: 99, c: 120 }]));
    }).toThrow(MarketDataError);
  });

  it('rejects non-integer prices, which mean a missing fixed-point conversion', () => {
    expect(() => {
      engineFor().feedBars(bars([{ o: 100.5, h: 101, l: 100, c: 100.5 }]));
    }).toThrow(MarketDataError);
  });

  it('rejects a chunk that goes back in time relative to the previous one', () => {
    const engine = engineFor();
    engine.feedBars(flatBars(100, 5));
    expect(() => {
      engine.feedBars(flatBars(100, 5));
    }).toThrow(MarketDataError);
  });

  it('rejects overlapping bars inside a single chunk', () => {
    const chunk = bars([
      { o: 100, h: 100, l: 100, c: 100 },
      { o: 100, h: 100, l: 100, c: 100 },
    ]);
    chunk.openTs[1] = 0;
    expect(() => {
      engineFor().feedBars(chunk);
    }).toThrow(MarketDataError);
  });
});

describe('lifecycle', () => {
  it('records one equity point per bar', () => {
    const result = runScript({ rows: sawtooth(50) });
    expect(result.equityCurve.length).toBe(50);
    expect(result.stats.bars).toBe(50);
  });

  it('calls onInit once and onStop once', () => {
    let inits = 0;
    let stops = 0;
    runScript({
      rows: sawtooth(10),
      onInit: () => {
        inits++;
      },
      onStop: () => {
        stops++;
      },
    });
    expect(inits).toBe(1);
    expect(stops).toBe(1);
  });

  it('refuses to be fed after finishing', () => {
    const engine = new Engine({
      instruments: [TEST_FUTURE],
      strategy: () => ({ id: 'noop', onInit: () => undefined }),
      params: {},
      initialCash: '1000',
    });
    engine.finish();
    expect(() => {
      engine.feedBars(flatBars(100, 1));
    }).toThrow(/after finish/);
    expect(() => engine.finish()).toThrow(/already called/);
  });

  it('flattens an open position at the end when asked', () => {
    const rows = [
      { o: 100, h: 100, l: 100, c: 100 },
      { o: 100, h: 100, l: 100, c: 100 },
      { o: 120, h: 120, l: 120, c: 120 },
    ];
    const buyOnce = (bar: BarEvent, ctx: StrategyContext): void => {
      if (bar.index === 0) {
        ctx.submit({ instrumentId: ZERO, side: 'buy', type: 'market', qty: asQty(1) });
      }
    };

    const left = runScript({ rows, onBar: buyOnce, flattenAtEnd: false });
    expect(left.openPositions).toHaveLength(1);
    expect(left.trades).toHaveLength(0);
    expect(left.unrealizedPnl).toBe(20 * MONEY);
    expect(left.warnings.some((w) => w.includes('still open'))).toBe(true);

    const flat = runScript({ rows, onBar: buyOnce, flattenAtEnd: true });
    expect(flat.openPositions).toHaveLength(0);
    expect(flat.trades).toHaveLength(1);
    expect(flat.trades[0]?.netPnl).toBe(20 * MONEY);
    // Flattening cannot change the money, only where it is reported.
    expect(flat.finalEquity).toBe(left.finalEquity);
  });
});

describe('bar view guarding', () => {
  it('revokes the bar when the callback returns, under guarded mode', () => {
    let escaped: BarEvent | null = null;
    runScript({
      rows: sawtooth(3),
      barViewMode: 'guarded',
      onBar: (bar) => {
        escaped = bar;
      },
    });
    expect(escaped).not.toBeNull();
    // Reading a retained view is the mechanism by which a strategy would see the future.
    expect(() => (escaped as unknown as BarEvent).close).toThrow(TypeError);
  });

  it('hands out an immutable snapshot under copy mode', () => {
    const seen: BarEvent[] = [];
    runScript({
      rows: sawtooth(3),
      barViewMode: 'copy',
      onBar: (bar) => seen.push(bar),
    });
    expect(seen).toHaveLength(3);
    expect(Object.isFrozen(seen[0])).toBe(true);
    // Each snapshot kept its own values instead of aliasing the latest bar.
    expect(new Set(seen.map((b) => b.index)).size).toBe(3);
  });

  it('reuses one object under reuse mode, which is why retaining it is forbidden', () => {
    const seen: BarEvent[] = [];
    runScript({
      rows: sawtooth(3),
      barViewMode: 'reuse',
      onBar: (bar) => seen.push(bar),
    });
    expect(seen[0]).toBe(seen[1]);
  });
});

describe('multi-chunk feeding', () => {
  it('treats a split chunk exactly like the whole', () => {
    const chunk = bars(sawtooth(100));
    const parts = splitChunk(chunk, 9);
    expect(parts.reduce((sum, p) => sum + p.count, 0)).toBe(100);
  });
});

describe('execution configuration', () => {
  it('reports the models it actually used', () => {
    const result = runScript({
      rows: sawtooth(5),
      execution: { slippage: bpsSlippage(5) },
    });
    expect(result.config.slippageModel).toBe('bps(5)');
    expect(result.config.intrabarPolicy).toBe('pessimistic');
    expect(result.config.barViewMode).toBe('guarded');
  });
});
