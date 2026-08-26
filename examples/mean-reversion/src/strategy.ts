/**
 * RSI mean reversion, with a time stop.
 *
 * The third shape, and the one that flatters itself hardest. Buying weakness wins often and loses
 * rarely but large, which is the mirror image of the crossover: a win rate in the seventies and a
 * profit factor that can still be under one. It is in the demo precisely so the two sit side by
 * side, because a reader who judges a strategy by its win rate will read these two backwards.
 *
 * The time stop is not decoration. Without one, a mean-reversion rule holds a position that never
 * reverts for the rest of the run, and the equity curve stops describing the rule and starts
 * describing a single trade.
 */

import {
  type BarEvent,
  type IndicatorHandle,
  type InstrumentId,
  type Strategy,
  type StrategyContext,
  ConfigError,
  asQty,
} from '@tapedeck/core';
import { rsi } from '@tapedeck/indicators';

export interface MeanReversionParams {
  readonly rsiPeriod: number;
  /** Buy when RSI closes below this. */
  readonly entryLevel: number;
  /** Sell when RSI closes above this. */
  readonly exitLevel: number;
  /** Bars to hold before giving up on the reversion. */
  readonly maxBarsHeld: number;
  readonly qty: number;
}

export function meanReversion(): Strategy<MeanReversionParams> {
  let instrumentId: InstrumentId;
  let rsiHandle: IndicatorHandle;
  let params: MeanReversionParams;

  /** Bars since the entry filled, or `null` when flat. Counted from bars, not from the clock. */
  let heldFor: number | null = null;

  return {
    id: 'mean-reversion',

    onInit(ctx: StrategyContext, given: MeanReversionParams): void {
      if (given.entryLevel >= given.exitLevel) {
        throw new ConfigError('entryLevel must be below exitLevel', {
          entryLevel: given.entryLevel,
          exitLevel: given.exitLevel,
        });
      }
      if (!Number.isInteger(given.maxBarsHeld) || given.maxBarsHeld < 1) {
        throw new ConfigError('maxBarsHeld must be a positive integer', {
          maxBarsHeld: given.maxBarsHeld,
        });
      }
      if (!Number.isInteger(given.qty) || given.qty <= 0) {
        throw new ConfigError('qty must be a positive integer', { qty: given.qty });
      }

      params = given;
      instrumentId = 0 as InstrumentId;
      rsiHandle = ctx.use(rsi({ period: given.rsiPeriod }), { instrumentId });

      ctx.log.info('mean-reversion initialised', {
        rsi: rsiHandle.name,
        entryLevel: given.entryLevel,
        exitLevel: given.exitLevel,
        maxBarsHeld: given.maxBarsHeld,
      });
    },

    onBar(_bar: BarEvent, ctx: StrategyContext): void {
      const value = rsiHandle.value;
      if (value === null) return;

      const held = ctx.portfolio.position(instrumentId).qty;

      if (held === 0) {
        // A position ordered on the previous bar has not filled yet, so the counter stays null
        // until the fill actually shows up in the portfolio.
        if (heldFor !== null) heldFor = null;
        if (value >= params.entryLevel) return;

        ctx.signal(instrumentId, 'long');
        ctx.submit({
          instrumentId,
          side: 'buy',
          type: 'market',
          qty: asQty(params.qty),
          tag: 'entry',
        });
        return;
      }

      heldFor = (heldFor ?? 0) + 1;
      const reverted = value > params.exitLevel;
      const expired = heldFor >= params.maxBarsHeld;
      if (!reverted && !expired) return;

      ctx.signal(instrumentId, 'flat');
      ctx.submit({
        instrumentId,
        side: 'sell',
        type: 'market',
        qty: asQty(held),
        tag: expired && !reverted ? 'time-stop' : 'exit',
      });
      heldFor = null;
    },
  };
}

export default meanReversion;
