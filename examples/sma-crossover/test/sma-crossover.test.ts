/**
 * The smoke test: one strategy, the whole pipeline, from a real tape to a trade list.
 *
 * It asserts behaviour that must hold for *any* strategy — no lookahead, reconciling accounts,
 * reproducibility — rather than a particular PnL. The data is the committed year of hourly
 * BTCUSDT, so these are real prices; the numbers still say nothing about the strategy.
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  type RunResult,
  ConfigError,
  Engine,
  PRESETS,
  parseFixed,
  serializeRunResult,
} from '@tapedeck/core';
import { readBarTapeFileSync } from '@tapedeck/data';
import { type SmaCrossoverParams, smaCrossover } from '../src/strategy.ts';

const TAPE = fileURLToPath(new URL('../../../fixtures/binance-BTCUSDT-1h.tape', import.meta.url));
const tape = readBarTapeFileSync(TAPE);
const SIZE = parseFixed('0.25', tape.instrument.qtyExp);

const PARAMS: SmaCrossoverParams = {
  fastPeriod: 24,
  slowPeriod: 72,
  qty: SIZE,
  allowShort: true,
};

function run(overrides: Partial<SmaCrossoverParams> = {}, seed = 1): RunResult {
  const engine = new Engine<SmaCrossoverParams>({
    instruments: [tape.instrument],
    strategy: smaCrossover,
    params: { ...PARAMS, ...overrides },
    initialCash: '100000',
    seed,
    execution: PRESETS.binanceSpot(),
    flattenAtEnd: true,
  });
  engine.feedBars(tape.chunk);
  return engine.finish();
}

describe('sma crossover on a year of hourly BTCUSDT', () => {
  const result = run();

  it('replays the whole tape and closes every trade', () => {
    expect(result.stats.bars).toBe(tape.chunk.count);
    expect(result.trades.length).toBeGreaterThan(20);
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
    expect(peak).toBe(SIZE);
    expect(position).toBe(0);
  });

  it('pays a fee on every fill, because the venue does', () => {
    expect(result.fills.every((fill) => fill.commission > 0)).toBe(true);
    expect(result.commissionPaid).toBeGreaterThan(0);
  });

  it('shows costs large enough to matter, which is the point of modelling them', () => {
    // On hourly bars a crossover trades often, and ten basis points a side is not a rounding
    // error. A backtester that omitted fees would report a materially different result.
    expect(result.commissionPaid).toBeGreaterThan(Math.abs(result.realizedPnl) * 0.1);
  });

  it('publishes one signal per position change', () => {
    expect(result.stats.signals).toBe(result.trades.length);
    expect(result.signals.every((signal) => signal.direction !== 'flat')).toBe(true);
  });

  it('stays flat until the slow average has enough history', () => {
    const firstFill = result.fills[0];
    const firstBarClose = tape.chunk.closeTs[0] ?? 0;
    // The slow window is 72 bars, so nothing is submitted before bar 72 or filled before bar 73.
    expect(firstFill?.ts).toBeGreaterThanOrEqual(firstBarClose + 72 * 3_600_000_000);
  });

  it('is reproducible byte for byte', () => {
    expect(serializeRunResult(run())).toBe(serializeRunResult(run()));
  });

  it('holds no short position when shorting is disabled', () => {
    const longOnly = run({ allowShort: false });
    let position = 0;
    for (const fill of longOnly.fills) {
      position += fill.side === 'buy' ? fill.qty : -fill.qty;
      expect(position).toBeGreaterThanOrEqual(0);
    }
    expect(longOnly.trades.length).toBeLessThan(result.trades.length);
  });

  it('rejects parameters that cannot produce a crossover', () => {
    expect(() => run({ fastPeriod: 72, slowPeriod: 72 })).toThrow(ConfigError);
    expect(() => run({ qty: 0 })).toThrow(ConfigError);
  });
});
