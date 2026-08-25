/**
 * A moving-average crossover.
 *
 * This is the smoke test for the whole pipeline, not a trading idea: two averages crossing is the
 * oldest signal there is and it does not survive costs on most markets. Its job here is to place
 * real orders, hold real positions and produce a real equity curve, so that every part of the
 * engine is exercised end to end by something a reader already understands.
 *
 * Three things in it are worth copying into a serious strategy:
 *
 * - indicators are registered once in `onInit` and read through a handle; the engine updates them
 *   before `onBar`, so there is no way to forget an update or to read a stale value;
 * - state lives in the closure, created per run, so a parameter sweep cannot leak state between
 *   runs;
 * - the strategy computes a *target position* and orders the difference, rather than tracking
 *   whether it is "in a trade". Positions are the truth; flags drift.
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
import { sma } from '@tapedeck/indicators';

export interface SmaCrossoverParams {
  readonly fastPeriod: number;
  readonly slowPeriod: number;
  /** Contracts or shares to hold while a signal is active. */
  readonly qty: number;
  /** When false, a bearish cross means flat rather than short. Defaults to true. */
  readonly allowShort?: boolean;
}

export function smaCrossover(): Strategy<SmaCrossoverParams> {
  let fast: IndicatorHandle;
  let slow: IndicatorHandle;
  let instrumentId: InstrumentId;
  let qty: number;
  let allowShort: boolean;
  /** -1, 0 or 1. The previous relationship between the averages, so a cross can be detected. */
  let previousSide = 0;

  function rebalance(ctx: StrategyContext, target: number): void {
    const current = ctx.portfolio.position(instrumentId).qty;
    const delta = target - current;
    if (delta === 0) return;
    ctx.submit({
      instrumentId,
      side: delta > 0 ? 'buy' : 'sell',
      type: 'market',
      qty: asQty(Math.abs(delta)),
      tag: target === 0 ? 'exit' : target > 0 ? 'long' : 'short',
    });
  }

  return {
    id: 'sma-crossover',

    onInit(ctx: StrategyContext, params: SmaCrossoverParams): void {
      if (params.fastPeriod >= params.slowPeriod) {
        throw new ConfigError('fastPeriod must be shorter than slowPeriod', {
          fastPeriod: params.fastPeriod,
          slowPeriod: params.slowPeriod,
        });
      }
      if (!Number.isInteger(params.qty) || params.qty <= 0) {
        throw new ConfigError('qty must be a positive integer', { qty: params.qty });
      }

      instrumentId = 0 as InstrumentId;
      qty = params.qty;
      allowShort = params.allowShort ?? true;
      fast = ctx.use(sma({ period: params.fastPeriod }), { instrumentId });
      slow = ctx.use(sma({ period: params.slowPeriod }), { instrumentId });

      ctx.log.info('sma-crossover initialised', {
        fast: fast.name,
        slow: slow.name,
        qty,
        allowShort,
      });
    },

    onBar(_bar: BarEvent, ctx: StrategyContext): void {
      // The engine has already fed this bar to both averages, and the no-lookahead invariant means
      // the bar itself closed before any of this ran (ADR-0005). Nothing here needs to be careful.
      const fastValue = fast.value;
      const slowValue = slow.value;
      if (fastValue === null || slowValue === null) return;

      const side = fastValue > slowValue ? 1 : fastValue < slowValue ? -1 : previousSide;
      if (side === previousSide) return;
      previousSide = side;

      const target = side > 0 ? qty : allowShort ? -qty : 0;
      ctx.signal(instrumentId, target > 0 ? 'long' : target < 0 ? 'short' : 'flat');
      rebalance(ctx, target);
    },
  };
}
