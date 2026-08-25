/**
 * The break-even commission.
 *
 * This is the cost number that matters when the real tariff is unknown, so it is not enough for it
 * to be arithmetically defensible: the central test charges exactly the figure the metric reported
 * and asserts the run's profit lands on zero. If the claim "above this, the strategy stops making
 * money" were wrong, that test would say so in currency rather than in algebra.
 */

import { describe, expect, it } from 'vitest';
import {
  type BarChunk,
  type InstrumentId,
  type InstrumentSpec,
  type RunResult,
  type Strategy,
  BarChunkBuilder,
  MICROS_PER_HOUR,
  asDuration,
  asQty,
  formatFixed,
  perUnitCommission,
  runBacktest,
} from '@tapedeck/core';
import { computeMetrics, formatMetrics, metricsToJsonString } from '../src/index.ts';

const FUTURE: InstrumentSpec = {
  symbol: 'TF',
  venue: 'TEST',
  kind: 'future',
  currency: 'BRL',
  priceExp: 0,
  qtyExp: 0,
  tickSize: '1',
  lotSize: '1',
  pointValue: '1',
  accounting: 'margin',
};

/**
 * A sawtooth that holds each price for two bars: 100, 100, 110, 110, and round again.
 *
 * The pause matters. An order submitted on a bar's close fills at the *next* bar's open (ADR-0005),
 * so on a one-bar-per-price sawtooth every buy would land on the peak it was trying to avoid —
 * which is a fine demonstration of no-lookahead and a useless fixture for measuring costs.
 */
function sawtooth(cycles: number): BarChunk {
  const count = cycles * 4;
  const builder = new BarChunkBuilder(0 as InstrumentId, asDuration(MICROS_PER_HOUR), count);
  for (let i = 0; i < count; i++) {
    const price = Math.floor(i / 2) % 2 === 0 ? 100 : 110;
    const openTs = i * MICROS_PER_HOUR;
    builder.push(openTs, openTs + MICROS_PER_HOUR, price, price, price, price, 10_000);
  }
  return builder.build();
}

/** Buys at 100, sells at 110, forever. Its edge before costs is exactly ten points a round trip. */
function alternator(qty: number): () => Strategy {
  return () => ({
    id: 'alternator',
    onInit: () => undefined,
    onBar: (bar, ctx) => {
      const position = ctx.portfolio.position(bar.instrumentId).qty;
      if (bar.close === 100 && position === 0) {
        ctx.submit({
          instrumentId: bar.instrumentId,
          side: 'buy',
          type: 'market',
          qty: asQty(qty),
        });
      } else if (bar.close === 110 && position > 0) {
        ctx.submit({
          instrumentId: bar.instrumentId,
          side: 'sell',
          type: 'market',
          qty: asQty(qty),
        });
      }
    },
  });
}

function run(commissionPerUnit: string, qty = 1): RunResult {
  return runBacktest(
    {
      instruments: [FUTURE],
      strategy: alternator(qty),
      params: {},
      initialCash: '100000',
      seed: 1,
      execution: { commission: perUnitCommission(commissionPerUnit) },
      flattenAtEnd: false,
    },
    [sawtooth(20)],
  );
}

describe('what the break-even figure claims', () => {
  it('is the commission at which the run makes exactly nothing', () => {
    const free = computeMetrics(run('0'));
    const breakEven = free.breakEvenCommissionPerUnit;
    expect(breakEven).not.toBeNull();
    expect(free.netProfit).toBeGreaterThan(0);

    // Charge precisely that, and the edge should be gone. This is the whole claim, in currency.
    const charged = computeMetrics(run(formatFixed(breakEven ?? 0, 8)));
    expect(charged.netProfit).toBeLessThanOrEqual(0);
    // And gone by a hair, not by a mile: rounding down to the money scale is the only difference.
    expect(Math.abs(charged.netProfit)).toBeLessThan(free.unitsTraded);
  });

  it('leaves the strategy profitable one unit of money below it', () => {
    const free = computeMetrics(run('0'));
    const justUnder = (free.breakEvenCommissionPerUnit ?? 0) - 1;
    expect(computeMetrics(run(formatFixed(justUnder, 8))).netProfit).toBeGreaterThan(0);
  });

  it('counts both sides of every round trip', () => {
    // Twenty cycles, one contract, in and out: forty fills of one contract each.
    const metrics = computeMetrics(run('0'));
    expect(metrics.unitsTraded).toBe(40);
  });

  it('scales with position size, and the per-unit figure does not', () => {
    const one = computeMetrics(run('0', 1));
    const five = computeMetrics(run('0', 5));
    expect(five.unitsTraded).toBe(one.unitsTraded * 5);
    expect(five.preCostPnl).toBe(one.preCostPnl * 5);
    // Five times the profit over five times the contracts is the same edge per contract.
    expect(five.breakEvenCommissionPerUnit).toBe(one.breakEvenCommissionPerUnit);
  });

  it('reports what was actually charged, per unit, next to it', () => {
    const metrics = computeMetrics(run('1.5'));
    expect(formatFixed(metrics.commissionPerUnit, 8)).toBe('1.50000000');
    expect(metrics.commissionPaid).toBe(metrics.commissionPerUnit * metrics.unitsTraded);
  });
});

describe('when there is no break-even to report', () => {
  it('says so rather than printing a negative one, when the edge was negative before costs', () => {
    // Inverted: buys the peak and sells the trough.
    const losing = runBacktest(
      {
        instruments: [FUTURE],
        strategy: () => ({
          id: 'inverted',
          onInit: () => undefined,
          onBar: (bar, ctx) => {
            const position = ctx.portfolio.position(bar.instrumentId).qty;
            if (bar.close === 110 && position === 0) {
              ctx.submit({
                instrumentId: bar.instrumentId,
                side: 'buy',
                type: 'market',
                qty: asQty(1),
              });
            } else if (bar.close === 100 && position > 0) {
              ctx.submit({
                instrumentId: bar.instrumentId,
                side: 'sell',
                type: 'market',
                qty: asQty(1),
              });
            }
          },
        }),
        params: {},
        initialCash: '100000',
        seed: 1,
        execution: { commission: perUnitCommission('0') },
        flattenAtEnd: false,
      },
      [sawtooth(20)],
    );
    const metrics = computeMetrics(losing);
    expect(metrics.preCostPnl).toBeLessThan(0);
    expect(metrics.breakEvenCommissionPerUnit).toBeNull();
    expect(formatMetrics(metrics)).toContain('it lost before commission');
  });

  it('stays quiet for a run that never traded', () => {
    const idle = runBacktest(
      {
        instruments: [FUTURE],
        strategy: () => ({ id: 'idle', onInit: () => undefined }),
        params: {},
        initialCash: '100000',
        seed: 1,
      },
      [sawtooth(3)],
    );
    const metrics = computeMetrics(idle);
    expect(metrics.unitsTraded).toBe(0);
    expect(metrics.breakEvenCommissionPerUnit).toBeNull();
    // Nothing to say, so the block is not printed at all.
    expect(formatMetrics(metrics)).not.toContain('break-even per unit');
  });
});

describe('reporting it', () => {
  it('prints it in the costs block and in the JSON', () => {
    const metrics = computeMetrics(run('0.5'));
    const text = formatMetrics(metrics, 'BRL');
    expect(text).toContain('charged per unit');
    expect(text).toContain('break-even per unit');

    const json = JSON.parse(metricsToJsonString(metrics)) as {
      costs: { unitsTraded: number; breakEvenCommissionPerUnit: string | null };
    };
    expect(json.costs.unitsTraded).toBe(40);
    expect(json.costs.breakEvenCommissionPerUnit).not.toBeNull();
  });

  it('reports per contract, not per fixed-point integer, when told the scale', () => {
    // A crypto instrument with five decimals of quantity: 40 fills of 1.0 is 40 units, not 4,000,000.
    const scaled = computeMetrics(run('0'), { qtyExp: 0 });
    expect(scaled.unitsTraded).toBe(40);
    const asCrypto = computeMetrics(run('0'), { qtyExp: 2 });
    expect(asCrypto.unitsTraded).toBeCloseTo(0.4, 8);
  });
});
