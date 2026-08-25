import { describe, expect, it } from 'vitest';
import {
  type InstrumentId,
  type BarEvent,
  type OrderId,
  type StrategyContext,
  PRESETS,
  asPrice,
  asQty,
  bpsCommission,
  fixedTicksSlippage,
  volumeParticipation,
} from '@tapedeck/core';
import { MONEY, TEST_SPOT } from './helpers.ts';
import { onlyFill, runScript } from './harness.ts';

const ZERO = 0 as InstrumentId;

/** Submits `order` on the first bar and then does nothing, so each test isolates one behaviour. */
function submitOnFirstBar(order: Parameters<typeof buildOrder>[0]) {
  let submitted = false;
  return (_bar: BarEvent, ctx: StrategyContext): void => {
    if (submitted) return;
    submitted = true;
    ctx.submit(buildOrder(order));
  };
}

function buildOrder(spec: {
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop' | 'stop_limit';
  qty: number;
  limitPrice?: number;
  stopPrice?: number;
  tif?: 'gtc' | 'day' | 'ioc' | 'fok';
}) {
  return {
    instrumentId: ZERO,
    side: spec.side,
    type: spec.type,
    qty: asQty(spec.qty),
    limitPrice: spec.limitPrice === undefined ? undefined : asPrice(spec.limitPrice),
    stopPrice: spec.stopPrice === undefined ? undefined : asPrice(spec.stopPrice),
    tif: spec.tif,
  };
}

describe('order timing', () => {
  it('never fills against the bar the decision was made on', () => {
    const result = runScript({
      rows: [
        { o: 100, h: 100, l: 100, c: 100 },
        { o: 110, h: 115, l: 105, c: 112 },
      ],
      onBar: submitOnFirstBar({ side: 'buy', type: 'market', qty: 1 }),
    });
    const fill = onlyFill(result);
    // The decision bar closed at 100. A backtester with lookahead would fill there.
    expect(fill.price).toBe(110);
    expect(fill.ts).toBeGreaterThan(result.equityCurve.ts[0] ?? 0);
  });

  it('leaves an order unfilled when the run ends before the next bar', () => {
    const result = runScript({
      rows: [{ o: 100, h: 100, l: 100, c: 100 }],
      onBar: submitOnFirstBar({ side: 'buy', type: 'market', qty: 1 }),
    });
    expect(result.fills).toHaveLength(0);
    expect(result.stats.ordersCancelled).toBe(1);
  });
});

describe('limit orders', () => {
  const rows = [
    { o: 100, h: 100, l: 100, c: 100 },
    { o: 100, h: 105, l: 95, c: 102 },
  ];

  it('fills at the limit when the bar trades through it', () => {
    const result = runScript({
      rows,
      onBar: submitOnFirstBar({ side: 'buy', type: 'limit', qty: 1, limitPrice: 97 }),
    });
    expect(onlyFill(result).price).toBe(97);
  });

  it('does not fill when the bar never reaches the limit', () => {
    const result = runScript({
      rows,
      onBar: submitOnFirstBar({ side: 'buy', type: 'limit', qty: 1, limitPrice: 90 }),
    });
    expect(result.fills).toHaveLength(0);
  });

  it('gives the open when the bar gapped through the limit', () => {
    const result = runScript({
      rows: [
        { o: 100, h: 100, l: 100, c: 100 },
        { o: 90, h: 92, l: 88, c: 91 },
      ],
      onBar: submitOnFirstBar({ side: 'buy', type: 'limit', qty: 1, limitPrice: 97 }),
    });
    // Resting at 97 while the market opens at 90: you get 90, not 97.
    expect(onlyFill(result).price).toBe(90);
  });

  it('is a maker fill and therefore pays no slippage', () => {
    const result = runScript({
      rows,
      execution: { ...PRESETS.ideal(), slippage: fixedTicksSlippage(3) },
      onBar: submitOnFirstBar({ side: 'buy', type: 'limit', qty: 1, limitPrice: 97 }),
    });
    const fill = onlyFill(result);
    expect(fill.liquidity).toBe('maker');
    expect(fill.price).toBe(97);
    expect(fill.slippage).toBe(0);
  });
});

describe('stop orders', () => {
  it('triggers on the high and fills at the stop', () => {
    const result = runScript({
      rows: [
        { o: 100, h: 100, l: 100, c: 100 },
        { o: 100, h: 110, l: 99, c: 105 },
      ],
      onBar: submitOnFirstBar({ side: 'buy', type: 'stop', qty: 1, stopPrice: 105 }),
    });
    const fill = onlyFill(result);
    expect(fill.price).toBe(105);
    expect(fill.liquidity).toBe('taker');
  });

  it('fills at the open when the bar gapped past the stop', () => {
    const result = runScript({
      rows: [
        { o: 100, h: 100, l: 100, c: 100 },
        { o: 120, h: 125, l: 119, c: 124 },
      ],
      onBar: submitOnFirstBar({ side: 'buy', type: 'stop', qty: 1, stopPrice: 105 }),
    });
    // The gap is where a naive simulator invents money. It has to cost 120, not 105.
    expect(onlyFill(result).price).toBe(120);
  });

  it('pays slippage as a taker', () => {
    const result = runScript({
      rows: [
        { o: 100, h: 100, l: 100, c: 100 },
        { o: 100, h: 110, l: 99, c: 105 },
      ],
      execution: { ...PRESETS.ideal(), slippage: fixedTicksSlippage(2) },
      onBar: submitOnFirstBar({ side: 'buy', type: 'stop', qty: 1, stopPrice: 105 }),
    });
    const fill = onlyFill(result);
    expect(fill.price).toBe(107);
    expect(fill.slippage).toBe(2 * MONEY);
  });
});

describe('stop-limit orders', () => {
  const rows = [
    { o: 100, h: 100, l: 100, c: 100 },
    { o: 100, h: 110, l: 100, c: 108 },
    { o: 108, h: 109, l: 104, c: 106 },
  ];

  it('defers the limit to the next bar under the pessimistic policy', () => {
    const result = runScript({
      rows,
      onBar: submitOnFirstBar({
        side: 'buy',
        type: 'stop_limit',
        qty: 1,
        stopPrice: 105,
        limitPrice: 106,
      }),
    });
    expect(result.stats.stopLimitDeferrals).toBe(1);
    expect(onlyFill(result).ts).toBe(180_000_000);
    expect(result.warnings.some((w) => w.includes('stop-limit'))).toBe(true);
  });

  it('fills inside the trigger bar under the optimistic policy', () => {
    const result = runScript({
      rows,
      execution: { intrabar: 'optimistic' },
      onBar: submitOnFirstBar({
        side: 'buy',
        type: 'stop_limit',
        qty: 1,
        stopPrice: 105,
        limitPrice: 106,
      }),
    });
    expect(result.stats.stopLimitDeferrals).toBe(0);
    expect(onlyFill(result).ts).toBe(120_000_000);
  });
});

describe('partial fills and time in force', () => {
  const rows = [
    { o: 100, h: 100, l: 100, c: 100, v: 100 },
    { o: 100, h: 100, l: 100, c: 100, v: 100 },
    { o: 100, h: 100, l: 100, c: 100, v: 100 },
  ];

  it('caps a fill at the configured share of bar volume', () => {
    const result = runScript({
      rows,
      execution: { liquidity: volumeParticipation(1_000) },
      onBar: submitOnFirstBar({ side: 'buy', type: 'market', qty: 25 }),
    });
    expect(result.fills.map((f) => f.qty)).toEqual([10, 10]);
    expect(result.stats.partialFills).toBe(2);
  });

  it('cancels the remainder of an immediate-or-cancel order', () => {
    const result = runScript({
      rows,
      execution: { liquidity: volumeParticipation(1_000) },
      onBar: submitOnFirstBar({ side: 'buy', type: 'market', qty: 25, tif: 'ioc' }),
    });
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]?.qty).toBe(10);
    expect(result.stats.ordersCancelled).toBe(1);
  });

  it('cancels a fill-or-kill order untouched when it cannot fill in full', () => {
    const result = runScript({
      rows,
      execution: { liquidity: volumeParticipation(1_000) },
      onBar: submitOnFirstBar({ side: 'buy', type: 'market', qty: 25, tif: 'fok' }),
    });
    expect(result.fills).toHaveLength(0);
    expect(result.stats.ordersCancelled).toBe(1);
  });

  it('expires a day order when the UTC day changes', () => {
    const day = 24 * 60 * 60 * 1_000_000;
    const result = runScript({
      rows: [
        { o: 100, h: 100, l: 100, c: 100 },
        { o: 100, h: 100, l: 100, c: 100 },
      ],
      timeframe: day,
      onBar: submitOnFirstBar({ side: 'buy', type: 'limit', qty: 1, limitPrice: 90, tif: 'day' }),
    });
    expect(result.stats.ordersCancelled).toBe(1);
    expect(result.fills).toHaveLength(0);
  });
});

describe('intrabar ambiguity', () => {
  /**
   * A long position bracketed by a stop below and a target above, and then a bar whose range
   * covers both. Which one filled is not recorded by an OHLCV bar; the policy decides, and the
   * engine says so in its statistics.
   */
  const rows = [
    { o: 100, h: 100, l: 100, c: 100 },
    { o: 100, h: 100, l: 100, c: 100 },
    { o: 100, h: 100, l: 100, c: 100 },
    { o: 100, h: 112, l: 88, c: 100 },
  ];

  function bracketScript(): Pick<Parameters<typeof runScript>[0], 'onBar' | 'onFill'> {
    let stop: OrderId | null = null;
    let target: OrderId | null = null;
    return {
      onBar: (bar, ctx) => {
        if (bar.index === 0) ctx.submit(buildOrder({ side: 'buy', type: 'market', qty: 1 }));
        if (bar.index === 2) {
          target = ctx.submit(buildOrder({ side: 'sell', type: 'limit', qty: 1, limitPrice: 110 }));
          stop = ctx.submit(buildOrder({ side: 'sell', type: 'stop', qty: 1, stopPrice: 90 }));
        }
      },
      // One leg filling cancels the other, in the same bar. This is what a live account does, and
      // it only works because fills are delivered synchronously during matching (ADR-0005).
      onFill: (fill, ctx) => {
        if (fill.orderId === stop && target !== null) ctx.cancel(target);
        if (fill.orderId === target && stop !== null) ctx.cancel(stop);
      },
    };
  }

  it('takes the stop before the target under the pessimistic policy', () => {
    const result = runScript({ rows, ...bracketScript() });
    expect(result.stats.ambiguousBars).toBe(1);
    expect(result.fills.map((f) => f.price)).toEqual([100, 90]);
    expect(result.warnings.some((w) => w.includes('more than one resting order'))).toBe(true);
  });

  it('takes the target first under the optimistic policy', () => {
    const result = runScript({
      rows,
      execution: { intrabar: 'optimistic' },
      ...bracketScript(),
    });
    expect(result.fills.map((f) => f.price)).toEqual([100, 110]);
  });

  it('follows the assumed traversal under the ohlc-path policy', () => {
    const result = runScript({
      rows,
      execution: { intrabar: 'ohlc-path' },
      ...bracketScript(),
    });
    // The bar closes where it opened, so the path is treated as open -> low -> high -> close and
    // the stop at 90 is reached first.
    expect(result.fills.map((f) => f.price)).toEqual([100, 90]);
  });
});

describe('rejections', () => {
  const rows = [
    { o: 100, h: 100, l: 100, c: 100 },
    { o: 100, h: 100, l: 100, c: 100 },
  ];

  function expectReject(order: Parameters<typeof buildOrder>[0], fragment: string): void {
    const reasons: string[] = [];
    const result = runScript({
      rows,
      onBar: submitOnFirstBar(order),
      onReject: (event) => reasons.push(event.detail),
    });
    expect(result.stats.ordersRejected).toBe(1);
    expect(reasons.join(' ')).toContain(fragment);
  }

  it('rejects a non-positive quantity', () => {
    expectReject({ side: 'buy', type: 'market', qty: 0 }, 'positive integer');
  });

  it('rejects a limit order with no limit price', () => {
    expectReject({ side: 'buy', type: 'limit', qty: 1 }, 'require a limit price');
  });

  it('rejects a price that is not tick-aligned', () => {
    const result = runScript({
      rows,
      instrument: { ...TEST_SPOT, tickSize: '5' },
      onBar: submitOnFirstBar({ side: 'buy', type: 'limit', qty: 1, limitPrice: 97 }),
    });
    expect(result.stats.ordersRejected).toBe(1);
  });

  it('rejects a market order that carries a limit price', () => {
    expectReject(
      { side: 'buy', type: 'market', qty: 1, limitPrice: 100 },
      'must not carry a limit price',
    );
  });
});

describe('commission', () => {
  it('charges the configured share of notional', () => {
    const result = runScript({
      rows: [
        { o: 100, h: 100, l: 100, c: 100 },
        { o: 100, h: 100, l: 100, c: 100 },
      ],
      instrument: TEST_SPOT,
      execution: { commission: bpsCommission({ makerBps: 10, takerBps: 10 }) },
      onBar: submitOnFirstBar({ side: 'buy', type: 'market', qty: 10 }),
    });
    // 10 units at 100 is 1000 of notional; 10 bps of that is 1.
    expect(onlyFill(result).commission).toBe(1 * MONEY);
    expect(result.commissionPaid).toBe(1 * MONEY);
  });
});

describe('cancellation', () => {
  it('removes a resting order before it can fill', () => {
    let orderId: OrderId | null = null;
    const result = runScript({
      rows: [
        { o: 100, h: 100, l: 100, c: 100 },
        { o: 100, h: 100, l: 100, c: 100 },
        { o: 100, h: 105, l: 95, c: 100 },
      ],
      onBar: (bar, ctx) => {
        if (bar.index === 0) {
          orderId = ctx.submit(buildOrder({ side: 'buy', type: 'limit', qty: 1, limitPrice: 96 }));
        } else if (bar.index === 1 && orderId !== null) {
          expect(ctx.cancel(orderId)).toBe(true);
        }
      },
    });
    expect(result.fills).toHaveLength(0);
    expect(result.stats.ordersCancelled).toBe(1);
  });
});
