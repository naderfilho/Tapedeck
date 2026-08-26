/**
 * Performance metrics.
 *
 * Every ratio here has more than one definition in circulation, and a number whose definition is
 * unstated is a number nobody can check. So each one says which convention it follows, and the
 * ones that cannot be computed report `null` rather than `Infinity`, `NaN` or a comforting zero.
 *
 * ## Where the float boundary sits
 *
 * Money stays in fixed point: net profit, gross profit, drawdown depth and expectancy are exact
 * integers, straight from the ledger. Ratios are `float64`, because a Sharpe ratio is not money.
 * CAGR and Sortino use `Math.pow` and `Math.sqrt`, and `pow` is not specified to the last bit
 * across V8 versions — which is why ADR-0006 compares derived metrics at a documented tolerance
 * while comparing the trade list and equity curve byte for byte.
 */

import {
  type MoneyInt,
  type RunResult,
  type Timestamp,
  type TradeRecord,
  MICROS_PER_DAY,
  asMoney,
  asTimestamp,
} from '@tapedeck/core';

const MICROS_PER_YEAR = 365.25 * MICROS_PER_DAY;

export interface MetricsOptions {
  /** Annual risk-free rate as a decimal, e.g. `0.05`. Defaults to zero. */
  readonly riskFreeRate?: number | undefined;
  /**
   * Overrides the inferred number of bars per year. Inference uses the median spacing of the
   * equity curve, which is right for a continuous market and wrong for one that closes overnight
   * — pass this explicitly for B3.
   */
  readonly periodsPerYear?: number | undefined;
  /**
   * Decimals carried by a quantity, so per-unit costs are reported per contract or per share
   * rather than per fixed-point integer. Defaults to 0, which is right for futures.
   */
  readonly qtyExp?: number | undefined;
}

export interface DrawdownEpisode {
  readonly peakTs: Timestamp;
  readonly troughTs: Timestamp;
  /** Null when the run ended before equity recovered its previous peak. */
  readonly recoveredTs: Timestamp | null;
  /** Fraction of the peak that was given back, between 0 and 1. */
  readonly depth: number;
  readonly depthMoney: MoneyInt;
  readonly bars: number;
}

export interface Metrics {
  readonly startTs: Timestamp | null;
  readonly endTs: Timestamp | null;
  readonly days: number;
  readonly bars: number;
  /** Bars per year, inferred from the equity curve unless overridden. */
  readonly periodsPerYear: number;

  readonly initialEquity: MoneyInt;
  readonly finalEquity: MoneyInt;
  readonly netProfit: MoneyInt;
  readonly totalReturn: number;
  /** Compound annual growth rate. Null when the run is too short or equity went non-positive. */
  readonly cagr: number | null;

  /** Annualised standard deviation of per-bar returns, sample convention. */
  readonly volatility: number | null;
  /** Annualised downside deviation below the target return, divided by *all* periods. */
  readonly downsideVolatility: number | null;
  readonly sharpe: number | null;
  readonly sortino: number | null;
  /** CAGR divided by max drawdown. Null when there was no drawdown to divide by. */
  readonly calmar: number | null;

  readonly maxDrawdown: number;
  readonly maxDrawdownMoney: MoneyInt;
  readonly maxDrawdownEpisode: DrawdownEpisode | null;
  /** Longest time under water, which is often a different episode from the deepest one. */
  readonly longestDrawdownBars: number;
  readonly recoveryFactor: number | null;

  readonly trades: number;
  readonly wins: number;
  readonly losses: number;
  readonly winRate: number | null;
  /** Gross profit over gross loss. Null when nothing lost, because a ratio to zero is not a number. */
  readonly profitFactor: number | null;
  /** Average net PnL per trade, in money. */
  readonly expectancy: MoneyInt;
  /**
   * Sum of the winning trades and of the losing ones, both measured **after commission** — the
   * same measure the trades were classified by. A trade that made money before fees and lost
   * after is a loss here, because that is what it was.
   */
  readonly grossProfit: MoneyInt;
  readonly grossLoss: MoneyInt;
  /** Total trade PnL *before* commission. The denominator for judging what costs took. */
  readonly preCostPnl: MoneyInt;
  readonly avgWin: MoneyInt;
  readonly avgLoss: MoneyInt;
  readonly largestWin: MoneyInt;
  readonly largestLoss: MoneyInt;
  readonly avgBarsHeld: number;
  /** Share of bars spent holding a position. Above 1 when several positions overlap. */
  readonly exposure: number;

  readonly commissionPaid: MoneyInt;
  /** What costs took out of the pre-cost result. Null when there was no pre-cost result. */
  readonly commissionShareOfGross: number | null;
  /**
   * Total quantity across every fill, both sides, in the instrument's own units.
   *
   * A plain number and not a `QtyInt`: forty contracts is forty, but forty fills of a hundredth of
   * a bitcoin is 0.4, and a fixed-point quantity cannot hold that. This is a figure for a reader,
   * not a value for the ledger.
   */
  readonly unitsTraded: number;
  /** Commission actually charged, per unit traded. */
  readonly commissionPerUnit: MoneyInt;
  /**
   * The per-unit commission at which this run's net profit would be exactly zero.
   *
   * The most useful cost number when the real tariff is not known, because it does not depend on
   * knowing it: compare it against what your broker charges and the answer is immediate. Null when
   * the strategy lost money before commission, in which case no tariff makes it work.
   *
   * It holds the fills fixed. Charging a different commission changes equity, and a strategy that
   * sizes off equity would have traded differently — exact for one that does not, an approximation
   * for one that does. Slippage is not in it either: that is already inside the fill prices.
   */
  readonly breakEvenCommissionPerUnit: MoneyInt | null;

  /** Carried through from the run so a reader sees them next to the numbers they qualify. */
  readonly ambiguousBars: number;
  readonly subBarLatencyIgnored: number;
  readonly warnings: readonly string[];
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

/**
 * Bars per year, from the median spacing between equity points.
 *
 * The median rather than the mean because a market that closes has one enormous gap per session
 * and a mean would let those gaps decide the answer.
 */
export function inferPeriodsPerYear(ts: Float64Array, length: number): number {
  if (length < 3) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < length; i++) gaps.push((ts[i] ?? 0) - (ts[i - 1] ?? 0));
  const spacing = median(gaps);
  return spacing > 0 ? MICROS_PER_YEAR / spacing : 0;
}

/** Per-bar simple returns. Stops at the first non-positive equity, which has no return. */
function returnsOf(equity: Float64Array, length: number): number[] {
  const returns: number[] = [];
  for (let i = 1; i < length; i++) {
    const previous = equity[i - 1] ?? 0;
    if (previous <= 0) break;
    returns.push((equity[i] ?? 0) / previous - 1);
  }
  return returns;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** Sample standard deviation, two-pass so it does not cancel. */
function stdDev(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const average = mean(values);
  let sum = 0;
  for (const value of values) {
    const deviation = value - average;
    sum += deviation * deviation;
  }
  return Math.sqrt(sum / (values.length - 1));
}

/**
 * Downside deviation below `target`.
 *
 * Divided by the number of *all* periods, not just the losing ones. That is Sortino's own
 * definition, and the other convention — dividing by the count of downside periods — produces a
 * ratio that looks better the fewer losses a strategy has, which is backwards.
 */
function downsideDeviation(values: readonly number[], target: number): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) {
    const shortfall = Math.min(0, value - target);
    sum += shortfall * shortfall;
  }
  return Math.sqrt(sum / values.length);
}

export interface DrawdownAnalysis {
  readonly maxDepth: number;
  readonly maxDepthMoney: MoneyInt;
  readonly worst: DrawdownEpisode | null;
  readonly longestBars: number;
  readonly episodes: readonly DrawdownEpisode[];
  /** Fraction of the peak given back at each bar, for the underwater chart. */
  readonly underwater: Float64Array;
}

/**
 * Walks the equity curve once, recording every episode between a peak and its recovery.
 *
 * The deepest drawdown and the longest one are reported separately because they are usually
 * different episodes, and a strategy that recovers 20% in a week is not the same animal as one
 * that recovers 8% over a year.
 */
export function analyseDrawdown(
  ts: Float64Array,
  equity: Float64Array,
  length: number,
): DrawdownAnalysis {
  const underwater = new Float64Array(length);
  const episodes: DrawdownEpisode[] = [];

  let peak = length > 0 ? (equity[0] ?? 0) : 0;
  let peakIndex = 0;
  let troughIndex = 0;
  let trough = peak;
  let inDrawdown = false;
  let maxDepth = 0;
  let maxDepthMoney = 0;
  let worst: DrawdownEpisode | null = null;
  let longestBars = 0;

  const close = (recoveredIndex: number | null, endIndex: number): void => {
    if (!inDrawdown) return;
    const depthMoney = peak - trough;
    const depth = peak > 0 ? depthMoney / peak : 0;
    const bars = endIndex - peakIndex;
    const episode: DrawdownEpisode = {
      peakTs: asTimestamp(ts[peakIndex] ?? 0),
      troughTs: asTimestamp(ts[troughIndex] ?? 0),
      recoveredTs: recoveredIndex === null ? null : asTimestamp(ts[recoveredIndex] ?? 0),
      depth,
      depthMoney: asMoney(depthMoney),
      bars,
    };
    episodes.push(episode);
    if (depth > maxDepth) {
      maxDepth = depth;
      maxDepthMoney = depthMoney;
      worst = episode;
    }
    if (bars > longestBars) longestBars = bars;
    inDrawdown = false;
  };

  for (let i = 0; i < length; i++) {
    const value = equity[i] ?? 0;
    if (value >= peak) {
      close(i, i);
      peak = value;
      peakIndex = i;
      trough = value;
      troughIndex = i;
      underwater[i] = 0;
      continue;
    }
    inDrawdown = true;
    if (value < trough) {
      trough = value;
      troughIndex = i;
    }
    underwater[i] = peak > 0 ? (peak - value) / peak : 0;
  }
  // A drawdown still open when the data ends never recovered; say so rather than pretending.
  close(null, length - 1);

  return {
    maxDepth,
    maxDepthMoney: asMoney(maxDepthMoney),
    worst,
    longestBars,
    episodes,
    underwater,
  };
}

interface TradeStats {
  readonly wins: number;
  readonly losses: number;
  readonly grossProfit: number;
  readonly grossLoss: number;
  readonly largestWin: number;
  readonly largestLoss: number;
  readonly netProfit: number;
  readonly preCostPnl: number;
  readonly barsHeld: number;
}

function summariseTrades(trades: readonly TradeRecord[]): TradeStats {
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let largestWin = 0;
  let largestLoss = 0;
  let netProfit = 0;
  let preCostPnl = 0;
  let barsHeld = 0;

  for (const trade of trades) {
    const pnl: number = trade.netPnl;
    netProfit += pnl;
    preCostPnl += trade.grossPnl;
    barsHeld += trade.barsHeld;
    if (pnl > 0) {
      wins++;
      grossProfit += pnl;
      if (pnl > largestWin) largestWin = pnl;
    } else if (pnl < 0) {
      losses++;
      grossLoss += -pnl;
      if (-pnl > largestLoss) largestLoss = -pnl;
    }
  }

  return {
    wins,
    losses,
    grossProfit,
    grossLoss,
    largestWin,
    largestLoss,
    netProfit,
    preCostPnl,
    barsHeld,
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * The two things an annualised figure needs, and they are not the same thing.
 *
 * The first real paper session this repository ran printed a **CAGR of -92%** from nineteen seconds
 * of wall clock. That is not a wrong calculation; it is an answer to a question the run could not
 * be asked. But the two families of annualised metric fail for different reasons, so they are held
 * to different rules rather than to one convenient one:
 *
 * - **CAGR, and Calmar through it, need a span.** They raise a total return to the power of
 *   `1 / years`, so a short window is extrapolated by however many of it fit in a year — 19 seconds
 *   is a factor of 1.6 million. A run covering a whole year needs only two points to state its
 *   annual return exactly, so the count of observations is not what matters here.
 * - **Sharpe, Sortino and volatility need observations.** They scale a sample's dispersion by
 *   `sqrt(periodsPerYear)`, and a dozen returns do not measure dispersion no matter how long they
 *   are spread over.
 *
 * Thirty of each is a convention rather than a theorem, which is why both are named, exported and
 * stated in the run's warnings when they bite. Everything that describes the window as observed —
 * net profit, total return, drawdown, the trade statistics — is untouched (ADR-0019).
 */
export const MIN_PERIODS_TO_ANNUALISE = 30;
export const MIN_DAYS_TO_ANNUALISE = 30;

/**
 * What was withheld and why, in the same voice the engine uses for everything else it could not do.
 *
 * These go into the metrics' own warnings, which every surface prints above the numbers, so a
 * reader meets the reason before meeting the `n/a`.
 */
function annualisationNotes(
  spanMicros: number,
  spanSupportsAnnual: boolean,
  periods: number,
  sampleSupportsAnnual: boolean,
): string[] {
  const notes: string[] = [];
  if (!spanSupportsAnnual) {
    const days = spanMicros / MICROS_PER_DAY;
    notes.push(
      `the run covers ${days < 1 ? `${(days * 24 * 60).toFixed(1)} minute(s)` : `${days.toFixed(1)} day(s)`}, ` +
        `under the ${String(MIN_DAYS_TO_ANNUALISE)} days a compound annual figure needs: CAGR and ` +
        'Calmar are reported as null rather than extrapolated from it.',
    );
  }
  if (!sampleSupportsAnnual) {
    notes.push(
      `the run has ${String(periods)} return period(s), under the ` +
        `${String(MIN_PERIODS_TO_ANNUALISE)} an annualised dispersion needs: Sharpe, Sortino and ` +
        'volatility are reported as null rather than scaled up from a sample that small.',
    );
  }
  if (notes.length > 0) {
    notes.push(
      'Net profit, total return, drawdown and the trade statistics are unaffected: they describe ' +
        'the window as it was observed.',
    );
  }
  return notes;
}

export function computeMetrics(result: RunResult, options: MetricsOptions = {}): Metrics {
  const { equityCurve, trades, stats } = result;
  const length = equityCurve.length;
  // Every fill, both sides: commission is charged on entries and exits alike. When a run was
  // configured not to record fills there is nothing to count, and the per-unit figures below say
  // so by being zero and null rather than by guessing from the trade list.
  let filledQty = 0;
  for (const fill of result.fills) filledQty += fill.qty;
  const unitsTraded = filledQty / 10 ** (options.qtyExp ?? 0);
  const initialEquity = result.initialCash;
  const finalEquity = result.finalEquity;
  const netProfit = asMoney(finalEquity - initialEquity);

  const periodsPerYear = options.periodsPerYear ?? inferPeriodsPerYear(equityCurve.ts, length);
  const spanMicros =
    result.startTs === null || result.endTs === null ? 0 : result.endTs - result.startTs;
  const years = spanMicros / MICROS_PER_YEAR;

  const totalReturn = initialEquity === 0 ? 0 : netProfit / initialEquity;
  // A window shorter than this is extrapolated to a year by a factor large enough to make the
  // result about the arithmetic rather than about the strategy.
  const spanSupportsAnnual = spanMicros >= MIN_DAYS_TO_ANNUALISE * MICROS_PER_DAY;
  const cagr =
    spanSupportsAnnual && years > 0 && initialEquity > 0 && finalEquity > 0
      ? Math.pow(finalEquity / initialEquity, 1 / years) - 1
      : null;

  const returns = returnsOf(equityCurve.equity, length);
  const riskFree = options.riskFreeRate ?? 0;
  const perPeriodRiskFree = periodsPerYear > 0 ? Math.pow(1 + riskFree, 1 / periodsPerYear) - 1 : 0;
  const excess = returns.map((value) => value - perPeriodRiskFree);

  // The three dispersion metrics are withheld together, so a reader never sees a Sharpe beside a
  // missing volatility and has to guess which one to believe.
  const sampleSupportsAnnual = returns.length >= MIN_PERIODS_TO_ANNUALISE;

  const sigma = stdDev(excess);
  const downside = downsideDeviation(excess, 0);
  const annualise = Math.sqrt(periodsPerYear);
  const volatility = !sampleSupportsAnnual || sigma === null ? null : sigma * annualise;
  const downsideVolatility =
    !sampleSupportsAnnual || downside === null ? null : downside * annualise;
  const averageExcess = mean(excess);
  const sharpe =
    !sampleSupportsAnnual || sigma === null || sigma === 0
      ? null
      : (averageExcess / sigma) * annualise;
  const sortino =
    !sampleSupportsAnnual || downside === null || downside === 0
      ? null
      : (averageExcess / downside) * annualise;

  const drawdown = analyseDrawdown(equityCurve.ts, equityCurve.equity, length);
  const calmar = cagr === null ? null : ratio(cagr, drawdown.maxDepth);
  const recoveryFactor = ratio(netProfit, drawdown.maxDepthMoney);

  const trade = summariseTrades(trades);
  const tradeCount = trades.length;

  return {
    startTs: result.startTs,
    endTs: result.endTs,
    days: spanMicros / MICROS_PER_DAY,
    bars: stats.bars,
    periodsPerYear,

    initialEquity,
    finalEquity,
    netProfit,
    totalReturn,
    cagr,

    volatility,
    downsideVolatility,
    sharpe,
    sortino,
    calmar,

    maxDrawdown: drawdown.maxDepth,
    maxDrawdownMoney: drawdown.maxDepthMoney,
    maxDrawdownEpisode: drawdown.worst,
    longestDrawdownBars: drawdown.longestBars,
    recoveryFactor,

    trades: tradeCount,
    wins: trade.wins,
    losses: trade.losses,
    winRate: ratio(trade.wins, tradeCount),
    profitFactor: ratio(trade.grossProfit, trade.grossLoss),
    expectancy: asMoney(tradeCount === 0 ? 0 : Math.round(trade.netProfit / tradeCount)),
    grossProfit: asMoney(trade.grossProfit),
    grossLoss: asMoney(trade.grossLoss),
    preCostPnl: asMoney(trade.preCostPnl),
    avgWin: asMoney(trade.wins === 0 ? 0 : Math.round(trade.grossProfit / trade.wins)),
    avgLoss: asMoney(trade.losses === 0 ? 0 : Math.round(trade.grossLoss / trade.losses)),
    largestWin: asMoney(trade.largestWin),
    largestLoss: asMoney(trade.largestLoss),
    avgBarsHeld: tradeCount === 0 ? 0 : trade.barsHeld / tradeCount,
    exposure: stats.bars === 0 ? 0 : trade.barsHeld / stats.bars,

    commissionPaid: result.commissionPaid,
    // Against the pre-cost result: dividing by the *net* result would say costs were 260% of a
    // number costs had already been subtracted from.
    commissionShareOfGross: ratio(result.commissionPaid, Math.abs(trade.preCostPnl)),
    unitsTraded,
    commissionPerUnit: asMoney(
      unitsTraded === 0 ? 0 : Math.round(result.commissionPaid / unitsTraded),
    ),
    breakEvenCommissionPerUnit:
      unitsTraded === 0 || trade.preCostPnl <= 0
        ? null
        : asMoney(Math.floor(trade.preCostPnl / unitsTraded)),

    ambiguousBars: stats.ambiguousBars,
    subBarLatencyIgnored: stats.subBarLatencyIgnored,
    warnings: [
      ...result.warnings,
      ...annualisationNotes(spanMicros, spanSupportsAnnual, returns.length, sampleSupportsAnnual),
    ],
  };
}
