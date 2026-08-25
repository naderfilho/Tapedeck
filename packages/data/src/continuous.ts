/**
 * Continuous futures series: many contracts stitched into one price history.
 *
 * A strategy wants a moving average across two years. A future only exists for a few months, so
 * "two years of WIN" is not a thing that ever traded — it is a construction, and every construction
 * of it is wrong in a different way. This module makes the choice explicit and reports what the
 * choice cost, which is the most this can honestly do.
 *
 * **A back-adjusted price never traded.** After stitching, the last contract's prices are real and
 * every earlier bar has been shifted so the series has no jump at the roll. Those shifted numbers
 * are not prices; they are a series with the same *differences* as the real one. Two consequences
 * that catch people:
 *
 * - Percentage returns computed on an adjusted series are meaningless, because the denominators
 *   are invented. Point differences are exactly right, which is why difference-adjustment is the
 *   correct choice for futures PnL and ratio-adjustment is not. Ratio does not even buy exact
 *   returns in exchange: prices here are fixed-point integers, so a scaled price is rounded back
 *   to the instrument's scale and the return survives only to within that rounding. On a coarse
 *   scale — WIN quotes whole index points — the error is visible. A test pins it down.
 * - Difference-adjustment can push early bars to zero or below on a long history. A negative price
 *   is not a price, and the engine refuses one — so this detects it and says so instead of handing
 *   back a tape that fails hundreds of bars later.
 *
 * **The roll date is part of the answer, not a detail.** Change when you roll and you change the
 * gaps, which changes every adjusted price before them. Rolling on a rule ("five sessions before
 * expiry") is a guess; rolling on the day the next contract's volume overtakes the current one's
 * is a measurement, and it is available whenever the data carries volume.
 */

import {
  type BarChunk,
  type Contract,
  type InstrumentId,
  type PriceInt,
  type Timestamp,
  BarChunkBuilder,
  ConfigError,
  asPrice,
  toIso,
} from '@tapedeck/core';

/** One contract's own bars, as the venue published them. */
export interface ContractBars {
  readonly contract: Contract;
  readonly chunk: BarChunk;
}

export type AdjustmentMethod =
  /** Shift earlier bars by the roll gap. Preserves point differences, and therefore futures PnL. */
  | 'difference'
  /** Scale earlier bars by the roll ratio. Preserves percentage returns, and distorts points. */
  | 'ratio'
  /** Leave the prices alone. The series jumps at every roll, and says so. */
  | 'none';

export type RollTrigger =
  /** The series' own rule, from `contract.rollsAt`. */
  | 'rule'
  /** The first session on which the next contract printed more volume than the current one. */
  | 'volume';

export interface StitchOptions {
  readonly contracts: readonly ContractBars[];
  readonly instrumentId?: InstrumentId | undefined;
  /** Defaults to `difference`, which is the one that keeps futures PnL correct. */
  readonly method?: AdjustmentMethod | undefined;
  /** Defaults to `rule`. `volume` needs both contracts to carry volume on the overlap. */
  readonly rollOn?: RollTrigger | undefined;
}

export interface RollPoint {
  /** Close of the last bar taken from `from`. */
  readonly ts: Timestamp;
  readonly from: string;
  readonly to: string;
  /** `to`'s price minus `from`'s price on the overlap bar, before any adjustment. */
  readonly gap: PriceInt;
  /** What triggered it, which is not always what was asked for — see the warnings. */
  readonly trigger: RollTrigger;
}

export interface ContinuousSeries {
  readonly chunk: BarChunk;
  readonly rolls: readonly RollPoint[];
  readonly method: AdjustmentMethod;
  /** Everything the stitch had to assume or could not do. Print these above the results. */
  readonly warnings: readonly string[];
}

interface Segment {
  readonly bars: ContractBars;
  /** Index of the first bar this contract contributes. */
  readonly start: number;
  /** Index one past the last bar this contract contributes. */
  readonly end: number;
}

/** Index of the last bar closing at or before `ts`, or -1 when there is none. */
function lastBarAtOrBefore(chunk: BarChunk, ts: Timestamp): number {
  let low = 0;
  let high = chunk.count - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((chunk.closeTs[middle] ?? 0) <= ts) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/** Index of the bar whose close is exactly `ts`, or -1. */
function barAt(chunk: BarChunk, ts: Timestamp): number {
  const index = lastBarAtOrBefore(chunk, ts);
  return index >= 0 && chunk.closeTs[index] === ts ? index : -1;
}

/**
 * The session on which `next` first out-traded `current`.
 *
 * Volume migrates over several sessions rather than on one, so this is the crossover and not "the
 * day everyone moved". It is still a measurement of something that happened, which the rule is not.
 */
function volumeCrossover(current: BarChunk, next: BarChunk): Timestamp | null {
  for (let i = 0; i < current.count; i++) {
    const ts = (current.closeTs[i] ?? 0) as Timestamp;
    const j = barAt(next, ts);
    if (j < 0) continue;
    if ((next.volume[j] ?? 0) > (current.volume[i] ?? 0)) return ts;
  }
  return null;
}

export function stitchContinuous(options: StitchOptions): ContinuousSeries {
  const method = options.method ?? 'difference';
  const rollOn = options.rollOn ?? 'rule';
  const instrumentId = options.instrumentId ?? (0 as InstrumentId);
  const warnings: string[] = [];

  const ordered = [...options.contracts]
    .filter((entry) => entry.chunk.count > 0)
    .sort((a, b) => a.contract.expiry - b.contract.expiry);
  if (ordered.length === 0) {
    throw new ConfigError('a continuous series needs at least one contract with bars');
  }
  const timeframe = ordered[0]?.chunk.timeframe;
  if (timeframe === undefined) throw new ConfigError('missing timeframe');
  for (const entry of ordered) {
    if (entry.chunk.timeframe !== timeframe) {
      throw new ConfigError('every contract in a continuous series must share one timeframe', {
        expected: timeframe,
        found: entry.chunk.timeframe,
        contract: entry.contract.symbol,
      });
    }
  }

  // Where each contract stops contributing, and what the next one costs at that moment.
  const rolls: RollPoint[] = [];
  const segments: Segment[] = [];
  let previousEnd: Timestamp | null = null;

  for (let index = 0; index < ordered.length; index++) {
    const entry = ordered[index];
    if (entry === undefined) continue;
    const next = ordered[index + 1];
    const { chunk } = entry;

    const start = previousEnd === null ? 0 : lastBarAtOrBefore(chunk, previousEnd) + 1;
    if (next === undefined) {
      segments.push({ bars: entry, start, end: chunk.count });
      break;
    }

    let trigger: RollTrigger = rollOn;
    let rollTs: Timestamp | null = null;
    if (rollOn === 'volume') {
      rollTs = volumeCrossover(chunk, next.chunk);
      if (rollTs === null) {
        trigger = 'rule';
        rollTs = entry.contract.rollsAt;
        warnings.push(
          `${entry.contract.symbol}: no session where ${next.contract.symbol} out-traded it, so ` +
            `the roll fell back to the series' rule at ${toIso(entry.contract.rollsAt)}.`,
        );
      }
    } else {
      rollTs = entry.contract.rollsAt;
    }

    const end = lastBarAtOrBefore(chunk, rollTs) + 1;
    if (end <= start) {
      warnings.push(
        `${entry.contract.symbol} contributed no bars: its roll at ${toIso(rollTs)} is at or ` +
          `before the previous contract's. It has been dropped from the series.`,
      );
      continue;
    }

    const lastTs = (chunk.closeTs[end - 1] ?? 0) as Timestamp;
    const overlap = barAt(next.chunk, lastTs);
    let gap = 0;
    if (overlap < 0) {
      warnings.push(
        `${next.contract.symbol} has no bar on ${toIso(lastTs)}, the session ` +
          `${entry.contract.symbol} rolled on, so the gap between them could not be measured and ` +
          `was taken as zero. Every adjusted price before this roll is off by the real gap.`,
      );
    } else {
      gap = (next.chunk.close[overlap] ?? 0) - (chunk.close[end - 1] ?? 0);
    }

    segments.push({ bars: entry, start, end });
    rolls.push({
      ts: lastTs,
      from: entry.contract.symbol,
      to: next.contract.symbol,
      gap: asPrice(gap),
      trigger,
    });
    previousEnd = lastTs;
  }

  // Back-adjustment: the newest contract keeps its real prices and history is shifted onto it, so
  // the right-hand end of the chart is the one a reader can compare against a screen.
  const adjustments = new Float64Array(segments.length);
  for (let i = segments.length - 2; i >= 0; i--) {
    const roll = rolls[i];
    const later = adjustments[i + 1] ?? 0;
    if (roll === undefined) continue;
    adjustments[i] = method === 'ratio' ? later : later + roll.gap;
  }
  const ratios = new Float64Array(segments.length).fill(1);
  if (method === 'ratio') {
    for (let i = segments.length - 2; i >= 0; i--) {
      const roll = rolls[i];
      const segment = segments[i];
      if (roll === undefined || segment === undefined) continue;
      const closeAtRoll = segment.bars.chunk.close[segment.end - 1] ?? 0;
      const factor = closeAtRoll === 0 ? 1 : (closeAtRoll + roll.gap) / closeAtRoll;
      ratios[i] = (ratios[i + 1] ?? 1) * factor;
    }
  }

  let total = 0;
  for (const segment of segments) total += segment.end - segment.start;
  const builder = new BarChunkBuilder(instrumentId, timeframe, Math.max(1, total));
  let nonPositive = 0;

  for (let s = 0; s < segments.length; s++) {
    const segment = segments[s];
    if (segment === undefined) continue;
    const { chunk } = segment.bars;
    const shift = method === 'difference' ? (adjustments[s] ?? 0) : 0;
    const scale = method === 'ratio' ? (ratios[s] ?? 1) : 1;

    for (let i = segment.start; i < segment.end; i++) {
      const apply = (value: number): number =>
        method === 'ratio' ? Math.round(value * scale) : value + shift;
      const open = apply(chunk.open[i] ?? 0);
      const high = apply(chunk.high[i] ?? 0);
      const low = apply(chunk.low[i] ?? 0);
      const close = apply(chunk.close[i] ?? 0);
      if (low <= 0) nonPositive++;
      builder.push(
        chunk.openTs[i] ?? 0,
        chunk.closeTs[i] ?? 0,
        open,
        high,
        low,
        close,
        // Volume is not adjusted. It is a count of contracts and stitching does not change it,
        // but it is a count from a *different contract* on either side of a roll.
        chunk.volume[i] ?? 0,
      );
    }
  }

  if (nonPositive > 0) {
    warnings.push(
      `${String(nonPositive)} bar(s) came out at or below zero after adjustment. A negative price ` +
        `is not a price: the engine will reject orders against them, and any result computed from ` +
        `this series is meaningless. Use 'ratio', or start the series later.`,
    );
  }
  if (method === 'ratio') {
    warnings.push(
      `Ratio adjustment preserves percentage returns and distorts point differences, so the PnL ` +
        `of a futures position taken from this series is wrong by the scaling factor. Use it to ` +
        `study returns, not to size a trade. It does not preserve returns exactly either: a scaled ` +
        `price is rounded back to the instrument's scale, so the return survives only to within ` +
        `that rounding, and the coarser the price scale the worse it is.`,
    );
  }
  if (method === 'none' && rolls.length > 0) {
    warnings.push(
      `${String(rolls.length)} roll(s) were left unadjusted, so the series jumps by the full ` +
        `basis at each one. Any indicator crossing a roll is reading a jump that nobody traded.`,
    );
  }
  if (method !== 'none' && rolls.length > 0) {
    warnings.push(
      `${String(rolls.length)} roll(s) were adjusted away: every price before the last contract ` +
        `has been shifted and never traded at the value shown. Point differences are preserved; ` +
        `percentage returns computed on them are not meaningful.`,
    );
  }

  return { chunk: builder.build(), rolls, method, warnings };
}
