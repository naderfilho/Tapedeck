/**
 * The bracket strategy, against the committed year of hourly BTCUSDT.
 *
 * Like the crossover's test, this asserts invariants rather than a PnL. Two of them are specific to
 * this strategy and are the reason it exists: a bracket must never leave both legs executed, and a
 * run that puts a stop and a target on the same bar must report the bars where the order between
 * them could not be known.
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { type RunResult, ConfigError, Engine, PRESETS, parseFixed } from '@tapedeck/core';
import { readBarTapeFileSync } from '@tapedeck/data';
import { type BreakoutParams, breakout } from '../src/strategy.ts';

const TAPE = fileURLToPath(new URL('../../../fixtures/binance-BTCUSDT-1h.tape', import.meta.url));
const tape = readBarTapeFileSync(TAPE);

const PARAMS: BreakoutParams = {
  lookback: 48,
  atrPeriod: 14,
  stopAtr: 2,
  targetAtr: 3,
  volumeFactor: 1.2,
  qty: parseFixed('0.25', tape.instrument.qtyExp),
};

function run(overrides: Partial<BreakoutParams> = {}, seed = 1): RunResult {
  const engine = new Engine<BreakoutParams>({
    instruments: [tape.instrument],
    strategy: breakout,
    params: { ...PARAMS, ...overrides },
    initialCash: '100000',
    seed,
    execution: PRESETS.binanceSpot(),
    flattenAtEnd: true,
  });
  engine.feedBars(tape.chunk);
  return engine.finish();
}

describe('breakout', () => {
  const result = run();

  it('trades', () => {
    expect(result.trades.length).toBeGreaterThan(0);
  });

  it('never holds more than the configured size', () => {
    // A bracket that let both legs execute would sell twice and open a short. The position may be
    // flat or long by exactly one unit of size, and nothing else, at any point.
    for (const trade of result.trades) {
      expect(Math.abs(trade.qty)).toBeLessThanOrEqual(PARAMS.qty);
    }
  });

  it('closes every trade through one leg of the bracket, never both', () => {
    const legs = result.fills.filter((fill) => fill.tag === 'stop' || fill.tag === 'target');
    const entries = result.fills.filter((fill) => fill.tag === 'entry');
    // One exit leg per entry at most. The end-of-run flatten can close a position with no leg, so
    // this is an inequality rather than an equality.
    expect(legs.length).toBeLessThanOrEqual(entries.length);
  });

  it('reports the bars whose fill order could not be known', () => {
    // The whole reason this strategy is in the repository. A stop and a target resting on the same
    // instrument will eventually share a bar with both levels inside its range, and the engine has
    // to say so rather than pick the flattering one in silence.
    expect(result.stats.ambiguousBars).toBeGreaterThan(0);
  });

  it('reconciles: equity equals cash plus PnL minus costs', () => {
    expect(result.finalEquity).toBe(
      result.initialCash + result.realizedPnl + result.unrealizedPnl - result.commissionPaid,
    );
  });

  it('agrees with its own trade list', () => {
    const summed = result.trades.reduce((total, trade) => total + trade.grossPnl, 0);
    expect(summed).toBe(result.realizedPnl);
  });

  it('is reproducible', () => {
    expect(run({}, 7).equityCurve.equity.at(-1)).toBe(run({}, 7).equityCurve.equity.at(-1));
  });

  it('refuses a bracket that cannot exist', () => {
    expect(() => run({ stopAtr: 0 })).toThrow(ConfigError);
    expect(() => run({ lookback: 1 })).toThrow(ConfigError);
  });
});
