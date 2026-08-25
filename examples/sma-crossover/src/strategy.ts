/**
 * A moving-average crossover.
 *
 * This is the smoke test for the whole pipeline, not a trading idea: two averages crossing is the
 * oldest signal there is and it does not survive costs on most markets. Its job here is to place
 * real orders, hold real positions and produce a real equity curve, so that every part of the
 * engine is exercised end to end by something a reader already understands.
 *
 * Two things in it are worth copying into a serious strategy:
 *
 * - state lives in the closure, created per run, so a parameter sweep cannot leak state between
 *   runs;
 * - the strategy computes a *target position* and orders the difference, rather than tracking
 *   whether it is "in a trade". Positions are the truth; flags drift.
 */

import {
  type BarEvent,
  type InstrumentId,
  type Strategy,
  type StrategyContext,
  ConfigError,
  asQty,
} from '@tapedeck/core';

export interface SmaCrossoverParams {
  readonly fastPeriod: number;
  readonly slowPeriod: number;
  /** Contracts or shares to hold while a signal is active. */
  readonly qty: number;
  /** When false, a bearish cross means flat rather than short. Defaults to true. */
  readonly allowShort?: boolean;
}

/**
 * Fixed-window mean over a ring buffer: O(1) per bar, no reallocation, no re-summing.
 *
 * Replaced by `@tapedeck/indicators` in phase 2. It lives here so that phase 1 has no dependency
 * outside the core, and so the incremental-update contract is stated once in the simplest possible
 * form: `update()` is called exactly once per bar and never sees the series again.
 */
class RollingMean {
  private readonly window: Float64Array;
  private readonly period: number;
  private cursor = 0;
  private filled = 0;
  private sum = 0;

  constructor(period: number) {
    if (!Number.isInteger(period) || period < 1) {
      throw new ConfigError(`period must be a positive integer, got ${String(period)}`, { period });
    }
    this.period = period;
    this.window = new Float64Array(period);
  }

  get ready(): boolean {
    return this.filled === this.period;
  }

  /** Feeds one value and returns the current mean, or `null` until the window is full. */
  update(value: number): number | null {
    const outgoing = this.window[this.cursor] ?? 0;
    this.window[this.cursor] = value;
    this.cursor = (this.cursor + 1) % this.period;
    if (this.filled < this.period) {
      this.filled++;
      this.sum += value;
    } else {
      this.sum += value - outgoing;
    }
    return this.ready ? this.sum / this.period : null;
  }
}

export function smaCrossover(): Strategy<SmaCrossoverParams> {
  let fast: RollingMean;
  let slow: RollingMean;
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
      fast = new RollingMean(params.fastPeriod);
      slow = new RollingMean(params.slowPeriod);
      qty = params.qty;
      allowShort = params.allowShort ?? true;
      instrumentId = 0 as InstrumentId;
      ctx.log.info('sma-crossover initialised', {
        fastPeriod: params.fastPeriod,
        slowPeriod: params.slowPeriod,
        qty,
        allowShort,
      });
    },

    onBar(bar: BarEvent, ctx: StrategyContext): void {
      // Indicators take the close of a *closed* bar. The engine guarantees this callback cannot
      // see a price that had not printed yet (ADR-0005), so nothing here needs to be careful.
      const fastValue = fast.update(bar.close);
      const slowValue = slow.update(bar.close);
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
