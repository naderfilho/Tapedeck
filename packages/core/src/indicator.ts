/**
 * The indicator contract.
 *
 * The core declares it and implements none of it: `@tapedeck/indicators` provides the library,
 * and anything satisfying this interface can be registered, including a strategy's own private
 * calculation. The arrow points inward (ADR-0001).
 *
 * ## Units
 *
 * Indicators consume and produce values in the instrument's own fixed-point price scale, as
 * `float64`. An SMA of `WIN` is a number of index points; an SMA of `BTCUSDT` is a number of
 * cents. That keeps every indicator comparable with the prices it was computed from, and makes
 * the crossing back into the ledger a single call to `roundToTick` (ADR-0002).
 *
 * ## Why `update` returns the value
 *
 * An incremental indicator must never look at the series again. Returning the new value from
 * `update` makes that the only convenient way to use one: there is no method that takes a window,
 * so there is nothing to accidentally call inside a loop.
 */

import type { InstrumentId } from './instrument.ts';

/**
 * The shape an indicator needs from a bar. {@link ./events/events.ts | BarEvent} satisfies it
 * structurally, so nothing is copied or adapted on the hot path.
 *
 * `ts` is here because session-aware indicators exist: a VWAP that does not know when the day
 * turned over is not a VWAP.
 */
export interface BarSample {
  readonly ts: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/** Which number a value-based indicator takes from a bar. */
export type PriceSource = 'open' | 'high' | 'low' | 'close' | 'hl2' | 'hlc3' | 'ohlc4';

/** Extracts a source price from a bar. Averaged sources stay in float, like every indicator. */
export function sourceOf(bar: BarSample, source: PriceSource): number {
  switch (source) {
    case 'open':
      return bar.open;
    case 'high':
      return bar.high;
    case 'low':
      return bar.low;
    case 'close':
      return bar.close;
    case 'hl2':
      return (bar.high + bar.low) / 2;
    case 'hlc3':
      return (bar.high + bar.low + bar.close) / 3;
    case 'ohlc4':
      return (bar.open + bar.high + bar.low + bar.close) / 4;
  }
}

export interface Indicator<TIn = number, TOut = number> {
  /** Identifies the instance in logs and reports, e.g. `sma(20, close)`. */
  readonly name: string;
  /** False until enough samples have arrived for the value to be defined. */
  readonly ready: boolean;
  /** Current value, or `null` while not ready. */
  readonly value: TOut | null;
  /** Feeds exactly one sample and returns the new value. */
  update(input: TIn): TOut | null;
  /** Returns the indicator to its initial state. */
  reset(): void;
}

/** Consumes a plain number stream. Used for composition — an EMA of an EMA, for instance. */
export type ValueIndicator<TOut = number> = Indicator<number, TOut>;

/** Consumes bars. This is what a strategy registers with `ctx.use()`. */
export type BarIndicator<TOut = number> = Indicator<BarSample, TOut>;

/**
 * What a strategy holds after registering an indicator: a read-only window onto its value.
 *
 * Deliberately missing: `update`. The engine owns the update, and it runs after resting orders
 * have matched but before `onBar`, so the value a strategy reads always corresponds to the bar it
 * is being shown — never one bar stale, never one bar early.
 */
export interface IndicatorHandle<TOut = number> {
  readonly name: string;
  readonly ready: boolean;
  readonly value: TOut | null;
}

export interface UseIndicatorOptions {
  /** Which instrument's bars feed it. Defaults to the first registered instrument. */
  readonly instrumentId?: InstrumentId | undefined;
}
