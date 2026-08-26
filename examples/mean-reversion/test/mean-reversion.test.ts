/**
 * RSI mean reversion, against the committed year of hourly BTCUSDT.
 *
 * Invariants, not a PnL. The one worth having here is the time stop: without it a mean-reversion
 * rule can hold a position that never reverts until the run ends, and the equity curve stops
 * describing the rule and starts describing one trade. So the test asserts that no trade outlives
 * the limit, which is a property of the strategy rather than of these particular prices.
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { type RunResult, ConfigError, Engine, PRESETS, parseFixed } from '@tapedeck/core';
import { readBarTapeFileSync } from '@tapedeck/data';
import { type MeanReversionParams, meanReversion } from '../src/strategy.ts';

const TAPE = fileURLToPath(new URL('../../../fixtures/binance-BTCUSDT-1h.tape', import.meta.url));
const tape = readBarTapeFileSync(TAPE);

const PARAMS: MeanReversionParams = {
  rsiPeriod: 14,
  entryLevel: 30,
  exitLevel: 55,
  maxBarsHeld: 48,
  qty: parseFixed('0.25', tape.instrument.qtyExp),
};

function run(overrides: Partial<MeanReversionParams> = {}, seed = 1): RunResult {
  const engine = new Engine<MeanReversionParams>({
    instruments: [tape.instrument],
    strategy: meanReversion,
    params: { ...PARAMS, ...overrides },
    initialCash: '100000',
    seed,
    execution: PRESETS.binanceSpot(),
    flattenAtEnd: true,
  });
  engine.feedBars(tape.chunk);
  return engine.finish();
}

describe('mean reversion', () => {
  const result = run();

  it('trades', () => {
    expect(result.trades.length).toBeGreaterThan(0);
  });

  it('is long or flat, never short', () => {
    // The rule buys weakness and sells back to flat. A short would mean an exit oversold its own
    // position, which is the arithmetic slip a fixed size is supposed to make impossible.
    for (const trade of result.trades) {
      expect(trade.qty).toBeGreaterThan(0);
    }
  });

  it('honours the time stop', () => {
    // The exit fires on the bar the limit is reached, and the resulting order matches against the
    // next one, so a trade may last one bar longer than the limit and no more.
    for (const trade of result.trades) {
      expect(trade.barsHeld).toBeLessThanOrEqual(PARAMS.maxBarsHeld + 1);
    }
  });

  it('ends flat', () => {
    expect(result.openPositions).toHaveLength(0);
  });

  it('reconciles: equity equals cash plus PnL minus costs', () => {
    expect(result.finalEquity).toBe(
      result.initialCash + result.realizedPnl + result.unrealizedPnl - result.commissionPaid,
    );
  });

  it('is reproducible', () => {
    expect(run({}, 9).equityCurve.equity.at(-1)).toBe(run({}, 9).equityCurve.equity.at(-1));
  });

  it('refuses levels that cross', () => {
    expect(() => run({ entryLevel: 60, exitLevel: 40 })).toThrow(ConfigError);
    expect(() => run({ maxBarsHeld: 0 })).toThrow(ConfigError);
  });
});
