/**
 * The indicators themselves.
 *
 * Each is defined the way the reference source defines it, and where a definition is contested the
 * comment says which one was chosen. An indicator that silently disagrees with the chart a trader
 * is looking at is worse than no indicator.
 */

import {
  type BarIndicator,
  type BarSample,
  type Indicator,
  type PriceSource,
  type ValueIndicator,
  MICROS_PER_DAY,
  sourceOf,
} from '@tapedeck/core';
import { Ema, Rma, RollingStats } from './primitives.ts';

/**
 * Wilder's relative strength index.
 *
 * Needs `period + 1` samples: the first sample only establishes a reference for the first change.
 * A window of pure gains reports 100 and a window of pure losses reports 0, rather than dividing
 * by zero.
 */
export class Rsi implements ValueIndicator {
  readonly name: string;
  readonly period: number;
  private readonly gains: Rma;
  private readonly losses: Rma;
  private previous: number | null = null;
  private current: number | null = null;

  constructor(period = 14) {
    this.period = period;
    this.name = `rsi(${String(period)})`;
    this.gains = new Rma(period);
    this.losses = new Rma(period);
  }

  get ready(): boolean {
    return this.current !== null;
  }

  get value(): number | null {
    return this.current;
  }

  update(input: number): number | null {
    if (this.previous === null) {
      this.previous = input;
      return null;
    }
    const change = input - this.previous;
    this.previous = input;

    const averageGain = this.gains.update(change > 0 ? change : 0);
    const averageLoss = this.losses.update(change < 0 ? -change : 0);
    if (averageGain === null || averageLoss === null) return null;

    if (averageLoss === 0) {
      this.current = averageGain === 0 ? 50 : 100;
    } else {
      this.current = 100 - 100 / (1 + averageGain / averageLoss);
    }
    return this.current;
  }

  reset(): void {
    this.gains.reset();
    this.losses.reset();
    this.previous = null;
    this.current = null;
  }
}

export interface BollingerValue {
  readonly middle: number;
  readonly upper: number;
  readonly lower: number;
  /** `(upper - lower) / middle`, the usual normalised measure of squeeze and expansion. */
  readonly bandwidth: number;
}

/** Bollinger bands: a simple average with population standard-deviation envelopes. */
export class BollingerBands implements Indicator<number, BollingerValue> {
  readonly name: string;
  readonly period: number;
  readonly deviations: number;
  private readonly stats: RollingStats;
  private current: BollingerValue | null = null;

  constructor(period = 20, deviations = 2) {
    this.period = period;
    this.deviations = deviations;
    this.name = `bollinger(${String(period)},${String(deviations)})`;
    this.stats = new RollingStats(period);
  }

  get ready(): boolean {
    return this.current !== null;
  }

  get value(): BollingerValue | null {
    return this.current;
  }

  update(input: number): BollingerValue | null {
    const stats = this.stats.update(input);
    if (stats === null) {
      this.current = null;
      return null;
    }
    const offset = this.deviations * stats.stdDev;
    const upper = stats.mean + offset;
    const lower = stats.mean - offset;
    this.current = {
      middle: stats.mean,
      upper,
      lower,
      bandwidth: stats.mean === 0 ? 0 : (upper - lower) / stats.mean,
    };
    return this.current;
  }

  reset(): void {
    this.stats.reset();
    this.current = null;
  }
}

export interface MacdValue {
  readonly macd: number;
  readonly signal: number;
  readonly histogram: number;
}

/**
 * Moving average convergence/divergence.
 *
 * Because both EMAs are seeded with a simple average, the line becomes defined at `slow` samples
 * and the signal at `slow + signalPeriod - 1`.
 */
export class Macd implements Indicator<number, MacdValue> {
  readonly name: string;
  private readonly fast: Ema;
  private readonly slow: Ema;
  private readonly signal: Ema;
  private current: MacdValue | null = null;

  constructor(fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    if (fastPeriod >= slowPeriod) {
      throw new RangeError('fastPeriod must be shorter than slowPeriod');
    }
    this.name = `macd(${String(fastPeriod)},${String(slowPeriod)},${String(signalPeriod)})`;
    this.fast = new Ema(fastPeriod);
    this.slow = new Ema(slowPeriod);
    this.signal = new Ema(signalPeriod);
  }

  get ready(): boolean {
    return this.current !== null;
  }

  get value(): MacdValue | null {
    return this.current;
  }

  update(input: number): MacdValue | null {
    const fast = this.fast.update(input);
    const slow = this.slow.update(input);
    if (fast === null || slow === null) return null;

    const macd = fast - slow;
    const signal = this.signal.update(macd);
    if (signal === null) return null;

    this.current = { macd, signal, histogram: macd - signal };
    return this.current;
  }

  reset(): void {
    this.fast.reset();
    this.slow.reset();
    this.signal.reset();
    this.current = null;
  }
}

/**
 * Average true range, Wilder's definition.
 *
 * True range is the largest of the bar's own range and its two gaps from the previous close, so
 * an overnight gap counts as volatility even though the bar itself may be small. The first bar has
 * no previous close and contributes only its own range.
 */
export class Atr implements BarIndicator {
  readonly name: string;
  readonly period: number;
  private readonly smoothed: Rma;
  private previousClose: number | null = null;

  constructor(period = 14) {
    this.period = period;
    this.name = `atr(${String(period)})`;
    this.smoothed = new Rma(period);
  }

  get ready(): boolean {
    return this.smoothed.ready;
  }

  get value(): number | null {
    return this.smoothed.value;
  }

  update(bar: BarSample): number | null {
    const range = bar.high - bar.low;
    const trueRange =
      this.previousClose === null
        ? range
        : Math.max(
            range,
            Math.abs(bar.high - this.previousClose),
            Math.abs(bar.low - this.previousClose),
          );
    this.previousClose = bar.close;
    return this.smoothed.update(trueRange);
  }

  reset(): void {
    this.smoothed.reset();
    this.previousClose = null;
  }
}

export interface VwapOptions {
  /** `day` restarts the accumulation at each UTC midnight; `never` runs it over the whole series. */
  readonly reset?: 'day' | 'never' | undefined;
  /** Which price is weighted. Defaults to `hlc3`, the typical price. */
  readonly source?: PriceSource | undefined;
}

/**
 * Volume-weighted average price.
 *
 * Session-scoped by default, because a VWAP that never restarts stops being the number traders
 * mean by the word. The session boundary is UTC midnight until the B3 calendar lands; for crypto,
 * which never closes, UTC midnight is the convention every venue already uses.
 *
 * Bars with no volume are skipped rather than counted as zero-priced.
 */
export class Vwap implements BarIndicator {
  readonly name: string;
  private readonly resetMode: 'day' | 'never';
  private readonly source: PriceSource;
  private weighted = 0;
  private volume = 0;
  private day: number | null = null;
  private current: number | null = null;

  constructor(options: VwapOptions = {}) {
    this.resetMode = options.reset ?? 'day';
    this.source = options.source ?? 'hlc3';
    this.name = `vwap(${this.resetMode},${this.source})`;
  }

  get ready(): boolean {
    return this.current !== null;
  }

  get value(): number | null {
    return this.current;
  }

  update(bar: BarSample): number | null {
    if (this.resetMode === 'day') {
      const day = Math.floor(bar.ts / MICROS_PER_DAY);
      if (this.day !== day) {
        this.day = day;
        this.weighted = 0;
        this.volume = 0;
        this.current = null;
      }
    }

    if (bar.volume > 0) {
      this.weighted += sourceOf(bar, this.source) * bar.volume;
      this.volume += bar.volume;
    }
    this.current = this.volume === 0 ? null : this.weighted / this.volume;
    return this.current;
  }

  reset(): void {
    this.weighted = 0;
    this.volume = 0;
    this.day = null;
    this.current = null;
  }
}
