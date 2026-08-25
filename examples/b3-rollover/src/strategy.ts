/**
 * A session-aware breakout on a continuous B3 series.
 *
 * The strategy is deliberately ordinary — a band breakout with a volatility stop. What it exists
 * to demonstrate is the two things a venue that *closes* forces on a strategy, and which no crypto
 * example can show:
 *
 * 1. **It does not carry a position overnight.** Not because that is clever, but because holding a
 *    futures position through the close means a settlement, overnight margin, and a gap that no
 *    resting stop protects against. It asks `ctx.calendar` how long is left rather than hard-coding
 *    a time, so it is right on a half day and right on the day before Carnival.
 * 2. **It does not open a position it has no time to manage.** A breakout entered nine minutes
 *    before the bell is an exit nine minutes later that paid the spread twice.
 *
 * Both rules cost money in a backtest, and both are what the strategy would have to do live. That
 * asymmetry is the point of running it here rather than on a market that never shuts.
 */

import type { BarEvent, IndicatorHandle, Strategy, StrategyContext } from '@tapedeck/core';
import { MICROS_PER_MINUTE, asPrice, asQty } from '@tapedeck/core';
import { type BollingerValue, atr, bollinger } from '@tapedeck/indicators';

export interface B3BreakoutParams {
  /** Bars in the band. */
  readonly period: number;
  /** Band width in standard deviations. */
  readonly deviations: number;
  /** Contracts per entry. */
  readonly qty: number;
  /** Stop distance, as a multiple of ATR. */
  readonly stopAtr: number;
  /** Minutes before the close after which no new position is opened. */
  readonly noEntryMinutes: number;
}

export const DEFAULTS: B3BreakoutParams = {
  period: 20,
  deviations: 2,
  qty: 1,
  stopAtr: 2,
  noEntryMinutes: 30,
};

export default function b3Breakout(): Strategy<B3BreakoutParams> {
  let params = DEFAULTS;
  let bands: IndicatorHandle<BollingerValue> | null = null;
  let range: IndicatorHandle | null = null;

  return {
    id: 'b3-breakout',

    onInit(ctx, given) {
      params = { ...DEFAULTS, ...given };
      bands = ctx.use(bollinger({ period: params.period, deviations: params.deviations }));
      range = ctx.use(atr({ period: params.period }));
    },

    onBar(bar: BarEvent, ctx: StrategyContext) {
      const position = ctx.portfolio.position(bar.instrumentId).qty;
      // Measured from the bar's *open*, not its close. A session is half-open, so at the instant
      // the last bar closes the venue is already shut and `nextClose` answers with tomorrow's
      // bell — which reads as "twenty-three hours left" on the one bar where the answer is zero.
      // The first draft of this strategy did exactly that and held one position for a whole year.
      const untilClose = ctx.calendar.nextClose(bar.openTs) - bar.closeTs;

      // Flat before the bell, always. A position held through the close is exposed to the
      // settlement and to the gap on reopen, and a stop resting in the book does not help when
      // the market reopens through it.
      //
      // The exit goes in one bar *early*, and that is not a rounding choice. An order submitted
      // while processing a bar cannot match against it (ADR-0005), so an exit sent on the closing
      // bar fills at the next session's open — carrying exactly the overnight risk it was meant
      // to avoid. The second draft of this strategy did that and slept long on 68 nights.
      const barLength = bar.closeTs - bar.openTs;
      if (untilClose <= barLength && position !== 0) {
        ctx.submit({
          instrumentId: bar.instrumentId,
          side: position > 0 ? 'sell' : 'buy',
          type: 'market',
          qty: asQty(Math.abs(position)),
          tag: 'end-of-session',
        });
        return;
      }
      if (position !== 0) return;
      if (untilClose <= params.noEntryMinutes * MICROS_PER_MINUTE) return;

      const band = bands?.value;
      if (band === null || band === undefined) return;

      if (bar.close > band.upper) {
        ctx.signal(bar.instrumentId, 'long', 1, 'breakout');
        ctx.submit({
          instrumentId: bar.instrumentId,
          side: 'buy',
          type: 'market',
          qty: asQty(params.qty),
        });
      } else if (bar.close < band.lower) {
        ctx.signal(bar.instrumentId, 'short', 1, 'breakout');
        ctx.submit({
          instrumentId: bar.instrumentId,
          side: 'sell',
          type: 'market',
          qty: asQty(params.qty),
        });
      }
    },

    onFill(fill, ctx) {
      if (fill.tag !== null || fill.leavesQty !== 0) return;
      const volatility = range?.value;
      if (typeof volatility !== 'number' || volatility <= 0) return;

      const distance = Math.max(5, Math.round((volatility * params.stopAtr) / 5) * 5);
      const stop = fill.side === 'buy' ? fill.price - distance : fill.price + distance;
      if (stop <= 0) return;

      // A `day` order: the engine kills it at the session close rather than at midnight UTC,
      // which is the whole reason the calendar reaches the broker.
      ctx.submit({
        instrumentId: fill.instrumentId,
        side: fill.side === 'buy' ? 'sell' : 'buy',
        type: 'stop',
        qty: fill.qty,
        stopPrice: asPrice(stop),
        tif: 'day',
        tag: 'protective-stop',
      });
    },
  };
}
