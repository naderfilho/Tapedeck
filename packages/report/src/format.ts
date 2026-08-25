/**
 * Turning metrics into something a person or a machine can read.
 *
 * The JSON is the interesting half. Every money field is a decimal **string**, because a
 * fixed-point integer without its scale is meaningless and a float would undo the exactness the
 * ledger worked for. Every ratio is rounded to twelve significant digits, which is what makes
 * ADR-0006's "compared at a documented tolerance" a mechanism rather than a promise: two runs of
 * the same configuration produce byte-identical JSON, on any machine, even though `Math.pow` is
 * not specified to the last bit.
 */

import { MONEY_EXP, formatFixed, toIso } from '@tapedeck/core';
import type { Metrics } from './metrics.ts';

/** Significant digits kept for every derived float. See ADR-0006. */
export const SIGNIFICANT_DIGITS = 12;

/**
 * Rounds to a number of significant digits, so the result does not depend on the last bit of a
 * transcendental function. Returns `null` unchanged and never produces `-0`.
 */
export function roundSignificant(value: number | null, digits = SIGNIFICANT_DIGITS): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value === 0) return 0;
  const rounded = Number(value.toPrecision(digits));
  return rounded === 0 ? 0 : rounded;
}

function money(value: number): string {
  return formatFixed(value, MONEY_EXP);
}

export interface MetricsJson {
  readonly period: {
    readonly start: string | null;
    readonly end: string | null;
    readonly days: number | null;
    readonly bars: number;
    readonly periodsPerYear: number | null;
  };
  readonly equity: {
    readonly initial: string;
    readonly final: string;
    readonly netProfit: string;
    readonly totalReturn: number | null;
    readonly cagr: number | null;
  };
  readonly risk: {
    readonly volatility: number | null;
    readonly downsideVolatility: number | null;
    readonly sharpe: number | null;
    readonly sortino: number | null;
    readonly calmar: number | null;
    readonly maxDrawdown: number | null;
    readonly maxDrawdownMoney: string;
    readonly maxDrawdownStart: string | null;
    readonly maxDrawdownTrough: string | null;
    readonly maxDrawdownRecovered: string | null;
    readonly maxDrawdownBars: number;
    readonly longestDrawdownBars: number;
    readonly recoveryFactor: number | null;
  };
  readonly trades: {
    readonly count: number;
    readonly wins: number;
    readonly losses: number;
    readonly winRate: number | null;
    readonly profitFactor: number | null;
    readonly expectancy: string;
    readonly grossProfit: string;
    readonly grossLoss: string;
    readonly preCostPnl: string;
    readonly avgWin: string;
    readonly avgLoss: string;
    readonly largestWin: string;
    readonly largestLoss: string;
    readonly avgBarsHeld: number | null;
    readonly exposure: number | null;
  };
  readonly costs: {
    readonly commissionPaid: string;
    readonly shareOfGross: number | null;
    readonly unitsTraded: number;
    readonly commissionPerUnit: string;
    readonly breakEvenCommissionPerUnit: string | null;
  };
  readonly modelling: {
    readonly ambiguousBars: number;
    readonly subBarLatencyIgnored: number;
    readonly warnings: readonly string[];
  };
}

export function metricsToJson(metrics: Metrics): MetricsJson {
  const episode = metrics.maxDrawdownEpisode;
  return {
    period: {
      start: metrics.startTs === null ? null : toIso(metrics.startTs),
      end: metrics.endTs === null ? null : toIso(metrics.endTs),
      days: roundSignificant(metrics.days),
      bars: metrics.bars,
      periodsPerYear: roundSignificant(metrics.periodsPerYear),
    },
    equity: {
      initial: money(metrics.initialEquity),
      final: money(metrics.finalEquity),
      netProfit: money(metrics.netProfit),
      totalReturn: roundSignificant(metrics.totalReturn),
      cagr: roundSignificant(metrics.cagr),
    },
    risk: {
      volatility: roundSignificant(metrics.volatility),
      downsideVolatility: roundSignificant(metrics.downsideVolatility),
      sharpe: roundSignificant(metrics.sharpe),
      sortino: roundSignificant(metrics.sortino),
      calmar: roundSignificant(metrics.calmar),
      maxDrawdown: roundSignificant(metrics.maxDrawdown),
      maxDrawdownMoney: money(metrics.maxDrawdownMoney),
      maxDrawdownStart: episode === null ? null : toIso(episode.peakTs),
      maxDrawdownTrough: episode === null ? null : toIso(episode.troughTs),
      maxDrawdownRecovered:
        episode === null || episode.recoveredTs === null ? null : toIso(episode.recoveredTs),
      maxDrawdownBars: episode?.bars ?? 0,
      longestDrawdownBars: metrics.longestDrawdownBars,
      recoveryFactor: roundSignificant(metrics.recoveryFactor),
    },
    trades: {
      count: metrics.trades,
      wins: metrics.wins,
      losses: metrics.losses,
      winRate: roundSignificant(metrics.winRate),
      profitFactor: roundSignificant(metrics.profitFactor),
      expectancy: money(metrics.expectancy),
      grossProfit: money(metrics.grossProfit),
      grossLoss: money(metrics.grossLoss),
      preCostPnl: money(metrics.preCostPnl),
      avgWin: money(metrics.avgWin),
      avgLoss: money(metrics.avgLoss),
      largestWin: money(metrics.largestWin),
      largestLoss: money(metrics.largestLoss),
      avgBarsHeld: roundSignificant(metrics.avgBarsHeld),
      exposure: roundSignificant(metrics.exposure),
    },
    costs: {
      commissionPaid: money(metrics.commissionPaid),
      shareOfGross: roundSignificant(metrics.commissionShareOfGross),
      unitsTraded: metrics.unitsTraded,
      commissionPerUnit: money(metrics.commissionPerUnit),
      breakEvenCommissionPerUnit:
        metrics.breakEvenCommissionPerUnit === null
          ? null
          : money(metrics.breakEvenCommissionPerUnit),
    },
    modelling: {
      ambiguousBars: metrics.ambiguousBars,
      subBarLatencyIgnored: metrics.subBarLatencyIgnored,
      warnings: metrics.warnings,
    },
  };
}

export function metricsToJsonString(metrics: Metrics): string {
  return `${JSON.stringify(metricsToJson(metrics), null, 2)}\n`;
}

function percent(value: number | null, digits = 2): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(digits)}%`;
}

function decimal(value: number | null, digits = 2): string {
  return value === null ? 'n/a' : value.toFixed(digits);
}

function row(label: string, value: string): string {
  return `  ${label.padEnd(22)}${value}`;
}

/**
 * A terminal summary.
 *
 * The modelling caveats print first, before any number they qualify. A report that buries them
 * under a Sharpe ratio is a report designed to be misread.
 */
export function formatMetrics(metrics: Metrics, currency = ''): string {
  const suffix = currency === '' ? '' : ` ${currency}`;
  const lines: string[] = [];

  if (metrics.warnings.length > 0) {
    lines.push('Modelling caveats');
    for (const warning of metrics.warnings) lines.push(`  ! ${warning}`);
    lines.push('');
  }

  lines.push('Period');
  lines.push(row('start', metrics.startTs === null ? 'n/a' : toIso(metrics.startTs)));
  lines.push(row('end', metrics.endTs === null ? 'n/a' : toIso(metrics.endTs)));
  lines.push(row('bars', `${String(metrics.bars)} (${metrics.days.toFixed(1)} days)`));
  lines.push('');

  lines.push('Result');
  lines.push(row('initial equity', money(metrics.initialEquity) + suffix));
  lines.push(row('final equity', money(metrics.finalEquity) + suffix));
  lines.push(row('net profit', money(metrics.netProfit) + suffix));
  lines.push(row('total return', percent(metrics.totalReturn)));
  lines.push(row('CAGR', percent(metrics.cagr)));
  lines.push('');

  lines.push('Risk');
  lines.push(row('volatility', percent(metrics.volatility)));
  lines.push(row('Sharpe', decimal(metrics.sharpe)));
  lines.push(row('Sortino', decimal(metrics.sortino)));
  lines.push(row('Calmar', decimal(metrics.calmar)));
  lines.push(
    row(
      'max drawdown',
      `${percent(metrics.maxDrawdown)} (${money(metrics.maxDrawdownMoney)}${suffix}, ${String(
        metrics.maxDrawdownEpisode?.bars ?? 0,
      )} bars)`,
    ),
  );
  lines.push(row('longest drawdown', `${String(metrics.longestDrawdownBars)} bars`));
  lines.push(row('recovery factor', decimal(metrics.recoveryFactor)));
  lines.push('');

  lines.push('Trades');
  lines.push(
    row(
      'count',
      `${String(metrics.trades)} (${String(metrics.wins)}W / ${String(metrics.losses)}L)`,
    ),
  );
  lines.push(row('win rate', percent(metrics.winRate, 1)));
  lines.push(row('profit factor', decimal(metrics.profitFactor)));
  lines.push(row('expectancy', money(metrics.expectancy) + suffix));
  lines.push(row('average win', money(metrics.avgWin) + suffix));
  lines.push(row('average loss', money(metrics.avgLoss) + suffix));
  lines.push(row('largest win', money(metrics.largestWin) + suffix));
  lines.push(row('largest loss', money(metrics.largestLoss) + suffix));
  lines.push(row('average bars held', decimal(metrics.avgBarsHeld, 1)));
  lines.push(row('exposure', percent(metrics.exposure, 1)));
  lines.push('');

  lines.push('Costs');
  lines.push(row('commission', money(metrics.commissionPaid) + suffix));
  lines.push(row('PnL before costs', money(metrics.preCostPnl) + suffix));
  lines.push(row('costs ate', percent(metrics.commissionShareOfGross, 1)));
  if (metrics.unitsTraded > 0) {
    lines.push(row('charged per unit', money(metrics.commissionPerUnit) + suffix));
    // The figure that does not depend on knowing the real tariff: compare it against what the
    // broker charges and the answer is immediate.
    lines.push(
      row(
        'break-even per unit',
        metrics.breakEvenCommissionPerUnit === null
          ? 'n/a — it lost before commission'
          : money(metrics.breakEvenCommissionPerUnit) + suffix,
      ),
    );
  }

  return lines.join('\n');
}
