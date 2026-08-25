/**
 * The tick path.
 *
 * Everything the bar path has to approximate is exact here: latency is honoured to the
 * microsecond, and the intrabar policy never applies because a tick *is* the path. These tests
 * exist as much to prove that claim as to cover the code.
 */

import { describe, expect, it } from 'vitest';
import {
  type InstrumentId,
  type Side,
  type Strategy,
  type StrategyContext,
  type TickEvent,
  Engine,
  PRESETS,
  TickChunkBuilder,
  asPrice,
  asQty,
  fixedLatency,
  fixedTicksSlippage,
  volumeParticipation,
} from '@tapedeck/core';
import { TEST_FUTURE } from './helpers.ts';

const ZERO = 0 as InstrumentId;

interface TickRow {
  readonly ts: number;
  readonly price: number;
  readonly size?: number;
  readonly aggressor?: -1 | 0 | 1;
}

interface TickScript {
  readonly rows: readonly TickRow[];
  readonly execution?: Parameters<typeof runTicks>[0]['execution'];
  readonly onTick?: (tick: TickEvent, ctx: StrategyContext) => void;
}

function runTicks(options: {
  rows: readonly TickRow[];
  execution?: ConstructorParameters<typeof Engine>[0]['execution'];
  onTick?: ((tick: TickEvent, ctx: StrategyContext) => void) | undefined;
}) {
  const strategy: Strategy = {
    id: 'tick-script',
    onInit: () => undefined,
    onTick: (tick, ctx) => options.onTick?.(tick, ctx),
  };
  const engine = new Engine({
    instruments: [TEST_FUTURE],
    strategy: () => strategy,
    params: {},
    initialCash: '100000',
    seed: 1,
    execution: options.execution,
    flattenAtEnd: false,
  });
  const builder = new TickChunkBuilder(ZERO, Math.max(1, options.rows.length));
  for (const row of options.rows) {
    builder.push(row.ts, row.price, row.size ?? 10, row.aggressor ?? 0);
  }
  engine.feedTicks(builder.build());
  return engine.finish();
}

function order(
  ctx: StrategyContext,
  spec: {
    side: Side;
    type: 'market' | 'limit' | 'stop' | 'stop_limit';
    qty?: number;
    limitPrice?: number;
    stopPrice?: number;
  },
) {
  return ctx.submit({
    instrumentId: ZERO,
    side: spec.side,
    type: spec.type,
    qty: asQty(spec.qty ?? 1),
    limitPrice: spec.limitPrice === undefined ? undefined : asPrice(spec.limitPrice),
    stopPrice: spec.stopPrice === undefined ? undefined : asPrice(spec.stopPrice),
  });
}

/** Submits once, on the first print, then stays out of the way. */
function once(spec: Parameters<typeof order>[1]): TickScript['onTick'] {
  let done = false;
  return (_tick, ctx) => {
    if (done) return;
    done = true;
    order(ctx, spec);
  };
}

const RISING: TickRow[] = [
  { ts: 1_000, price: 100 },
  { ts: 2_000, price: 101 },
  { ts: 3_000, price: 105 },
  { ts: 4_000, price: 110 },
];

describe('tick replay', () => {
  it('counts prints and marks the portfolio at the last price', () => {
    const result = runTicks({ rows: RISING });
    expect(result.stats.ticks).toBe(4);
    expect(result.stats.bars).toBe(0);
    expect(result.endTs).toBe(4_000);
  });

  it('exposes the aggressor side when the venue reports it', () => {
    const seen: (Side | null)[] = [];
    runTicks({
      rows: [
        { ts: 1, price: 100, aggressor: 1 },
        { ts: 2, price: 100, aggressor: -1 },
        { ts: 3, price: 100, aggressor: 0 },
      ],
      onTick: (tick) => seen.push(tick.aggressor),
    });
    expect(seen).toEqual(['buy', 'sell', null]);
  });
});

describe('tick matching', () => {
  it('fills a market order at the next print, never the current one', () => {
    const result = runTicks({ rows: RISING, onTick: once({ side: 'buy', type: 'market' }) });
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]?.price).toBe(101);
    expect(result.fills[0]?.ts).toBe(2_000);
  });

  it('fills a resting limit only when a print reaches it', () => {
    const result = runTicks({
      rows: [
        { ts: 1_000, price: 100 },
        { ts: 2_000, price: 99 },
        { ts: 3_000, price: 96 },
      ],
      onTick: once({ side: 'buy', type: 'limit', limitPrice: 97 }),
    });
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]?.price).toBe(96);
    expect(result.fills[0]?.liquidity).toBe('maker');
  });

  it('triggers a stop at the print that crosses it and pays slippage', () => {
    const result = runTicks({
      rows: RISING,
      execution: { ...PRESETS.ideal(), slippage: fixedTicksSlippage(1) },
      onTick: once({ side: 'buy', type: 'stop', stopPrice: 105 }),
    });
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]?.price).toBe(106);
    expect(result.fills[0]?.ts).toBe(3_000);
  });

  it('turns a stop-limit into a limit at the trigger print, with no ambiguity to resolve', () => {
    const result = runTicks({
      rows: [
        { ts: 1_000, price: 100 },
        { ts: 2_000, price: 106 },
        { ts: 3_000, price: 104 },
      ],
      onTick: once({ side: 'buy', type: 'stop_limit', stopPrice: 105, limitPrice: 105 }),
    });
    expect(result.stats.stopLimitDeferrals).toBe(0);
    expect(result.fills[0]?.price).toBe(104);
    expect(result.fills[0]?.ts).toBe(3_000);
  });

  it('honours latency to the microsecond', () => {
    const result = runTicks({
      rows: RISING,
      execution: { ...PRESETS.ideal(), latency: fixedLatency(1_500) },
      // Submitted at t=1000, matchable from t=2500, so the print at t=2000 is missed.
      onTick: once({ side: 'buy', type: 'market' }),
    });
    expect(result.fills[0]?.ts).toBe(3_000);
    expect(result.stats.subBarLatencyIgnored).toBe(0);
  });

  it('caps a fill at a share of the print size', () => {
    const result = runTicks({
      rows: [
        { ts: 1_000, price: 100, size: 100 },
        { ts: 2_000, price: 100, size: 100 },
        { ts: 3_000, price: 100, size: 100 },
      ],
      execution: { ...PRESETS.ideal(), liquidity: volumeParticipation(1_000) },
      onTick: once({ side: 'buy', type: 'market', qty: 25 }),
    });
    expect(result.fills.map((f) => f.qty)).toEqual([10, 10]);
  });
});
