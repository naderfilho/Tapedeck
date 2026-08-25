/**
 * Value-level primitives: they consume a stream of numbers and are the building blocks the
 * bar-level indicators compose. A MACD is an EMA of the difference of two EMAs, and that only
 * expresses cleanly if an EMA can consume something other than a bar.
 *
 * The naming convention across this package: **classes take numbers, factory functions take
 * bars.** `new Ema(20)` smooths a number stream; `ema({ period: 20 })` smooths a bar's close.
 *
 * ## Two numerical decisions worth reading
 *
 * **Rolling sums are resynchronised.** Maintaining a window sum by adding the incoming value and
 * subtracting the outgoing one accumulates floating-point error without bound — over a million
 * bars it is visible. Every windowed primitive here recomputes its accumulators from the window
 * whenever the ring buffer wraps: `period` additions every `period` updates, so O(1) amortised,
 * and the error can never grow past one lap of the window.
 *
 * **Variance is computed against a shift.** The textbook `E[x^2] - E[x]^2` catastrophically
 * cancels exactly where this engine lives: prices are large (a BTC price in cents is ~7e6) and
 * their local spread is small. Squaring the mean produces ~5e13 while the variance may be ~1e0,
 * and a double has no room left for the answer. Accumulating deviations from a shift near the
 * data keeps both accumulators small and the subtraction well conditioned. `primitives.test.ts`
 * contains the case that fails without it.
 */

import type { Indicator, ValueIndicator } from '@tapedeck/core';

/**
 * Two independent things can spoil a rolling variance, and each needs its own guard.
 *
 * **Removal cancellation.** When a large value leaves the window, `sumSq` loses its contribution by
 * subtraction. The absolute error that leaves behind is proportional to the *departed* magnitude,
 * not to what remains, so a single outlier passing through a window poisons every subsequent value
 * until the accumulator is rebuilt. `sumSqError` carries a running bound on that error and forces a
 * rebuild once it matters. Found by a property test, not by inspection.
 *
 * **Shift staleness.** The final `sumSq - sum^2 / n` cancels catastrophically when the shift has
 * drifted far from the data, and that error is invisible to the bound above because it happens in
 * the subtraction rather than in the accumulator.
 */
const SUMSQ_ERROR_TOLERANCE = 1e-12;
const STALE_SHIFT_RATIO = 1e6;
const FLOAT_EPSILON = Number.EPSILON;

export interface RollingStatsValue {
  readonly mean: number;
  /** Population variance: divided by `period`, the convention Bollinger bands assume. */
  readonly variance: number;
  readonly stdDev: number;
}

/** Mean and standard deviation over a fixed window, O(1) amortised. */
export class RollingStats implements Indicator<number, RollingStatsValue> {
  readonly name: string;
  readonly period: number;
  private readonly window: Float64Array;
  private cursor = 0;
  private filled = 0;
  private shift = 0;
  private sum = 0;
  private sumSq = 0;
  /** Running bound on the absolute error accumulated in {@link sumSq}. */
  private sumSqError = 0;
  private current: RollingStatsValue | null = null;

  constructor(period: number) {
    if (!Number.isInteger(period) || period < 1) {
      throw new RangeError(`period must be a positive integer, got ${String(period)}`);
    }
    this.period = period;
    this.name = `stats(${String(period)})`;
    this.window = new Float64Array(period);
  }

  get ready(): boolean {
    return this.filled === this.period;
  }

  get value(): RollingStatsValue | null {
    return this.current;
  }

  update(input: number): RollingStatsValue | null {
    if (this.filled === 0) this.shift = input;

    const outgoing = this.window[this.cursor] ?? 0;
    this.window[this.cursor] = input;

    const incoming = input - this.shift;
    const incomingSq = incoming * incoming;
    if (this.filled < this.period) {
      this.filled++;
      this.sum += incoming;
      this.sumSq += incomingSq;
      this.sumSqError += FLOAT_EPSILON * incomingSq;
    } else {
      const leaving = outgoing - this.shift;
      const leavingSq = leaving * leaving;
      this.sum += incoming - leaving;
      this.sumSq += incomingSq - leavingSq;
      this.sumSqError += FLOAT_EPSILON * (incomingSq + leavingSq);
    }

    this.cursor = (this.cursor + 1) % this.period;
    if (this.cursor === 0 && this.filled === this.period) this.resync();

    if (this.filled < this.period) {
      this.current = null;
      return null;
    }

    const n = this.period;
    let mean = this.shift + this.sum / n;
    // Clamped: an exactly constant window can produce a tiny negative through rounding.
    let variance = Math.max(0, (this.sumSq - (this.sum * this.sum) / n) / n);

    // Rebuild when either guard trips: the accumulator has lost too many digits to values that
    // have left the window, or the shift has drifted far enough that the subtraction above is
    // cancelling. Both are rare on real data and both are O(period) when they happen.
    // The error is judged against the *centred* sum of squares — the quantity actually being
    // reported — not against the raw accumulator, which a stale shift inflates by orders of
    // magnitude and which would therefore hide the very error this is looking for.
    const centred = n * variance;
    if (
      this.sumSqError > SUMSQ_ERROR_TOLERANCE * centred ||
      this.sumSq > STALE_SHIFT_RATIO * centred
    ) {
      this.resync();
      mean = this.shift + this.sum / n;
      variance = Math.max(0, (this.sumSq - (this.sum * this.sum) / n) / n);
    }

    this.current = { mean, variance, stdDev: Math.sqrt(variance) };
    return this.current;
  }

  reset(): void {
    this.window.fill(0);
    this.cursor = 0;
    this.filled = 0;
    this.shift = 0;
    this.sum = 0;
    this.sumSq = 0;
    this.sumSqError = 0;
    this.current = null;
  }

  /** Recomputes both accumulators from the window, re-centring the shift on the current mean. */
  private resync(): void {
    const n = this.period;
    const shift = this.shift + this.sum / n;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const deviation = (this.window[i] ?? 0) - shift;
      sum += deviation;
      sumSq += deviation * deviation;
    }
    this.shift = shift;
    this.sum = sum;
    this.sumSq = sumSq;
    this.sumSqError = 0;
  }
}

/**
 * Simple moving average.
 *
 * Written out rather than delegating to {@link RollingStats}, for two reasons the benchmark made
 * obvious: an average has no use for the sum of squares, and returning a `{ mean, variance,
 * stdDev }` record allocates an object per bar per indicator. On a million-bar replay with two
 * averages, dropping both took 134 nanoseconds a bar down to 110 (ADR-0004).
 *
 * The rolling sum is still resynchronised on every lap of the window, so add-and-subtract error
 * cannot accumulate past one period.
 */
export class Sma implements ValueIndicator {
  readonly name: string;
  readonly period: number;
  private readonly window: Float64Array;
  private cursor = 0;
  private filled = 0;
  private shift = 0;
  private sum = 0;
  private current: number | null = null;

  constructor(period: number) {
    if (!Number.isInteger(period) || period < 1) {
      throw new RangeError(`period must be a positive integer, got ${String(period)}`);
    }
    this.period = period;
    this.name = `sma(${String(period)})`;
    this.window = new Float64Array(period);
  }

  get ready(): boolean {
    return this.filled === this.period;
  }

  get value(): number | null {
    return this.current;
  }

  update(input: number): number | null {
    if (this.filled === 0) this.shift = input;

    const outgoing = this.window[this.cursor] ?? 0;
    this.window[this.cursor] = input;

    if (this.filled < this.period) {
      this.filled++;
      this.sum += input - this.shift;
    } else {
      this.sum += input - outgoing;
    }

    this.cursor = (this.cursor + 1) % this.period;
    if (this.cursor === 0 && this.filled === this.period) this.resync();

    this.current = this.filled < this.period ? null : this.shift + this.sum / this.period;
    return this.current;
  }

  reset(): void {
    this.window.fill(0);
    this.cursor = 0;
    this.filled = 0;
    this.shift = 0;
    this.sum = 0;
    this.current = null;
  }

  private resync(): void {
    const shift = this.shift + this.sum / this.period;
    let sum = 0;
    for (let i = 0; i < this.period; i++) sum += (this.window[i] ?? 0) - shift;
    this.shift = shift;
    this.sum = sum;
  }
}

/**
 * Exponential smoothing, seeded with the simple average of the first `period` samples.
 *
 * The seeding matters and libraries disagree about it: starting from the first sample instead
 * makes the first few dozen values differ noticeably. This follows the convention used by
 * TradingView and by most charting packages, so a value here matches what a chart shows.
 */
export class SmoothedAverage implements ValueIndicator {
  readonly name: string;
  readonly period: number;
  readonly alpha: number;
  private readonly seed: Sma;
  private current: number | null = null;

  constructor(period: number, alpha: number, label: string) {
    if (!Number.isInteger(period) || period < 1) {
      throw new RangeError(`period must be a positive integer, got ${String(period)}`);
    }
    this.period = period;
    this.alpha = alpha;
    this.name = `${label}(${String(period)})`;
    this.seed = new Sma(period);
  }

  get ready(): boolean {
    return this.current !== null;
  }

  get value(): number | null {
    return this.current;
  }

  update(input: number): number | null {
    if (this.current === null) {
      // The sample that completes the seed is already inside the average; do not smooth it twice.
      this.current = this.seed.update(input);
      return this.current;
    }
    this.current = this.alpha * input + (1 - this.alpha) * this.current;
    return this.current;
  }

  reset(): void {
    this.seed.reset();
    this.current = null;
  }
}

/** Exponential moving average, `alpha = 2 / (period + 1)`. */
export class Ema extends SmoothedAverage {
  constructor(period: number) {
    super(period, 2 / (period + 1), 'ema');
  }
}

/**
 * Wilder's smoothing, `alpha = 1 / period`. Not the same as an EMA of the same period — an RMA(14)
 * behaves like an EMA(27) — and it is what RSI and ATR are defined in terms of.
 */
export class Rma extends SmoothedAverage {
  constructor(period: number) {
    super(period, 1 / period, 'rma');
  }
}
