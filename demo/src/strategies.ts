/**
 * The strategies the demo offers, and the shape of their controls.
 *
 * Three of them, chosen so that no two exercise the same part of the engine. A site that offers one
 * strategy is showing you a result; a site that offers three is showing you an engine, and the
 * difference between the three is the argument.
 *
 * - **Crossover** holds until the averages cross back, so it never rests two orders at once.
 * - **Breakout** brackets every entry with a stop and a target, which is what puts two resting
 *   orders on one bar and makes `stats.ambiguousBars` stop being zero.
 * - **Mean reversion** wins often and loses large, the mirror image of the crossover, so the two
 *   together break the habit of reading a win rate as a verdict.
 *
 * Each spec owns its own `run`, which is what keeps this file free of `any`. The form deals in a
 * bag of numbers and booleans; the narrowing happens once, inside the closure that knows the
 * strategy's parameter type.
 */

import { PRESETS, type RunResult, runBacktest } from '@tapedeck/core';
import smaCrossover from '../../examples/sma-crossover/src/strategy.ts';
import breakout from '../../examples/breakout/src/strategy.ts';
import meanReversion from '../../examples/mean-reversion/src/strategy.ts';
import type { Tape } from './tape.ts';
import { quantityFor } from './tape.ts';

export const INITIAL_CASH = '100000';

/** Fixed, and part of the contract: the same seed is why two machines agree to the cent. */
export const SEED = 20_260_825;

export type CostPreset = 'ideal' | 'binanceSpot';
export type ParamValue = number | boolean;
export type Values = Readonly<Record<string, ParamValue>>;

export interface ParamSpec {
  readonly key: string;
  readonly label: string;
  readonly help: string;
  readonly kind: 'int' | 'number' | 'bool';
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}

export interface StrategySpec {
  readonly id: string;
  readonly name: string;
  /** One line, in the vocabulary of someone who trades. Shown under the picker. */
  readonly blurb: string;
  readonly params: readonly ParamSpec[];
  readonly defaults: Values;
  readonly run: (tape: Tape, values: Values, qty: number, preset: CostPreset) => RunResult;
}

/** Reads one value out of the form bag, falling back to the default when it is missing or wrong. */
function int(values: Values, key: string, fallback: number): number {
  const value = values[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
}

function num(values: Values, key: string, fallback: number): number {
  const value = values[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bool(values: Values, key: string, fallback: boolean): boolean {
  const value = values[key];
  return typeof value === 'boolean' ? value : fallback;
}

/** The parts of a run that never depend on which strategy is selected. */
function common(tape: Tape, preset: CostPreset) {
  return {
    instruments: [tape.instrument],
    initialCash: INITIAL_CASH,
    seed: SEED,
    execution: PRESETS[preset](),
    flattenAtEnd: true,
    // The guarded bar view costs about half the throughput and exists to catch a strategy that
    // keeps the bar. None of these do, and speed is part of the demonstration.
    barViewMode: 'reuse',
  } as const;
}

export const STRATEGIES: readonly StrategySpec[] = [
  {
    id: 'sma-crossover',
    name: 'Moving-average crossover',
    blurb:
      'Long while the fast average is above the slow one. Trend following: it wins rarely and wins big, so read the profit factor rather than the win rate.',
    params: [
      {
        key: 'fastPeriod',
        label: 'fast average',
        kind: 'int',
        min: 2,
        max: 200,
        help: 'Bars in the shorter moving average. It reacts sooner, so it crosses more often and pays more commission.',
      },
      {
        key: 'slowPeriod',
        label: 'slow average',
        kind: 'int',
        min: 3,
        max: 400,
        help: 'Bars in the longer moving average. The pair crossing is the entire signal: fast above slow is long, below is short.',
      },
      {
        key: 'allowShort',
        label: 'allow shorts',
        kind: 'bool',
        help: 'When on, a bearish cross opens a short. When off, it exits to flat instead, which is what a spot account without margin can actually do.',
      },
    ],
    defaults: { fastPeriod: 24, slowPeriod: 72, allowShort: true },
    run: (tape, values, qty, preset) =>
      runBacktest(
        {
          ...common(tape, preset),
          strategy: smaCrossover,
          params: {
            fastPeriod: int(values, 'fastPeriod', 24),
            slowPeriod: int(values, 'slowPeriod', 72),
            qty,
            allowShort: bool(values, 'allowShort', true),
          },
        },
        [tape.chunk],
      ),
  },

  {
    id: 'breakout',
    name: 'Breakout with a bracket',
    blurb:
      'Buys a close above the highest high of the last N bars, on above-average volume, then rests a stop and a target together. This is the one that makes the engine report bars it could not resolve.',
    params: [
      {
        key: 'lookback',
        label: 'channel length',
        kind: 'int',
        min: 2,
        max: 400,
        help: 'How many bars the high-water channel remembers. The entry needs a close above the highest high of the previous N, measured before this bar joins the window.',
      },
      {
        key: 'atrPeriod',
        label: 'ATR length',
        kind: 'int',
        min: 2,
        max: 200,
        help: 'Bars in the Average True Range, which sizes the stop and the target so they scale with how much the instrument is actually moving.',
      },
      {
        key: 'stopAtr',
        label: 'stop (ATRs)',
        kind: 'number',
        min: 0.1,
        max: 20,
        step: 0.5,
        help: 'Distance from the entry to the stop, in ATRs. Tighter stops are hit more often, which is where the ambiguous bars come from.',
      },
      {
        key: 'targetAtr',
        label: 'target (ATRs)',
        kind: 'number',
        min: 0.1,
        max: 40,
        step: 0.5,
        help: 'Distance from the entry to the target, in ATRs. When a single bar contains both this and the stop, the fill order cannot be known from bar data, and the engine says so instead of guessing in your favour.',
      },
      {
        key: 'volumeFactor',
        label: 'volume filter',
        kind: 'number',
        min: 0,
        max: 10,
        step: 0.1,
        help: 'Volume must exceed this multiple of its own rolling average for a breakout to count. Set it to 0 to take every breakout.',
      },
    ],
    defaults: { lookback: 48, atrPeriod: 14, stopAtr: 2, targetAtr: 3, volumeFactor: 1.2 },
    run: (tape, values, qty, preset) =>
      runBacktest(
        {
          ...common(tape, preset),
          strategy: breakout,
          params: {
            lookback: int(values, 'lookback', 48),
            atrPeriod: int(values, 'atrPeriod', 14),
            stopAtr: num(values, 'stopAtr', 2),
            targetAtr: num(values, 'targetAtr', 3),
            volumeFactor: num(values, 'volumeFactor', 1.2),
            qty,
          },
        },
        [tape.chunk],
      ),
  },

  {
    id: 'mean-reversion',
    name: 'RSI mean reversion',
    blurb:
      'Buys weakness and sells the bounce, with a time stop so a position that never reverts cannot hold the run hostage. Wins often and loses large, which is the crossover in reverse.',
    params: [
      {
        key: 'rsiPeriod',
        label: 'RSI length',
        kind: 'int',
        min: 2,
        max: 100,
        help: 'Bars in the Relative Strength Index. Shorter reacts faster and fires more often.',
      },
      {
        key: 'entryLevel',
        label: 'buy below',
        kind: 'int',
        min: 1,
        max: 99,
        help: 'RSI level that counts as oversold enough to buy. Lower means fewer and more extreme entries.',
      },
      {
        key: 'exitLevel',
        label: 'sell above',
        kind: 'int',
        min: 2,
        max: 100,
        help: 'RSI level that counts as recovered. It has to sit above the entry level, or there would be no trade to hold.',
      },
      {
        key: 'maxBarsHeld',
        label: 'time stop (bars)',
        kind: 'int',
        min: 1,
        max: 2000,
        help: 'Bars to wait for the reversion before giving up. Without one, a position that never reverts is held to the end of the run and the equity curve describes that trade rather than the rule.',
      },
    ],
    defaults: { rsiPeriod: 14, entryLevel: 30, exitLevel: 55, maxBarsHeld: 48 },
    run: (tape, values, qty, preset) =>
      runBacktest(
        {
          ...common(tape, preset),
          strategy: meanReversion,
          params: {
            rsiPeriod: int(values, 'rsiPeriod', 14),
            entryLevel: int(values, 'entryLevel', 30),
            exitLevel: int(values, 'exitLevel', 55),
            maxBarsHeld: int(values, 'maxBarsHeld', 48),
            qty,
          },
        },
        [tape.chunk],
      ),
  },
];

export const DEFAULT_STRATEGY = STRATEGIES[0]?.id ?? 'sma-crossover';

export const strategyById = (id: string): StrategySpec | undefined =>
  STRATEGIES.find((s) => s.id === id);

/** Runs whichever strategy the configuration names. The single place a backtest is constructed. */
export function runStrategy(
  tape: Tape,
  id: string,
  values: Values,
  notional: number,
  preset: CostPreset,
): RunResult {
  const spec = strategyById(id);
  if (spec === undefined) throw new Error(`no strategy named ${id}`);
  return spec.run(tape, values, quantityFor(tape, notional), preset);
}
