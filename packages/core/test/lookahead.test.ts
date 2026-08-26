/**
 * Tests that try to cheat.
 *
 * Every one of these is an attempt to see a price before the engine says it exists. They are
 * written as attacks rather than as assertions on purpose: the no-lookahead guarantee (ADR-0005)
 * is only worth something if somebody tried to break it.
 *
 * The fixture matters as much as the assertions. An earlier version of this file had the bar after
 * the jump open at the jump's own close, so a correct engine and one that filled at the current
 * bar's close — the first failure the README names — produced the same number and the test passed
 * for both. Every price below is distinct from the ones around it for that reason: an assertion on
 * a fill price has to be able to fail.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type BarEvent,
  type BarIndicator,
  type IndicatorHandle,
  type InstrumentId,
  type OrderId,
  type StrategyContext,
  asPrice,
  asQty,
} from '@tapedeck/core';
import { MONEY } from './helpers.ts';
import { runScript } from './harness.ts';

const ZERO = 0 as InstrumentId;
const MINUTE = 60_000_000;

/**
 * When a fill against bar `i` is stamped.
 *
 * A fill is priced at the open of the bar it matched and timestamped at that bar's **close**, which
 * is the instant the whole bar became knowable. Naming it here keeps every assertion below saying
 * which bar it means rather than a raw microsecond count.
 */
const closeOf = (barIndex: number): number => (barIndex + 1) * MINUTE;

function buy(ctx: StrategyContext, qty = 1): OrderId {
  return ctx.submit({ instrumentId: ZERO, side: 'buy', type: 'market', qty: asQty(qty) });
}

/**
 * Flat, a bar that jumps, then a bar that opens somewhere else again.
 *
 * The four prices are deliberately all different where it counts. A strategy that reacts to the
 * jump bar (close 200) fills at the next bar's open, 150. An engine that filled at the reacting
 * bar's close would say 200; one that filled at its open would say 100. The test can tell all
 * three apart, which is the only reason it is worth running.
 */
const JUMP_ROWS = [
  { o: 100, h: 100, l: 100, c: 100 }, // 0
  { o: 100, h: 100, l: 100, c: 100 }, // 1
  { o: 100, h: 200, l: 100, c: 200 }, // 2 — the jump
  { o: 150, h: 200, l: 150, c: 200 }, // 3 — opens away from the jump's close
  { o: 200, h: 200, l: 200, c: 200 }, // 4
];

describe('a strategy cannot act on the bar it is looking at', () => {
  it('fills at the next bar’s open, not at the close it reacted to', () => {
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
    // 150 is the open of the bar after the jump. 200 would mean the engine filled at the close the
    // strategy had just read, and 100 would mean it filled at the jump bar's own open.
    expect(fill?.price).toBe(150);
    expect(fill?.ts).toBe(closeOf(3));
    // Bought at 150, flattened at 200: the reaction is worth something, but only what the market
    // offered after the strategy asked.
    expect(result.realizedPnl).toBe(50 * MONEY);
  });

  it('cannot take a price only the current bar traded, even with an immediate-or-cancel order', () => {
    // Bar 2 traded down to 100 and bar 3's low is 150, so 100 is a price only the bar being looked
    // at can offer. An IOC limit at 100 is the sharpest possible way to ask for it.
    const result = runScript({
      rows: JUMP_ROWS,
      onBar: (bar, ctx) => {
        if (bar.index !== 2) return;
        ctx.submit({
          instrumentId: ZERO,
          side: 'buy',
          type: 'limit',
          qty: asQty(1),
          limitPrice: asPrice(100),
          tif: 'ioc',
        });
      },
    });

    expect(result.fills).toHaveLength(0);
    expect(result.stats.ordersCancelled).toBe(1);
  });

  it('cannot trigger a stop on a level only the current bar reached', () => {
    // 120 sits inside bar 2's range and outside every later bar's. A buy stop there is asking the
    // engine to look back into the bar the strategy is holding.
    const result = runScript({
      rows: JUMP_ROWS,
      onBar: (bar, ctx) => {
        if (bar.index !== 2) return;
        ctx.submit({
          instrumentId: ZERO,
          side: 'buy',
          type: 'stop',
          qty: asQty(1),
          stopPrice: asPrice(120),
        });
      },
    });

    const fill = result.fills[0];
    expect(fill).toBeDefined();
    // The next bar opens at 150, already through the stop, so the stop pays 150 rather than the
    // 120 it names. A fill at 120 would mean the engine walked back into bar 2.
    expect(fill?.price).toBe(150);
    expect(fill?.ts).toBe(closeOf(3));
  });

  it('cannot reprice an order into the bar it is currently on', () => {
    // Rest a limit far below, then amend it to bar 2's low on bar 2 itself. If `replace` re-entered
    // matching for the current bar, this would fill at 100.
    let id: OrderId | null = null;
    const result = runScript({
      rows: JUMP_ROWS,
      onBar: (bar, ctx) => {
        if (bar.index === 0) {
          id = ctx.submit({
            instrumentId: ZERO,
            side: 'buy',
            type: 'limit',
            qty: asQty(1),
            limitPrice: asPrice(10),
          });
        }
        if (bar.index === 2 && id !== null) ctx.replace(id, { limitPrice: asPrice(100) });
      },
    });

    // Bar 3 never trades at 100 or below, and neither does bar 4, so the amended order rests
    // unfilled to the end of the run.
    expect(result.fills).toHaveLength(0);
  });

  it('does not fill an order submitted from inside onFill on the same bar', () => {
    const result = runScript({
      rows: JUMP_ROWS,
      onBar: (bar, ctx) => {
        if (bar.index === 0) buy(ctx);
      },
      onFill: (_fill, ctx) => {
        if (ctx.portfolio.position(ZERO).qty < 3) buy(ctx);
      },
    });

    // One fill per bar, each on the bar after the fill that chained it: distinct timestamps would
    // also pass if two fills landed out of order, so the sequence itself is asserted.
    expect(result.fills.map((fill) => fill.ts)).toEqual([closeOf(1), closeOf(2), closeOf(3)]);
  });

  it('fills an order placed before the run starts on the first bar, which is not lookahead', () => {
    // The permitted case, asserted so the guarantee cannot be tightened into uselessness.
    const result = runScript({
      rows: JUMP_ROWS,
      onInit: (ctx) => {
        buy(ctx);
      },
    });
    expect(result.fills[0]?.price).toBe(100);
    expect(result.fills[0]?.ts).toBe(closeOf(0));
  });
});

describe('a strategy cannot reach around the bar it was handed', () => {
  it('has no path from the context to the tape, the engine or the chunk', () => {
    let keys: (string | symbol)[] = [];
    let prototypeKeys: (string | symbol)[] = [];
    let prototypeIsPlain = false;

    runScript({
      rows: JUMP_ROWS,
      onInit: (ctx) => {
        // `Reflect.ownKeys` rather than `Object.keys`: a getter added as a non-enumerable property
        // or under a symbol would be invisible to the latter, and a side channel added that way
        // would be invisible to this test.
        keys = Reflect.ownKeys(ctx);
        const proto: unknown = Object.getPrototypeOf(ctx);
        prototypeIsPlain = proto === Object.prototype || proto === null;
        prototypeKeys = proto === null ? [] : Reflect.ownKeys(proto as object);
      },
    });

    // This list is an allowlist on purpose: anything added to the context has to be argued for
    // here. `calendar` is on it because a session calendar is public information published years
    // in advance — knowing that next Wednesday is Corpus Christi is not knowing a future price,
    // and it carries no reference to the tape, the chunk or the engine.
    expect([...keys].sort()).toEqual(
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

    // A plain object literal, so nothing reaches the strategy through a class prototype either.
    expect(prototypeIsPlain).toBe(true);
    expect(prototypeKeys).toEqual(Reflect.ownKeys(Object.prototype));
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
      onBar: (bar) => shapes.push(Reflect.ownKeys(bar).sort().join(',')),
    });
    const shape = shapes[0] ?? '';
    expect(shape).toBe('close,closeTs,high,index,instrumentId,kind,low,open,openTs,seq,ts,volume');
  });

  it('cannot read the future through an order snapshot', () => {
    // `openOrders()` hands back live state. If a snapshot carried a reference to the order object
    // the broker is matching, a strategy could watch it change inside the current bar.
    let shape = '';
    runScript({
      rows: JUMP_ROWS,
      onBar: (bar, ctx) => {
        if (bar.index === 0) {
          ctx.submit({
            instrumentId: ZERO,
            side: 'buy',
            type: 'limit',
            qty: asQty(1),
            limitPrice: asPrice(10),
          });
        }
        const snapshot = ctx.openOrders()[0];
        if (snapshot !== undefined && shape === '') {
          shape = Reflect.ownKeys(snapshot).sort().join(',');
        }
      },
    });

    expect(shape).toBe(
      [
        'activeFrom',
        'avgFillPrice',
        'filledQty',
        'id',
        'instrumentId',
        'leavesQty',
        'limitPrice',
        'oco',
        'qty',
        'side',
        'status',
        'stopPrice',
        'submittedTs',
        'tag',
        'tif',
        'triggered',
        'type',
      ].join(','),
    );
  });

  it('never feeds an indicator a bar the strategy has not been shown', () => {
    // The engine owns the indicator update (ADR-0010), which is exactly the place a value from the
    // next bar could arrive early. This records what the indicator was fed and compares it against
    // what the strategy had seen at that moment.
    const fed: number[] = [];
    const seen: number[] = [];
    let handle: IndicatorHandle | null = null;

    const probe = (): BarIndicator => {
      let last: number | null = null;
      return {
        name: 'probe',
        get ready() {
          return last !== null;
        },
        get value() {
          return last;
        },
        update(sample) {
          fed.push(sample.close);
          last = sample.close;
          return last;
        },
        reset() {
          last = null;
          fed.length = 0;
        },
      };
    };

    runScript({
      rows: JUMP_ROWS,
      onInit: (ctx) => {
        handle = ctx.use(probe());
      },
      onBar: (bar) => {
        seen.push(bar.close);
        // The indicator has been fed exactly the bars the strategy has seen, this one included.
        expect(fed).toEqual(seen);
        expect(handle?.value).toBe(bar.close);
      },
    });

    expect(seen).toHaveLength(JUMP_ROWS.length);
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
      // Exactly two bars of latency. The order is submitted while bar 0 is being processed, which
      // is knowable at 60s, so it becomes matchable at 180s — bar 3's open, to the microsecond.
      execution: { latency: { name: 'test', delayMicros: () => 2 * MINUTE } },
      onBar: (bar, ctx) => {
        if (bar.index === 0) buy(ctx);
      },
    });

    const fill = result.fills[0];
    expect(fill?.ts).toBe(closeOf(3));
    // 150 is bar 3's open. 100 is what bars 1 and 2 opened at, and is what an engine that let the
    // order through early would have paid.
    expect(fill?.price).toBe(150);
    // Nothing was dropped: the latency landed on a bar boundary rather than inside a bar.
    expect(result.stats.subBarLatencyIgnored).toBe(0);
  });

  it('drops the part of a latency that lands inside a bar, and says it did', () => {
    const result = runScript({
      rows: JUMP_ROWS,
      // Two and a half bars. Matchable at 210s, thirty seconds into bar 3 — and where inside a bar
      // a price sits is exactly what OHLCV cannot say.
      execution: { latency: { name: 'test', delayMicros: () => 150_000_000 } },
      onBar: (bar, ctx) => {
        if (bar.index === 0) buy(ctx);
      },
    });

    const fill = result.fills[0];
    // The engine matches the bar its activeFrom fell into, at that bar's open — a price that
    // printed thirty seconds before the order was live. It does not pretend otherwise: the half
    // bar it could not place is counted and warned about, which is the whole of ADR-0005's answer
    // to sub-bar timing. The alternative, skipping the bar, would invent a delay in the other
    // direction and say nothing.
    expect(fill?.price).toBe(150);
    expect(fill?.ts).toBe(closeOf(3));
    expect(result.stats.subBarLatencyIgnored).toBe(1);
    expect(result.warnings.some((w) => w.includes('shorter than one bar'))).toBe(true);
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

// ------------------------------------------------------------------- generated attacks

/**
 * Arbitrary tapes, built so that every bar is internally consistent and no two consecutive bars
 * share an open. Hand-written attacks can only probe the shapes their author thought of; these two
 * properties hold for any shape at all.
 */
const tapeArb = fc
  .array(
    fc.record({
      base: fc.integer({ min: 50, max: 5_000 }),
      range: fc.integer({ min: 1, max: 400 }),
      openOffset: fc.integer({ min: 0, max: 400 }),
      closeOffset: fc.integer({ min: 0, max: 400 }),
    }),
    { minLength: 6, maxLength: 30 },
  )
  .map((rows) =>
    rows.map((row) => {
      const low = row.base;
      const high = row.base + row.range;
      return {
        o: Math.min(low + (row.openOffset % (row.range + 1)), high),
        h: high,
        l: low,
        c: Math.min(low + (row.closeOffset % (row.range + 1)), high),
      };
    }),
  );

/** What the generated strategy remembers about an order, so a fill can be checked against it. */
interface Submission {
  readonly barIndex: number;
  readonly type: 'market' | 'limit';
}

/**
 * One strategy, deterministic and dependent only on the bar in front of it: buy an up bar, sell
 * out of a down one, and leave a limit resting under the market every third bar.
 */
function script(submissions?: Map<OrderId, Submission>) {
  return {
    onBar: (bar: BarEvent, ctx: StrategyContext) => {
      const position = ctx.portfolio.position(ZERO).qty;
      const record = (id: OrderId, type: 'market' | 'limit'): void => {
        submissions?.set(id, { barIndex: bar.index, type });
      };
      if (bar.close > bar.open && position <= 0) record(buy(ctx), 'market');
      else if (bar.close < bar.open && position > 0) {
        record(
          ctx.submit({ instrumentId: ZERO, side: 'sell', type: 'market', qty: asQty(position) }),
          'market',
        );
      }
      if (bar.index % 3 === 0) {
        record(
          ctx.submit({
            instrumentId: ZERO,
            side: 'buy',
            type: 'limit',
            qty: asQty(1),
            limitPrice: asPrice(bar.low),
          }),
          'limit',
        );
      }
    },
  };
}

describe('no run can depend on a bar it has not reached', () => {
  it('produces the same fills over a prefix as over the whole tape', () => {
    // The property that makes the guarantee structural rather than anecdotal: if any part of the
    // engine consulted a later bar, truncating the tape would change what happened before the cut.
    // Nothing in the hand-written attacks above can rule that out for shapes nobody thought of.
    fc.assert(
      fc.property(tapeArb, fc.integer({ min: 3, max: 30 }), (rows, cut) => {
        const k = Math.min(cut, rows.length);
        const bound = (k - 1) * MINUTE;

        const whole = runScript({ rows, ...script(), flattenAtEnd: false });
        const prefix = runScript({ rows: rows.slice(0, k), ...script(), flattenAtEnd: false });

        const shown = (fills: typeof whole.fills) =>
          fills
            .filter((fill) => fill.ts <= bound)
            .map(
              (fill) => `${String(fill.ts)}:${fill.side}:${String(fill.price)}:${String(fill.qty)}`,
            );

        expect(shown(prefix.fills)).toEqual(shown(whole.fills));
      }),
      { numRuns: 200 },
    );
  });

  it('never fills against a bar that had already closed when the order became matchable', () => {
    // The invariant behind the boundary bug this file found: with a latency of exactly one bar,
    // `activeFrom` lands on a bar's close, and the gate in the broker admitted that bar because it
    // compared with `>` rather than `>=`. The order then filled at that bar's open — a price up to
    // a whole bar older than the order itself. Any latency at all can land on a boundary, so the
    // property is asserted over generated ones rather than over the one that happened to break.
    fc.assert(
      fc.property(tapeArb, fc.integer({ min: 0, max: 3 * MINUTE }), (rows, delay) => {
        const activeFrom = new Map<OrderId, number>();
        const result = runScript({
          rows,
          flattenAtEnd: false,
          execution: { latency: { name: 'test', delayMicros: () => delay } },
          onBar: (bar, ctx) => {
            if (bar.index % 2 !== 0) return;
            const id = buy(ctx);
            const snapshot = ctx.openOrders().find((order) => order.id === id);
            if (snapshot !== undefined) activeFrom.set(id, snapshot.activeFrom);
          },
        });

        for (const fill of result.fills) {
          const live = activeFrom.get(fill.orderId);
          if (live === undefined) continue;
          // `fill.ts` is the close of the bar that matched. Equal would mean the bar ended at the
          // instant the order woke up, and a bar's interval is half-open.
          expect(fill.ts).toBeGreaterThan(live);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('never fills an order before the bar after the one that submitted it', () => {
    fc.assert(
      fc.property(tapeArb, (rows) => {
        const submissions = new Map<OrderId, Submission>();
        const result = runScript({ rows, ...script(submissions), flattenAtEnd: false });

        for (const fill of result.fills) {
          const submission = submissions.get(fill.orderId);
          expect(submission).toBeDefined();
          if (submission === undefined) continue;

          // Strictly later: the earliest legal match is the bar after the one that submitted it.
          expect(fill.ts).toBeGreaterThanOrEqual(closeOf(submission.barIndex + 1));

          // And the price has to be one the market printed on the bar it matched, which the
          // timestamp names: a fill is stamped at the close of the bar it filled against.
          const barIndex = fill.ts / MINUTE - 1;
          const row = rows[barIndex];
          expect(row).toBeDefined();
          expect(fill.price).toBeGreaterThanOrEqual(row?.l ?? 0);
          expect(fill.price).toBeLessThanOrEqual(row?.h ?? 0);

          // A market order takes the open of the bar it matched and nothing else. Without this the
          // property would accept a fill at that bar's close, which for an order submitted on the
          // bar before is the first failure the README names — and a hand-written case can only
          // rule it out for the shapes its author chose.
          if (submission.type === 'market') expect(fill.price).toBe(row?.o);
        }
      }),
      { numRuns: 200 },
    );
  });
});
