/**
 * One-cancels-other groups, and the amendment record.
 *
 * The test that matters is `both legs of a bracket cannot execute on the same bar`. Building a
 * bracket out of two orders and a `cancel` inside `onFill` — which is what this engine required
 * until now — leaves the second leg live for one more candidate, and a bar that touches both the
 * stop and the target executes both. That is a position that closes twice and a PnL that never
 * happened. The first assertion below is that bug, reproduced against the old pattern, so the
 * difference is visible rather than asserted.
 */

import { describe, expect, it } from 'vitest';
import {
  type OrderAmendedEvent,
  type OrderCancelledEvent,
  type OrderFilledEvent,
  asPrice,
  asQty,
} from '@tapedeck/core';
import { runScript } from './harness.ts';

/**
 * A bar that touches both sides of a bracket: it opens at 100, trades down through 95 and up
 * through 105 before closing. Which came first is unknowable from OHLCV, which is the point.
 */
const ROWS = [
  { o: 100, h: 100, l: 100, c: 100 },
  { o: 100, h: 100, l: 100, c: 100 },
  { o: 100, h: 106, l: 94, c: 100 },
  { o: 100, h: 100, l: 100, c: 100 },
];

describe('a bracket without OCO, which is what this engine used to require', () => {
  it('can execute both legs on a bar that touches both, closing a position twice', () => {
    const fills: OrderFilledEvent[] = [];
    runScript({
      rows: ROWS,
      onBar: (bar, ctx) => {
        if (bar.index !== 0) return;
        ctx.submit({ instrumentId: bar.instrumentId, side: 'buy', type: 'market', qty: asQty(1) });
      },
      onFill: (fill, ctx) => {
        fills.push(fill);
        if (fill.tag !== null) return;
        // The old pattern: two legs, and a cancel that arrives too late.
        ctx.submit({
          instrumentId: fill.instrumentId,
          side: 'sell',
          type: 'stop',
          qty: asQty(1),
          stopPrice: asPrice(95),
          tag: 'stop',
        });
        ctx.submit({
          instrumentId: fill.instrumentId,
          side: 'sell',
          type: 'limit',
          qty: asQty(1),
          limitPrice: asPrice(105),
          tag: 'target',
        });
      },
    });

    const exits = fills.filter((fill) => fill.tag !== null);
    // Both legs executed: the position was closed, and then closed again.
    expect(exits.map((fill) => fill.tag).sort()).toEqual(['stop', 'target']);
  });
});

describe('a bracket with OCO', () => {
  it('executes exactly one leg, on the same bar that touches both', () => {
    const fills: OrderFilledEvent[] = [];
    const cancels: OrderCancelledEvent[] = [];
    runScript({
      rows: ROWS,
      onBar: (bar, ctx) => {
        if (bar.index !== 0) return;
        ctx.submit({ instrumentId: bar.instrumentId, side: 'buy', type: 'market', qty: asQty(1) });
      },
      onFill: (fill, ctx) => {
        fills.push(fill);
        if (fill.tag !== null) return;
        ctx.submit({
          instrumentId: fill.instrumentId,
          side: 'sell',
          type: 'stop',
          qty: asQty(1),
          stopPrice: asPrice(95),
          tag: 'stop',
          oco: 'bracket-1',
        });
        ctx.submit({
          instrumentId: fill.instrumentId,
          side: 'sell',
          type: 'limit',
          qty: asQty(1),
          limitPrice: asPrice(105),
          tag: 'target',
          oco: 'bracket-1',
        });
      },
      onCancel: (event) => cancels.push(event),
    });

    const exits = fills.filter((fill) => fill.tag !== null);
    expect(exits).toHaveLength(1);
    // Pessimistic is the default, so the stop is the one that ran.
    expect(exits[0]?.tag).toBe('stop');
    expect(cancels.some((event) => event.reason === 'oco')).toBe(true);
  });

  it('reduces rather than cancels when one leg fills partially', () => {
    // Liquidity caps the fill at one contract of the two, so the sibling must be left covering
    // exactly the one that is still open — not cancelled, and not left at two.
    const amendments: OrderAmendedEvent[] = [];
    let bracketed = false;
    runScript({
      rows: [
        { o: 100, h: 100, l: 100, c: 100, v: 1_000 },
        { o: 100, h: 100, l: 100, c: 100, v: 1_000 },
        { o: 100, h: 100, l: 100, c: 100, v: 1_000 },
        { o: 100, h: 106, l: 100, c: 100, v: 1_000 },
        { o: 100, h: 100, l: 100, c: 100, v: 1_000 },
      ],
      // Every fill is capped at one contract, so both the entry and the exit go in pieces.
      execution: { liquidity: { name: 'one', maxFillQty: () => asQty(1) } },
      onBar: (bar, ctx) => {
        if (bar.index !== 0) return;
        ctx.submit({ instrumentId: bar.instrumentId, side: 'buy', type: 'market', qty: asQty(2) });
      },
      onFill: (fill, ctx) => {
        if (fill.tag !== null || bracketed) return;
        bracketed = true;
        ctx.submit({
          instrumentId: fill.instrumentId,
          side: 'sell',
          type: 'stop',
          qty: asQty(2),
          stopPrice: asPrice(94),
          tag: 'stop',
          oco: 'bracket-2',
        });
        ctx.submit({
          instrumentId: fill.instrumentId,
          side: 'sell',
          type: 'limit',
          qty: asQty(2),
          limitPrice: asPrice(105),
          tag: 'target',
          oco: 'bracket-2',
        });
      },
      onAmend: (event) => amendments.push(event),
    });

    const reduced = amendments.filter((event) => event.reason === 'oco');
    expect(reduced.length).toBeGreaterThan(0);
    expect(reduced[0]?.previousQty).toBe(2);
    expect(reduced[0]?.qty).toBe(1);
  });

  it('leaves orders outside the group alone', () => {
    const cancels: OrderCancelledEvent[] = [];
    const result = runScript({
      rows: ROWS,
      onBar: (bar, ctx) => {
        if (bar.index !== 0) return;
        ctx.submit({ instrumentId: bar.instrumentId, side: 'buy', type: 'market', qty: asQty(1) });
      },
      onFill: (fill, ctx) => {
        if (fill.tag !== null) return;
        ctx.submit({
          instrumentId: fill.instrumentId,
          side: 'sell',
          type: 'stop',
          qty: asQty(1),
          stopPrice: asPrice(95),
          tag: 'stop',
          oco: 'group-a',
        });
        // A different group entirely: nothing that happens to group-a may touch it.
        ctx.submit({
          instrumentId: fill.instrumentId,
          side: 'buy',
          type: 'limit',
          qty: asQty(1),
          limitPrice: asPrice(50),
          tag: 'unrelated',
          oco: 'group-b',
        });
      },
      onCancel: (event) => cancels.push(event),
      flattenAtEnd: false,
    });

    const byOco = cancels.filter((event) => event.reason === 'oco');
    expect(byOco).toHaveLength(0);
    expect(result.stats.ocoReductions).toBe(0);
  });
});

describe('the amendment record', () => {
  it('reports what changed and what it was before', () => {
    const amendments: OrderAmendedEvent[] = [];
    const result = runScript({
      rows: ROWS,
      onBar: (bar, ctx) => {
        if (bar.index === 0) {
          ctx.submit({
            instrumentId: bar.instrumentId,
            side: 'buy',
            type: 'limit',
            qty: asQty(2),
            limitPrice: asPrice(90),
          });
          return;
        }
        if (bar.index === 1) {
          const open = ctx.openOrders()[0];
          if (open !== undefined) ctx.replace(open.id, { limitPrice: asPrice(92) });
        }
      },
      onAmend: (event) => amendments.push(event),
      flattenAtEnd: false,
    });

    expect(amendments).toHaveLength(1);
    expect(amendments[0]?.reason).toBe('requested');
    expect(amendments[0]?.previousLimitPrice).toBe(90);
    expect(amendments[0]?.limitPrice).toBe(92);
    expect(amendments[0]?.previousQty).toBe(2);
    expect(result.stats.ordersAmended).toBe(1);
    expect(result.amendments).toHaveLength(1);
  });

  it('emits nothing, and changes nothing, when the amendment is refused', () => {
    const amendments: OrderAmendedEvent[] = [];
    let accepted: boolean | null = null;
    const result = runScript({
      rows: ROWS,
      onBar: (bar, ctx) => {
        if (bar.index === 0) {
          ctx.submit({
            instrumentId: bar.instrumentId,
            side: 'buy',
            type: 'limit',
            qty: asQty(2),
            limitPrice: asPrice(90),
          });
          return;
        }
        if (bar.index === 1) {
          const open = ctx.openOrders()[0];
          if (open === undefined) return;
          // A valid price change and an invalid quantity in the same call. The order must come
          // out untouched: a limit that moved while the quantity did not is a state no venue
          // would have produced.
          accepted = ctx.replace(open.id, { limitPrice: asPrice(92), qty: asQty(0) });
        }
        if (bar.index === 2) {
          expect(ctx.openOrders()[0]?.limitPrice).toBe(90);
        }
      },
      onAmend: (event) => amendments.push(event),
      flattenAtEnd: false,
    });

    expect(accepted).toBe(false);
    expect(amendments).toHaveLength(0);
    expect(result.stats.ordersAmended).toBe(0);
  });
});
