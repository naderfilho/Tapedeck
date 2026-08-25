/**
 * Bar-level factories: what a strategy passes to `ctx.use()`.
 *
 * Every factory takes an options object rather than positional arguments, because
 * `macd({ fast: 12, slow: 26, signal: 9 })` is readable at a glance and `macd(12, 26, 9)` is a
 * coin flip. The `source` option decides which price of the bar feeds the calculation, defaulting
 * to the close.
 */

import type { BarIndicator, BarSample, Indicator, PriceSource } from '@tapedeck/core';
import { sourceOf } from '@tapedeck/core';
import { Ema, Rma, RollingStats, Sma, type RollingStatsValue } from './primitives.ts';
import {
  Atr,
  BollingerBands,
  Macd,
  Rsi,
  Vwap,
  type BollingerValue,
  type MacdValue,
  type VwapOptions,
} from './indicators.ts';

/**
 * Lifts a value indicator onto bars by picking one price from each.
 *
 * This is the only adapter in the package, and it is the reason the primitives can stay unaware
 * that bars exist.
 */
export class SourcedIndicator<T> implements BarIndicator<T> {
  readonly name: string;
  private readonly inner: Indicator<number, T>;
  private readonly source: PriceSource;

  constructor(inner: Indicator<number, T>, source: PriceSource) {
    this.inner = inner;
    this.source = source;
    this.name = `${inner.name}@${source}`;
  }

  get ready(): boolean {
    return this.inner.ready;
  }

  get value(): T | null {
    return this.inner.value;
  }

  update(bar: BarSample): T | null {
    return this.inner.update(sourceOf(bar, this.source));
  }

  reset(): void {
    this.inner.reset();
  }
}

export function fromSource<T>(
  indicator: Indicator<number, T>,
  source: PriceSource = 'close',
): BarIndicator<T> {
  return new SourcedIndicator(indicator, source);
}

export interface PeriodOptions {
  readonly period: number;
  readonly source?: PriceSource | undefined;
}

export function sma(options: PeriodOptions): BarIndicator {
  return fromSource(new Sma(options.period), options.source);
}

export function ema(options: PeriodOptions): BarIndicator {
  return fromSource(new Ema(options.period), options.source);
}

/** Wilder's smoothing as a standalone indicator. Rarely plotted, often composed. */
export function rma(options: PeriodOptions): BarIndicator {
  return fromSource(new Rma(options.period), options.source);
}

export function rsi(options: Partial<PeriodOptions> = {}): BarIndicator {
  return fromSource(new Rsi(options.period ?? 14), options.source);
}

export function stats(options: PeriodOptions): BarIndicator<RollingStatsValue> {
  return fromSource(new RollingStats(options.period), options.source);
}

export interface BollingerOptions {
  readonly period?: number | undefined;
  readonly deviations?: number | undefined;
  readonly source?: PriceSource | undefined;
}

export function bollinger(options: BollingerOptions = {}): BarIndicator<BollingerValue> {
  return fromSource(
    new BollingerBands(options.period ?? 20, options.deviations ?? 2),
    options.source,
  );
}

export interface MacdOptions {
  readonly fast?: number | undefined;
  readonly slow?: number | undefined;
  readonly signal?: number | undefined;
  readonly source?: PriceSource | undefined;
}

export function macd(options: MacdOptions = {}): BarIndicator<MacdValue> {
  return fromSource(
    new Macd(options.fast ?? 12, options.slow ?? 26, options.signal ?? 9),
    options.source,
  );
}

/** True range is a property of the whole bar, so this one needs no source. */
export function atr(options: { period?: number | undefined } = {}): BarIndicator {
  return new Atr(options.period ?? 14);
}

export function vwap(options: VwapOptions = {}): BarIndicator {
  return new Vwap(options);
}
