/**
 * Shared builders for the report tests.
 *
 * Metrics are a pure function of an equity curve and a trade list, so the tests construct results
 * directly rather than running a backtest: a failure should need one explanation, not two.
 */

import {
  type InstrumentId,
  type MoneyInt,
  type RunResult,
  type Timestamp,
  type TradeRecord,
  MICROS_PER_HOUR,
  asMoney,
  asPrice,
  asQty,
  asTimestamp,
} from '@tapedeck/core';

export const MONEY = 100_000_000;
const ZERO = 0 as InstrumentId;

export function money(units: number): MoneyInt {
  return asMoney(Math.round(units * MONEY));
}

export interface ResultOptions {
  readonly equity: readonly number[];
  readonly spacing?: number;
  readonly trades?: readonly Partial<TradeRecord>[];
  readonly commission?: number;
  readonly warnings?: readonly string[];
  readonly ambiguousBars?: number;
}

export function trade(index: number, netPnl: number, barsHeld = 1): TradeRecord {
  return {
    id: index,
    instrumentId: ZERO,
    symbol: 'TEST',
    direction: netPnl >= 0 ? 'long' : 'short',
    qty: asQty(1),
    entryTs: asTimestamp(index * MICROS_PER_HOUR),
    exitTs: asTimestamp((index + barsHeld) * MICROS_PER_HOUR),
    entryPrice: asPrice(100),
    exitPrice: asPrice(100 + netPnl),
    grossPnl: money(netPnl),
    commission: asMoney(0),
    netPnl: money(netPnl),
    barsHeld,
    mae: asMoney(0),
    mfe: asMoney(0),
  };
}

/**
 * Builds a result directly rather than by running the engine.
 *
 * Metrics are a pure function of an equity curve and a trade list, and testing them through a
 * backtest would mean every failure needs two explanations.
 */
export function makeResult(options: ResultOptions): RunResult {
  const spacing = options.spacing ?? MICROS_PER_HOUR;
  const length = options.equity.length;
  const ts = new Float64Array(length);
  const equity = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    ts[i] = (i + 1) * spacing;
    equity[i] = Math.round((options.equity[i] ?? 0) * MONEY);
  }
  const trades = (options.trades ?? []) as TradeRecord[];

  return {
    config: {
      strategyId: 'test',
      seed: 1,
      initialCash: money(options.equity[0] ?? 0),
      instruments: ['TEST:TEST'],
      intrabarPolicy: 'pessimistic',
      slippageModel: 'none',
      commissionModel: 'none',
      latencyModel: 'none',
      liquidityModel: 'unlimited',
      barViewMode: 'reuse',
      params: {},
    },
    stats: {
      ordersSubmitted: 0,
      ordersRejected: 0,
      ordersCancelled: 0,
      ordersFilled: 0,
      fills: 0,
      partialFills: 0,
      ambiguousBars: options.ambiguousBars ?? 0,
      stopLimitDeferrals: 0,
      subBarLatencyIgnored: 0,
      ordersAmended: 0,
      ocoReductions: 0,
      bars: length,
      ticks: 0,
      signals: 0,
      logsDropped: 0,
      flattenedPositions: 0,
    },
    startTs: length === 0 ? null : (ts[0] as Timestamp),
    endTs: length === 0 ? null : (ts[length - 1] as Timestamp),
    initialCash: money(options.equity[0] ?? 0),
    finalEquity: money(options.equity[length - 1] ?? 0),
    cash: money(options.equity[length - 1] ?? 0),
    realizedPnl: asMoney(0),
    unrealizedPnl: asMoney(0),
    commissionPaid: money(options.commission ?? 0),
    trades,
    equityCurve: { length, ts, equity },
    fills: [],
    amendments: [],
    signals: [],
    openPositions: [],
    logs: [],
    warnings: options.warnings ?? [],
  };
}
