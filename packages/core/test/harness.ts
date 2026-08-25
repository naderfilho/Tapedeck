/**
 * A one-call harness for behavioural tests: describe the bars, describe what the strategy does,
 * get a run result back. Tests read as scenarios rather than as engine wiring.
 */

import {
  type BarChunk,
  type BarEvent,
  type CalendarSpec,
  type ExecutionConfig,
  type InstrumentSpec,
  type OrderCancelledEvent,
  type OrderFilledEvent,
  type OrderRejectedEvent,
  type RunResult,
  type Strategy,
  type StrategyContext,
  type ViewMode,
  Engine,
} from '@tapedeck/core';
import { type BarRow, TEST_FUTURE, bars, splitChunk } from './helpers.ts';

export interface ScriptOptions {
  readonly rows: readonly BarRow[];
  readonly instrument?: InstrumentSpec;
  readonly execution?: Partial<ExecutionConfig>;
  readonly calendar?: CalendarSpec;
  /** Feed this chunk instead of building one from `rows`. For tests that need real timestamps. */
  readonly chunkOverride?: BarChunk;
  readonly initialCash?: string;
  readonly seed?: number;
  /** Feed the same data split into this many chunks. Used by the chunk-invariance test. */
  readonly chunks?: number;
  readonly flattenAtEnd?: boolean;
  readonly barViewMode?: ViewMode;
  readonly startTs?: number;
  readonly timeframe?: number;
  readonly onInit?: (ctx: StrategyContext) => void;
  readonly onBar?: (bar: BarEvent, ctx: StrategyContext) => void;
  readonly onFill?: (fill: OrderFilledEvent, ctx: StrategyContext) => void;
  readonly onReject?: (event: OrderRejectedEvent, ctx: StrategyContext) => void;
  readonly onCancel?: (event: OrderCancelledEvent, ctx: StrategyContext) => void;
  readonly onStop?: (ctx: StrategyContext) => void;
}

export function runScript(options: ScriptOptions): RunResult {
  const strategy: Strategy = {
    id: 'test-script',
    onInit: (ctx) => options.onInit?.(ctx),
    onBar: (bar, ctx) => options.onBar?.(bar, ctx),
    onFill: (fill, ctx) => options.onFill?.(fill, ctx),
    onReject: (event, ctx) => options.onReject?.(event, ctx),
    onCancel: (event, ctx) => options.onCancel?.(event, ctx),
    onStop: (ctx) => options.onStop?.(ctx),
  };

  const engine = new Engine({
    instruments: [options.instrument ?? TEST_FUTURE],
    strategy: () => strategy,
    params: {},
    initialCash: options.initialCash ?? '100000',
    seed: options.seed ?? 1,
    execution: options.execution,
    ...(options.calendar === undefined ? {} : { calendar: options.calendar }),
    flattenAtEnd: options.flattenAtEnd ?? false,
    barViewMode: options.barViewMode,
  });

  const chunk =
    options.chunkOverride ??
    bars(options.rows, { startTs: options.startTs, timeframe: options.timeframe });
  for (const part of splitChunk(chunk, options.chunks ?? 1)) engine.feedBars(part);
  return engine.finish();
}

/** The single fill a scenario produced, asserting there was exactly one. */
export function onlyFill(result: RunResult): OrderFilledEvent {
  if (result.fills.length !== 1) {
    throw new Error(`expected exactly one fill, got ${String(result.fills.length)}`);
  }
  const fill = result.fills[0];
  if (fill === undefined) throw new Error('unreachable');
  return fill;
}
