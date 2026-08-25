import { describe, expect, it } from 'vitest';
import { type BarEvent, type InstrumentId, type StrategyContext, asQty } from '@tapedeck/core';
import { MONEY } from './helpers.ts';
import { runScript } from './harness.ts';

const ZERO = 0 as InstrumentId;

function market(ctx: StrategyContext, side: 'buy' | 'sell', qty: number): void {
  ctx.submit({ instrumentId: ZERO, side, type: 'market', qty: asQty(qty) });
}

function flat(price: number): { o: number; h: number; l: number; c: number } {
  return { o: price, h: price, l: price, c: price };
}

describe('round-trip extraction', () => {
  /**
   * Prices: entry at 100, a dip to 95, a rally to 110, exit at 105. Every number the trade record
   * reports is visible in that sentence, which is the point of testing it this way.
   */
  const rows = [flat(100), flat(100), flat(95), flat(110), flat(105)];

  const script = (bar: BarEvent, ctx: StrategyContext): void => {
    if (bar.index === 0) market(ctx, 'buy', 1);
    if (bar.index === 3) market(ctx, 'sell', 1);
  };

  it('records one closed trade with its entry, exit and excursions', () => {
    const result = runScript({ rows, onBar: script });
    expect(result.trades).toHaveLength(1);

    const trade = result.trades[0];
    expect(trade?.direction).toBe('long');
    expect(trade?.qty).toBe(1);
    expect(trade?.entryPrice).toBe(100);
    expect(trade?.exitPrice).toBe(105);
    expect(trade?.grossPnl).toBe(5 * MONEY);
    expect(trade?.netPnl).toBe(5 * MONEY);
    // Marked at 100, 95 and 110 while the position was open.
    expect(trade?.barsHeld).toBe(3);
    expect(trade?.mae).toBe(-5 * MONEY);
    expect(trade?.mfe).toBe(10 * MONEY);
  });

  it('agrees with the portfolio about realised PnL', () => {
    const result = runScript({ rows, onBar: script });
    const summed = result.trades.reduce((total, t) => total + t.grossPnl, 0);
    expect(summed).toBe(result.realizedPnl);
  });
});

describe('shorts', () => {
  it('records a profitable short as a positive PnL', () => {
    const result = runScript({
      rows: [flat(100), flat(100), flat(90), flat(90)],
      onBar: (bar, ctx) => {
        if (bar.index === 0) market(ctx, 'sell', 1);
        if (bar.index === 2) market(ctx, 'buy', 1);
      },
    });
    const trade = result.trades[0];
    expect(trade?.direction).toBe('short');
    expect(trade?.entryPrice).toBe(100);
    expect(trade?.exitPrice).toBe(90);
    expect(trade?.grossPnl).toBe(10 * MONEY);
  });
});

describe('reversals', () => {
  it('splits a reversal into a closed trade and a new one', () => {
    const result = runScript({
      rows: [flat(100), flat(100), flat(120), flat(120), flat(110)],
      onBar: (bar, ctx) => {
        if (bar.index === 0) market(ctx, 'buy', 1);
        if (bar.index === 2) market(ctx, 'sell', 2);
      },
      flattenAtEnd: true,
    });

    expect(result.trades).toHaveLength(2);
    expect(result.trades[0]?.direction).toBe('long');
    expect(result.trades[0]?.grossPnl).toBe(20 * MONEY);
    expect(result.trades[1]?.direction).toBe('short');
    expect(result.trades[1]?.entryPrice).toBe(120);
    // The short was opened at 120 and flattened at the final price of 110.
    expect(result.trades[1]?.exitPrice).toBe(110);
    expect(result.trades[1]?.grossPnl).toBe(10 * MONEY);
  });
});

describe('scaling in and out', () => {
  it('weights the entry and exit prices by quantity', () => {
    const result = runScript({
      rows: [flat(100), flat(100), flat(200), flat(150), flat(150), flat(250)],
      onBar: (bar, ctx) => {
        if (bar.index === 0) market(ctx, 'buy', 1); // fills at 100
        if (bar.index === 1) market(ctx, 'buy', 3); // fills at 200
        if (bar.index === 3) market(ctx, 'sell', 2); // fills at 150
        if (bar.index === 4) market(ctx, 'sell', 2); // fills at 250
      },
    });

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    // Entry: (100 * 1 + 200 * 3) / 4 = 175. Exit: (150 * 2 + 250 * 2) / 4 = 200.
    expect(trade?.entryPrice).toBe(175);
    expect(trade?.exitPrice).toBe(200);
    expect(trade?.qty).toBe(4);
    expect(trade?.grossPnl).toBe(100 * MONEY);
    expect(trade?.grossPnl).toBe(result.realizedPnl);
  });
});

describe('open positions', () => {
  it('records no trade for a position that never closed', () => {
    const result = runScript({
      rows: [flat(100), flat(100), flat(120)],
      onBar: (bar, ctx) => {
        if (bar.index === 0) market(ctx, 'buy', 1);
      },
      flattenAtEnd: false,
    });
    expect(result.trades).toHaveLength(0);
    expect(result.openPositions[0]?.qty).toBe(1);
    expect(result.openPositions[0]?.avgEntry).toBe(100);
  });
});
