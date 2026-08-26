/**
 * A channel breakout with a volume filter and an ATR bracket.
 *
 * This one exists to exercise the part of the engine the crossover never touches. A crossover holds
 * until the averages cross back, so it never has two resting orders that could both fill on the
 * same bar. This does: every entry is followed by a stop and a target, and a bar whose range
 * contains both is a bar where the fill order cannot be known from bar data alone.
 *
 * That is the case ADR-0005 is about. The engine resolves it pessimistically, counts the bar in
 * `stats.ambiguousBars`, and says so above the results. Run this and the number is not zero, which
 * is the point: the crossover's report shows a caveat about latency, and this one shows the caveat
 * the whole intrabar argument is built on.
 *
 * The bracket is one OCO group rather than two orders and a `cancel` in `onFill`. The difference is
 * not cosmetic: between a fill and a cancel the sibling is still live, and on a bar that touches
 * both levels the matcher can execute it. `oco.test.ts` keeps the old bug reproduced against the
 * old pattern.
 */

import {
  type BarEvent,
  type IndicatorHandle,
  type InstrumentId,
  type OrderFilledEvent,
  type Strategy,
  type StrategyContext,
  ConfigError,
  asPrice,
  asQty,
} from '@tapedeck/core';
import { atr } from '@tapedeck/indicators';

export interface BreakoutParams {
  /** Bars in the high-water channel. An entry needs a close above the highest of the previous N. */
  readonly lookback: number;
  readonly atrPeriod: number;
  /** Stop distance, in ATRs below the entry. */
  readonly stopAtr: number;
  /** Target distance, in ATRs above the entry. */
  readonly targetAtr: number;
  /** Volume must exceed this multiple of its own rolling average for a breakout to count. */
  readonly volumeFactor: number;
  readonly qty: number;
}

const EXIT_GROUP = 'bracket';

export function breakout(): Strategy<BreakoutParams> {
  let instrumentId: InstrumentId;
  let atrHandle: IndicatorHandle;
  let params: BreakoutParams;

  /**
   * The channel and the volume average are kept here rather than registered as indicators.
   *
   * `PriceSource` covers the four prices and their averages, not volume, and there is no rolling
   * maximum in the library. Both are three lines of ring buffer, and inventing an indicator to
   * avoid writing them would be the wrong trade.
   */
  let highs: Float64Array;
  let volumes: Float64Array;
  let cursor = 0;
  let seen = 0;
  let volumeSum = 0;

  /** True between submitting an entry and the bracket closing. Derived from fills, not guessed. */
  let bracketed = false;

  function channelHigh(): number {
    let max = 0;
    for (let i = 0; i < seen; i++) max = Math.max(max, highs[i] ?? 0);
    return max;
  }

  return {
    id: 'breakout',

    onInit(ctx: StrategyContext, given: BreakoutParams): void {
      if (!Number.isInteger(given.lookback) || given.lookback < 2) {
        throw new ConfigError('lookback must be an integer of at least 2', {
          lookback: given.lookback,
        });
      }
      if (given.stopAtr <= 0 || given.targetAtr <= 0) {
        throw new ConfigError('stopAtr and targetAtr must both be positive', {
          stopAtr: given.stopAtr,
          targetAtr: given.targetAtr,
        });
      }
      if (!Number.isInteger(given.qty) || given.qty <= 0) {
        throw new ConfigError('qty must be a positive integer', { qty: given.qty });
      }

      params = given;
      instrumentId = 0 as InstrumentId;
      highs = new Float64Array(given.lookback);
      volumes = new Float64Array(given.lookback);
      atrHandle = ctx.use(atr({ period: given.atrPeriod }), { instrumentId });

      ctx.log.info('breakout initialised', {
        lookback: given.lookback,
        atr: atrHandle.name,
        stopAtr: given.stopAtr,
        targetAtr: given.targetAtr,
      });
    },

    onBar(bar: BarEvent, ctx: StrategyContext): void {
      // Read the channel *before* this bar joins it. A breakout measured against a window that
      // already contains the breaking bar is lookahead wearing a disguise: the close would be
      // compared against a high it set itself.
      const priorHigh = channelHigh();
      const priorVolumeAvg = seen === 0 ? 0 : volumeSum / seen;

      const slot = cursor % params.lookback;
      volumeSum -= volumes[slot] ?? 0;
      highs[slot] = bar.high;
      volumes[slot] = bar.volume;
      volumeSum += bar.volume;
      cursor++;
      if (seen < params.lookback) seen++;

      if (seen < params.lookback || bracketed) return;
      if (ctx.portfolio.position(instrumentId).qty !== 0) return;

      const atrValue = atrHandle.value;
      if (atrValue === null || atrValue <= 0) return;
      if (bar.close <= priorHigh) return;
      if (priorVolumeAvg > 0 && bar.volume < priorVolumeAvg * params.volumeFactor) return;

      ctx.signal(instrumentId, 'long');
      ctx.submit({
        instrumentId,
        side: 'buy',
        type: 'market',
        qty: asQty(params.qty),
        tag: 'entry',
      });
      bracketed = true;
    },

    onFill(fill: OrderFilledEvent, ctx: StrategyContext): void {
      if (fill.tag === 'entry' && fill.leavesQty === 0) {
        const spread = atrHandle.value;
        if (spread === null) return;

        // Every tape this ships with quotes a tick of exactly one unit at its own precision, so
        // rounding to an integer *is* the tick snap. An instrument with a coarser tick would need
        // the price rounded to a multiple of `tickSize` here.
        const stop = asPrice(Math.round(fill.price - spread * params.stopAtr));
        const target = asPrice(Math.round(fill.price + spread * params.targetAtr));
        const size = asQty(ctx.portfolio.position(instrumentId).qty);

        ctx.submit({
          instrumentId,
          side: 'sell',
          type: 'stop',
          qty: size,
          stopPrice: stop,
          tag: 'stop',
          oco: EXIT_GROUP,
        });
        ctx.submit({
          instrumentId,
          side: 'sell',
          type: 'limit',
          qty: size,
          limitPrice: target,
          tag: 'target',
          oco: EXIT_GROUP,
        });
        return;
      }

      // Either leg closing ends the trade. The sibling is reduced by the OCO group rather than
      // cancelled from here, which is the whole reason the group exists.
      if ((fill.tag === 'stop' || fill.tag === 'target') && fill.leavesQty === 0) {
        bracketed = false;
        ctx.signal(instrumentId, 'flat');
      }
    },
  };
}

export default breakout;
