import { describe, expect, it } from 'vitest';
import {
  type BarIndicator,
  type IndicatorHandle,
  type InstrumentId,
  type OrderId,
  type StrategyContext,
  NotFoundError,
  asPrice,
  asQty,
} from '@tapedeck/core';
import { MONEY, TEST_FUTURE } from './helpers.ts';
import { runScript } from './harness.ts';

const ZERO = 0 as InstrumentId;

/** Shared across the indicator tests so a handle can outlive the callback that created it. */
let handleRef: IndicatorHandle | null = null;
let lateHandle: IndicatorHandle | null = null;

function limitBuy(ctx: StrategyContext, price: number, qty = 1): OrderId {
  return ctx.submit({
    instrumentId: ZERO,
    side: 'buy',
    type: 'limit',
    qty: asQty(qty),
    limitPrice: asPrice(price),
    tag: 'entry',
  });
}

const ROWS = [
  { o: 100, h: 100, l: 100, c: 100 },
  { o: 100, h: 100, l: 100, c: 100 },
  { o: 100, h: 100, l: 100, c: 100 },
  { o: 100, h: 105, l: 90, c: 100 },
];

describe('order inspection', () => {
  it('reports an order snapshot with the tag the strategy attached', () => {
    let snapshot: ReturnType<StrategyContext['order']> = undefined;
    runScript({
      rows: ROWS,
      onBar: (bar, ctx) => {
        if (bar.index === 0) {
          const id = limitBuy(ctx, 95);
          snapshot = ctx.order(id);
        }
      },
    });
    expect(snapshot).toMatchObject({
      side: 'buy',
      type: 'limit',
      status: 'pending',
      limitPrice: 95,
      leavesQty: 1,
      tag: 'entry',
      triggered: false,
    });
  });

  it('returns undefined for an id that was never issued', () => {
    let missing: unknown = 'unset';
    runScript({
      rows: ROWS,
      onInit: (ctx) => {
        missing = ctx.order(999 as OrderId);
      },
    });
    expect(missing).toBeUndefined();
  });

  it('lists open orders, optionally filtered by instrument', () => {
    let all = 0;
    let filtered = 0;
    let other = 0;
    runScript({
      rows: ROWS,
      onBar: (bar, ctx) => {
        if (bar.index === 0) {
          limitBuy(ctx, 95);
          limitBuy(ctx, 94);
        }
        if (bar.index === 1) {
          all = ctx.openOrders().length;
          filtered = ctx.openOrders(ZERO).length;
          other = ctx.openOrders(7 as InstrumentId).length;
        }
      },
    });
    expect(all).toBe(2);
    expect(filtered).toBe(2);
    expect(other).toBe(0);
  });
});

describe('amendments', () => {
  it('moves a resting limit so that it fills where the new price says', () => {
    const result = runScript({
      rows: ROWS,
      onBar: (bar, ctx) => {
        if (bar.index === 0) {
          const id = limitBuy(ctx, 80);
          ctx.replace(id, { limitPrice: asPrice(95) });
        }
      },
    });
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]?.price).toBe(95);
  });

  it('grows the quantity of a resting order', () => {
    const result = runScript({
      rows: ROWS,
      onBar: (bar, ctx) => {
        if (bar.index === 0) {
          const id = limitBuy(ctx, 95, 1);
          expect(ctx.replace(id, { qty: asQty(3) })).toBe(true);
        }
      },
    });
    expect(result.fills[0]?.qty).toBe(3);
  });

  it('refuses amendments that the instrument would not accept', () => {
    const outcomes: boolean[] = [];
    runScript({
      rows: ROWS,
      instrument: { ...TEST_FUTURE, tickSize: '5' },
      onBar: (bar, ctx) => {
        if (bar.index !== 0) return;
        const id = limitBuy(ctx, 95);
        outcomes.push(ctx.replace(id, { limitPrice: asPrice(96) })); // not tick-aligned
        outcomes.push(ctx.replace(id, { qty: asQty(0) })); // below what is already filled
        outcomes.push(ctx.replace(id, { stopPrice: asPrice(90) })); // not a stop order
        outcomes.push(ctx.replace(999 as OrderId, { qty: asQty(1) })); // unknown order
      },
    });
    expect(outcomes).toEqual([false, false, false, false]);
  });

  it('reports failure when cancelling an order that is already gone', () => {
    const outcomes: boolean[] = [];
    runScript({
      rows: ROWS,
      onBar: (bar, ctx) => {
        if (bar.index !== 0) return;
        const id = limitBuy(ctx, 95);
        outcomes.push(ctx.cancel(id));
        outcomes.push(ctx.cancel(id));
      },
    });
    expect(outcomes).toEqual([true, false]);
  });
});

describe('indicators', () => {
  /**
   * A stand-in for the real library. The core must not depend on `@tapedeck/indicators` even in
   * its tests — the arrow points inward (ADR-0001) — and testing against the contract rather than
   * an implementation is what proves the contract is enough.
   */
  function recorder(name: string, log: string[]): BarIndicator {
    let last: number | null = null;
    return {
      name,
      get ready() {
        return last !== null;
      },
      get value() {
        return last;
      },
      update(bar) {
        log.push(name);
        last = bar.close;
        return last;
      },
      reset() {
        last = null;
      },
    };
  }

  it('updates once per bar, before the strategy sees it', () => {
    const seen: { close: number; indicator: number | null }[] = [];
    runScript({
      rows: [
        { o: 100, h: 100, l: 100, c: 100 },
        { o: 101, h: 101, l: 101, c: 101 },
        { o: 102, h: 102, l: 102, c: 102 },
      ],
      onInit: (ctx) => {
        const handle = ctx.use(recorder('probe', []));
        handleRef = handle;
      },
      onBar: (bar) => {
        seen.push({ close: bar.close, indicator: handleRef?.value ?? null });
      },
    });
    // The value read inside onBar always belongs to the bar being shown, never the previous one.
    expect(seen).toEqual([
      { close: 100, indicator: 100 },
      { close: 101, indicator: 101 },
      { close: 102, indicator: 102 },
    ]);
  });

  it('updates in registration order', () => {
    const log: string[] = [];
    runScript({
      rows: [
        { o: 1, h: 1, l: 1, c: 1 },
        { o: 2, h: 2, l: 2, c: 2 },
      ],
      onInit: (ctx) => {
        ctx.use(recorder('first', log));
        ctx.use(recorder('second', log));
      },
    });
    expect(log).toEqual(['first', 'second', 'first', 'second']);
  });

  it('hands back a read-only handle with no way to drive the indicator', () => {
    const handles: IndicatorHandle[] = [];
    runScript({
      rows: ROWS,
      onInit: (ctx) => {
        handles.push(ctx.use(recorder('probe', [])));
      },
    });
    const handle = handles[0];
    expect(handle).toBeDefined();
    expect(Object.keys(handle ?? {}).sort()).toEqual(['name', 'ready', 'value']);
    expect(Object.isFrozen(handle)).toBe(true);
  });

  it('refuses to register against an instrument that does not exist', () => {
    expect(() =>
      runScript({
        rows: ROWS,
        onInit: (ctx) => {
          ctx.use(recorder('probe', []), { instrumentId: 9 as InstrumentId });
        },
      }),
    ).toThrow(NotFoundError);
  });

  it('can be registered after the run has started', () => {
    let value: number | null = null;
    runScript({
      rows: [
        { o: 1, h: 1, l: 1, c: 1 },
        { o: 2, h: 2, l: 2, c: 2 },
        { o: 3, h: 3, l: 3, c: 3 },
      ],
      onBar: (bar, ctx) => {
        if (bar.index === 0) lateHandle = ctx.use(recorder('late', []));
        value = lateHandle?.value ?? null;
      },
    });
    // Registered while bar 0 was being handled, so it starts receiving from bar 1.
    expect(value).toBe(3);
  });
});

describe('instrument access', () => {
  it('resolves an instrument by id and by venue and symbol', () => {
    let byId = '';
    let bySymbol = '';
    let error: unknown = null;
    runScript({
      rows: ROWS,
      onInit: (ctx) => {
        byId = ctx.instrument(ZERO).symbol;
        bySymbol = ctx.instrumentOf('TEST', 'TF').symbol;
        try {
          ctx.instrumentOf('TEST', 'NOPE');
        } catch (caught: unknown) {
          error = caught;
        }
      },
    });
    expect(byId).toBe('TF');
    expect(bySymbol).toBe('TF');
    expect(error).toBeInstanceOf(NotFoundError);
  });
});

describe('portfolio view', () => {
  it('reports cash, equity and margin as the run progresses', () => {
    const snapshots: number[] = [];
    const result = runScript({
      rows: [
        { o: 100, h: 100, l: 100, c: 100 },
        { o: 100, h: 100, l: 100, c: 100 },
        { o: 120, h: 120, l: 120, c: 120 },
      ],
      onBar: (bar, ctx) => {
        if (bar.index === 0) {
          ctx.submit({ instrumentId: ZERO, side: 'buy', type: 'market', qty: asQty(1) });
        }
        snapshots.push(ctx.portfolio.equity());
        if (bar.index === 2) {
          expect(ctx.portfolio.marginUsed()).toBe(100 * MONEY);
          expect(ctx.portfolio.cash()).toBe(100_000 * MONEY);
          expect(ctx.portfolio.unrealizedPnl()).toBe(20 * MONEY);
          expect(ctx.portfolio.realizedPnl()).toBe(0);
          expect(ctx.portfolio.position(ZERO).qty).toBe(1);
        }
      },
    });
    expect(snapshots).toEqual([100_000 * MONEY, 100_000 * MONEY, 100_020 * MONEY]);
    expect(result.finalEquity).toBe(100_020 * MONEY);
  });
});

describe('signals and logging', () => {
  it('records published intents alongside the fills they led to', () => {
    const result = runScript({
      rows: ROWS,
      onBar: (bar, ctx) => {
        if (bar.index === 0) {
          ctx.signal(ZERO, 'long', 0.75, 'breakout');
          ctx.signal(ZERO, 'flat');
        }
      },
    });
    expect(result.stats.signals).toBe(2);
    expect(result.signals[0]).toMatchObject({ direction: 'long', strength: 0.75, tag: 'breakout' });
    expect(result.signals[1]).toMatchObject({ direction: 'flat', strength: 1, tag: null });
  });

  it('stamps strategy log entries with simulated time', () => {
    const result = runScript({
      rows: ROWS,
      onBar: (bar, ctx) => {
        if (bar.index === 1) ctx.log.info('halfway', { index: bar.index });
      },
    });
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]?.ts).toBe(120_000_000);
    expect(result.logs[0]?.fields).toEqual({ index: 1 });
  });

  it('logs a warning when the broker rejects an order', () => {
    const result = runScript({
      rows: ROWS,
      onBar: (bar, ctx) => {
        if (bar.index === 0) {
          ctx.submit({ instrumentId: ZERO, side: 'buy', type: 'market', qty: asQty(0) });
        }
      },
    });
    expect(result.logs.some((entry) => entry.level === 'warn')).toBe(true);
  });

  it('gives the strategy its own reproducible random stream', () => {
    const draw = (seed: number): number[] => {
      const values: number[] = [];
      runScript({
        rows: ROWS,
        seed,
        onBar: (_bar, ctx) => values.push(ctx.rng.nextU32()),
      });
      return values;
    };
    expect(draw(5)).toEqual(draw(5));
    expect(draw(5)).not.toEqual(draw(6));
  });

  it('exposes simulated time through both the clock and the shortcut', () => {
    runScript({
      rows: ROWS,
      onBar: (bar, ctx) => {
        expect(ctx.now()).toBe(bar.closeTs);
        expect(ctx.clock.now()).toBe(bar.closeTs);
      },
    });
  });
});
