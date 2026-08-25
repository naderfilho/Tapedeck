/**
 * What a run produces.
 *
 * The result is designed to be *diffable*. Everything in it is either an exact fixed-point integer
 * or a string, key order is fixed, and {@link serializeRunResult} emits canonical JSON. That is
 * what makes "the same inputs produce the same bytes" a claim a test can check rather than a
 * sentence in a README (ADR-0006).
 */

import type { MoneyInt } from '../math/fixed.ts';
import type { OrderFilledEvent, SignalEvent } from '../events/events.ts';
import type { PositionView } from '../portfolio/portfolio.ts';
import type { TradeRecord } from '../portfolio/trades.ts';
import type { LogEntry } from '../util/logger.ts';
import type { BrokerStats } from '../execution/broker.ts';
import type { Timestamp } from '../time/timestamp.ts';

export interface EquityPoint {
  readonly ts: Timestamp;
  readonly equity: MoneyInt;
}

export interface EquityCurve {
  readonly length: number;
  readonly ts: Float64Array;
  readonly equity: Float64Array;
}

/** Growable columnar recorder. One equity point per bar, with no allocation per bar. */
export class EquityRecorder {
  private tsColumn: Float64Array;
  private equityColumn: Float64Array;
  private size = 0;

  constructor(capacity = 4096) {
    this.tsColumn = new Float64Array(capacity);
    this.equityColumn = new Float64Array(capacity);
  }

  get length(): number {
    return this.size;
  }

  push(ts: number, equity: number): void {
    if (this.size === this.tsColumn.length) {
      const grown = this.tsColumn.length * 2;
      const ts2 = new Float64Array(grown);
      const eq2 = new Float64Array(grown);
      ts2.set(this.tsColumn);
      eq2.set(this.equityColumn);
      this.tsColumn = ts2;
      this.equityColumn = eq2;
    }
    this.tsColumn[this.size] = ts;
    this.equityColumn[this.size] = equity;
    this.size++;
  }

  snapshot(): EquityCurve {
    return {
      length: this.size,
      ts: this.tsColumn.subarray(0, this.size),
      equity: this.equityColumn.subarray(0, this.size),
    };
  }
}

export interface RunStats extends BrokerStats {
  bars: number;
  ticks: number;
  signals: number;
  /** Log entries discarded because the buffer cap was reached. */
  logsDropped: number;
  /** Positions the engine had to flatten because the run ended while they were open. */
  flattenedPositions: number;
}

export interface RunConfigSummary {
  readonly strategyId: string;
  readonly seed: number;
  readonly initialCash: MoneyInt;
  readonly instruments: readonly string[];
  readonly intrabarPolicy: string;
  readonly slippageModel: string;
  readonly commissionModel: string;
  readonly latencyModel: string;
  readonly liquidityModel: string;
  readonly barViewMode: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface RunResult {
  readonly config: RunConfigSummary;
  readonly stats: RunStats;
  readonly startTs: Timestamp | null;
  readonly endTs: Timestamp | null;
  readonly initialCash: MoneyInt;
  readonly finalEquity: MoneyInt;
  readonly cash: MoneyInt;
  readonly realizedPnl: MoneyInt;
  readonly unrealizedPnl: MoneyInt;
  readonly commissionPaid: MoneyInt;
  readonly trades: readonly TradeRecord[];
  readonly equityCurve: EquityCurve;
  readonly fills: readonly OrderFilledEvent[];
  /** Intents the strategy published through `ctx.signal()`, for intent-vs-execution attribution. */
  readonly signals: readonly SignalEvent[];
  readonly openPositions: readonly PositionView[];
  readonly logs: readonly LogEntry[];
  /**
   * Human-readable notes about how much of this result is a modelling assumption rather than a
   * measurement. Printed by the CLI above the metrics, on purpose.
   */
  readonly warnings: readonly string[];
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Float64Array) return Array.from(value);
  return value;
}

/**
 * Canonical JSON for the parts of a result that are exact.
 *
 * Deliberately excludes nothing: every field here is an integer, a string or a boolean, so two
 * runs that agree semantically produce identical bytes. Derived float metrics live in
 * `@tapedeck/report` and are compared at a tolerance instead (ADR-0006).
 */
export function serializeRunResult(result: RunResult): string {
  return JSON.stringify(
    {
      config: result.config,
      stats: result.stats,
      startTs: result.startTs,
      endTs: result.endTs,
      initialCash: result.initialCash,
      finalEquity: result.finalEquity,
      cash: result.cash,
      realizedPnl: result.realizedPnl,
      unrealizedPnl: result.unrealizedPnl,
      commissionPaid: result.commissionPaid,
      trades: result.trades,
      equityCurve: {
        length: result.equityCurve.length,
        ts: Array.from(result.equityCurve.ts),
        equity: Array.from(result.equityCurve.equity),
      },
      fills: result.fills,
      signals: result.signals,
      openPositions: result.openPositions,
      logs: result.logs,
      warnings: result.warnings,
    },
    replacer,
    2,
  );
}
