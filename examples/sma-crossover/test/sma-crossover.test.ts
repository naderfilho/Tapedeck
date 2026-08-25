/**
 * The smoke test: one strategy, the whole pipeline, from bars to trades.
 *
 * It asserts behaviour that must hold for *any* strategy — no lookahead, reconciling accounts,
 * reproducibility — rather than a particular PnL on invented data.
 */

import { describe, expect, it } from 'vitest';
import {
  type RunResult,
  ConfigError,
  Engine,
  INSTRUMENTS,
  PRESETS,
  serializeRunResult,
} from '@tapedeck/core';
import { type SmaCrossoverParams, smaCrossover } from '../src/strategy.ts';
import { syntheticSeries } from '../src/series.ts';

const PARAMS: SmaCrossoverParams = { fastPeriod: 10, slowPeriod: 30, qty: 1, allowShort: true };

function run(overrides: Partial<SmaCrossoverParams> = {}, seed = 1, bars = 2_000): RunResult {
  const engine = new Engine<SmaCrossoverParams>({
    instruments: [INSTRUMENTS.WIN],
    strategy: smaCrossover,
    params: { ...PARAMS, ...overrides },
    initialCash: '100000',
    seed,
    execution: PRESETS.b3Futures(),
    flattenAtEnd: true,
  });
  engine.feedBars(
    syntheticSeries({
      instrument: engine.registry.byId(0 as never),
      bars,
      startPrice: 130_000,
      seed,
    }),
  );
  return engine.finish();
}

describe('sma crossover', () => {
  const result = run();

  it('trades, and every trade closes', () => {
    expect(result.stats.bars).toBe(2_000);
    expect(result.trades.length).toBeGreaterThan(5);
    expect(result.openPositions).toHaveLength(0);
  });

  it('reconciles: equity equals cash plus PnL minus costs', () => {
    expect(result.finalEquity).toBe(
      result.initialCash + result.realizedPnl + result.unrealizedPnl - result.commissionPaid,
    );
  });

  it('agrees with its own trade list', () => {
    const summed = result.trades.reduce((total, trade) => total + trade.grossPnl, 0);
    expect(summed).toBe(result.realizedPnl);
    const fees = result.trades.reduce((total, trade) => total + trade.commission, 0);
    expect(fees).toBe(result.commissionPaid);
  });

  it('never holds more than the configured size', () => {
    let position = 0;
    let peak = 0;
    for (const fill of result.fills) {
      position += fill.side === 'buy' ? fill.qty : -fill.qty;
      peak = Math.max(peak, Math.abs(position));
    }
    expect(peak).toBe(1);
    expect(position).toBe(0);
  });

  it('pays commission on every fill, because B3 does', () => {
    expect(result.fills.every((fill) => fill.commission > 0)).toBe(true);
    expect(result.commissionPaid).toBeGreaterThan(0);
  });

  it('publishes one signal per position change', () => {
    expect(result.stats.signals).toBeGreaterThan(0);
    expect(result.signals.every((signal) => signal.direction !== 'flat')).toBe(true);
  });

  it('is reproducible byte for byte', () => {
    expect(serializeRunResult(run())).toBe(serializeRunResult(run()));
  });

  it('stays flat until the slow average has enough history', () => {
    const firstFill = result.fills[0];
    expect(firstFill).toBeDefined();
    // The slow window is 30 bars, so nothing can be submitted before bar 30 or filled before 31.
    expect(firstFill?.ts).toBeGreaterThanOrEqual(
      31 * 60 * 1_000_000 + Number(result.startTs) - 60_000_000,
    );
  });

  it('holds no short position when shorting is disabled', () => {
    const longOnly = run({ allowShort: false });
    let position = 0;
    for (const fill of longOnly.fills) {
      position += fill.side === 'buy' ? fill.qty : -fill.qty;
      expect(position).toBeGreaterThanOrEqual(0);
    }
  });

  it('rejects parameters that cannot produce a crossover', () => {
    expect(() => run({ fastPeriod: 30, slowPeriod: 30 })).toThrow(ConfigError);
    expect(() => run({ qty: 0 })).toThrow(ConfigError);
  });
});
