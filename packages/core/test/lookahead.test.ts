/**
 * Tests that try to cheat.
 *
 * Every one of these is an attempt to see a price before the engine says it exists. They are
 * written as attacks rather than as assertions on purpose: the no-lookahead guarantee (ADR-0005)
 * is only worth something if somebody tried to break it.
 */

import { describe, expect, it } from 'vitest';
import { type BarEvent, type InstrumentId, type StrategyContext, asQty } from '@tapedeck/core';
import { MONEY } from './helpers.ts';
import { runScript } from './harness.ts';

const ZERO = 0 as InstrumentId;

function buy(ctx: StrategyContext, qty = 1): void {
  ctx.submit({ instrumentId: ZERO, side: 'buy', type: 'market', qty: asQty(qty) });
}

/** Flat, then a bar that jumps. A cheat that works would capture the jump. */
const JUMP_ROWS = [
  { o: 100, h: 100, l: 100, c: 100 },
  { o: 100, h: 100, l: 100, c: 100 },
  { o: 100, h: 200, l: 100, c: 200 },
  { o: 200, h: 200, l: 200, c: 200 },
  { o: 200, h: 200, l: 200, c: 200 },
];

describe('a strategy cannot act on the bar it is looking at', () => {
  it('gains nothing from reacting to the jump bar itself', () => {
    const result = runScript({
      rows: JUMP_ROWS,
      // Perfect foresight of the shape: buy the instant the jump prints.
      onBar: (bar, ctx) => {
        if (bar.close === 200 && ctx.portfolio.position(ZERO).qty === 0) buy(ctx);
      },
      flattenAtEnd: true,
    });

    const fill = result.fills[0];
    expect(fill).toBeDefined();
    // The jump bar closed at 200. The fill happens at the next bar's open, also 200.
    expect(fill?.price).toBe(200);
    expect(result.realizedPnl).toBe(0);
  });

  it('does not fill an order submitted from inside onFill on the same bar', () => {
    const fillBars: number[] = [];
    const result = runScript({
      rows: JUMP_ROWS,
      onBar: (bar, ctx) => {
        if (bar.index === 0) buy(ctx);
      },
      onFill: (_fill, ctx) => {
        if (ctx.portfolio.position(ZERO).qty < 3) buy(ctx);
      },
    });
    for (const fill of result.fills) fillBars.push(fill.ts);
    // Each chained order lands on a later bar than the fill that triggered it.
    expect(new Set(fillBars).size).toBe(fillBars.length);
  });

  it('fills an order placed before the run starts on the first bar, which is not lookahead', () => {
    const result = runScript({
      rows: JUMP_ROWS,
      onInit: (ctx) => {
        buy(ctx);
      },
    });
    expect(result.fills[0]?.price).toBe(100);
    expect(result.fills[0]?.ts).toBe(60_000_000);
  });
});

describe('a strategy cannot reach around the bar it was handed', () => {
  it('has no path from the context to the tape, the engine or the chunk', () => {
    let keys: string[] = [];
    runScript({
      rows: JUMP_ROWS,
      onInit: (ctx) => {
        keys = Object.keys(ctx);
      },
    });
    // This list is an allowlist on purpose: anything added to the context has to be argued for
    // here. `calendar` is on it because a session calendar is public information published years
    // in advance — knowing that next Wednesday is Corpus Christi is not knowing a future price,
    // and it carries no reference to the tape, the chunk or the engine.
    expect(keys.sort()).toEqual(
      [
        'calendar',
        'cancel',
        'clock',
        'instrument',
        'instrumentOf',
        'log',
        'now',
        'openOrders',
        'order',
        'portfolio',
        'replace',
        'rng',
        'signal',
        'submit',
        'use',
      ].sort(),
    );
  });

  it('throws when a retained bar is read on a later callback', () => {
    let stolen: BarEvent | null = null;
    let error: unknown = null;
    runScript({
      rows: JUMP_ROWS,
      onBar: (bar) => {
        if (stolen !== null) {
          try {
            // If this ever returns a number, the strategy just read a bar it does not own.
            void stolen.close;
          } catch (caught: unknown) {
            error = caught;
          }
        }
        stolen = bar;
      },
    });
    expect(error).toBeInstanceOf(TypeError);
  });

  it('cannot index forward: a bar exposes no reference to its neighbours', () => {
    const shapes: string[] = [];
    runScript({
      rows: JUMP_ROWS,
      barViewMode: 'copy',
      onBar: (bar) => shapes.push(Object.keys(bar).sort().join(',')),
    });
    const shape = shapes[0] ?? '';
    expect(shape).toBe('close,closeTs,high,index,instrumentId,kind,low,open,openTs,seq,ts,volume');
  });
});

describe('the engine is honest about what it could not model', () => {
  it('reports sub-bar latency rather than pretending to honour it', () => {
    const result = runScript({
      rows: JUMP_ROWS,
      // 100 ms of latency inside a one-minute bar: unmodellable on bar data.
      execution: { latency: { name: 'test', delayMicros: () => 100_000 } },
      onBar: (bar, ctx) => {
        if (bar.index === 0) buy(ctx);
      },
    });
    expect(result.stats.subBarLatencyIgnored).toBe(1);
    expect(result.warnings.some((w) => w.includes('shorter than one bar'))).toBe(true);
  });

  it('honours latency that spans whole bars exactly', () => {
    const result = runScript({
      rows: JUMP_ROWS,
      // Two and a half minutes of latency on one-minute bars: the order becomes matchable well
      // after the jump, and the strategy pays the new price.
      execution: { latency: { name: 'test', delayMicros: () => 150_000_000 } },
      onBar: (bar, ctx) => {
        if (bar.index === 0) buy(ctx);
      },
    });
    expect(result.fills[0]?.price).toBe(200);
    expect(result.fills[0]?.ts).toBeGreaterThanOrEqual(180_000_000);
  });
});

describe('accounting cannot be flattered by ordering', () => {
  it('charges commission on the entry even when the exit is a forced flatten', () => {
    const result = runScript({
      rows: JUMP_ROWS,
      execution: { commission: { name: 'flat', charge: () => (1 * MONEY) as never } },
      onBar: (bar, ctx) => {
        if (bar.index === 0) buy(ctx);
      },
      flattenAtEnd: true,
    });
    expect(result.commissionPaid).toBe(2 * MONEY);
    expect(result.trades[0]?.commission).toBe(2 * MONEY);
  });
});
