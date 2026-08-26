import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MICROS_PER_DAY, MICROS_PER_HOUR } from '@tapedeck/core';
import { analyseDrawdown, computeMetrics, inferPeriodsPerYear } from '../src/index.ts';
import { MONEY, makeResult, trade } from './helpers.ts';

describe('inferPeriodsPerYear', () => {
  it('recognises common bar sizes from the curve itself', () => {
    const hourly = new Float64Array([0, MICROS_PER_HOUR, 2 * MICROS_PER_HOUR, 3 * MICROS_PER_HOUR]);
    const daily = new Float64Array([0, MICROS_PER_DAY, 2 * MICROS_PER_DAY, 3 * MICROS_PER_DAY]);
    expect(inferPeriodsPerYear(hourly, 4)).toBeCloseTo(8766, 0);
    expect(inferPeriodsPerYear(daily, 4)).toBeCloseTo(365.25, 2);
  });

  it('uses the median so a market that closes overnight is not defined by its gaps', () => {
    // Twenty-three hourly bars and one weekend-sized hole: the mean would say four-hour bars.
    const ts = new Float64Array(25);
    for (let i = 0; i < 24; i++) ts[i] = i * MICROS_PER_HOUR;
    ts[24] = 24 * MICROS_PER_HOUR + 3 * MICROS_PER_DAY;
    expect(inferPeriodsPerYear(ts, 25)).toBeCloseTo(8766, 0);
  });

  it('reports zero when there is not enough curve to measure', () => {
    expect(inferPeriodsPerYear(new Float64Array([1, 2]), 2)).toBe(0);
  });
});

describe('refusing to annualise what the run cannot support', () => {
  /** Daily bars, so a given number of points is a given number of days. */
  const daily = (count: number, step = 1.001): number[] =>
    Array.from({ length: count }, (_, i) => 100 * step ** i);

  it('withholds CAGR and Calmar from a window too short to extrapolate', () => {
    // Nineteen seconds of a paper session, which is what produced the -92% CAGR this rule exists
    // for. The window is real; the year it would be stretched into is not.
    const metrics = computeMetrics(makeResult({ equity: [100, 99.9, 99.8], spacing: 6_000_000 }));

    expect(metrics.cagr).toBeNull();
    expect(metrics.calmar).toBeNull();
    // What was actually observed is untouched.
    expect(metrics.totalReturn).toBeCloseTo(-0.002, 6);
    expect(metrics.maxDrawdown).toBeGreaterThan(0);
    expect(metrics.warnings.some((w) => w.includes('compound annual figure'))).toBe(true);
  });

  it('withholds Sharpe, Sortino and volatility from a sample too small to measure dispersion', () => {
    // A year and a half of monthly-sized steps: long enough for CAGR, far too few observations for
    // a dispersion scaled by the square root of a year.
    const metrics = computeMetrics(
      makeResult({ equity: daily(18, 1.01), spacing: MICROS_PER_DAY * 30 }),
    );

    expect(metrics.cagr).not.toBeNull();
    expect(metrics.sharpe).toBeNull();
    expect(metrics.sortino).toBeNull();
    expect(metrics.volatility).toBeNull();
    expect(metrics.downsideVolatility).toBeNull();
    expect(metrics.warnings.some((w) => w.includes('annualised dispersion'))).toBe(true);
  });

  it('reports both once the run is long enough and dense enough', () => {
    const metrics = computeMetrics(makeResult({ equity: daily(120), spacing: MICROS_PER_DAY }));

    expect(metrics.cagr).not.toBeNull();
    expect(metrics.sharpe).not.toBeNull();
    expect(metrics.volatility).not.toBeNull();
    expect(metrics.warnings).toHaveLength(0);
  });

  it('holds the two rules apart: a long window with two points still states its annual return', () => {
    // The count of observations is not what CAGR needs. Two points a year apart are an exact
    // annual return, and withholding it would be as wrong as extrapolating from nineteen seconds.
    const metrics = computeMetrics(
      makeResult({ equity: [100, 150], spacing: 365.25 * MICROS_PER_DAY }),
    );

    expect(metrics.cagr).toBeCloseTo(0.5, 6);
    expect(metrics.sharpe).toBeNull();
  });

  it('says what it withheld and that the observed figures are unaffected', () => {
    const metrics = computeMetrics(makeResult({ equity: [100, 101], spacing: MICROS_PER_HOUR }));
    const notes = metrics.warnings.join(' ');

    expect(notes).toContain('CAGR');
    expect(notes).toContain('Sharpe');
    expect(notes).toContain('describe the window as it was observed');
  });
});

describe('drawdown analysis', () => {
  const ts = (n: number): Float64Array =>
    Float64Array.from({ length: n }, (_, i) => (i + 1) * MICROS_PER_HOUR);

  it('measures depth against the peak that preceded it', () => {
    const equity = Float64Array.from([100, 110, 105, 130].map((v) => v * MONEY));
    const analysis = analyseDrawdown(ts(4), equity, 4);

    expect(analysis.maxDepth).toBeCloseTo(5 / 110, 12);
    expect(analysis.maxDepthMoney).toBe(5 * MONEY);
    expect(analysis.worst?.bars).toBe(2);
    expect(analysis.worst?.recoveredTs).toBe(4 * MICROS_PER_HOUR);
  });

  it('reports a drawdown that never recovered as unrecovered', () => {
    const equity = Float64Array.from([100, 90].map((v) => v * MONEY));
    const analysis = analyseDrawdown(ts(2), equity, 2);

    expect(analysis.maxDepth).toBeCloseTo(0.1, 12);
    expect(analysis.worst?.recoveredTs).toBeNull();
  });

  it('separates the deepest drawdown from the longest one', () => {
    // A fast 20% fall, then a shallow decline that grinds on for far longer.
    const path = [100, 80, 100, 99, 98, 97, 96, 95, 96, 97, 98, 99, 101];
    const analysis = analyseDrawdown(
      ts(path.length),
      Float64Array.from(path.map((v) => v * MONEY)),
      path.length,
    );

    expect(analysis.worst?.depth).toBeCloseTo(0.2, 12);
    expect(analysis.worst?.bars).toBe(2);
    expect(analysis.longestBars).toBe(10);
  });

  it('records nothing under water while equity keeps making highs', () => {
    const equity = Float64Array.from([1, 2, 3, 4].map((v) => v * MONEY));
    const analysis = analyseDrawdown(ts(4), equity, 4);
    expect(analysis.maxDepth).toBe(0);
    expect(analysis.episodes).toHaveLength(0);
    expect(Array.from(analysis.underwater)).toEqual([0, 0, 0, 0]);
  });

  it('never reports a depth outside zero and one', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 2, maxLength: 300 }),
        (values) => {
          const analysis = analyseDrawdown(
            ts(values.length),
            Float64Array.from(values),
            values.length,
          );
          expect(analysis.maxDepth).toBeGreaterThanOrEqual(0);
          expect(analysis.maxDepth).toBeLessThanOrEqual(1);
          for (const episode of analysis.episodes) {
            expect(episode.depth).toBeGreaterThanOrEqual(0);
            expect(episode.depth).toBeLessThanOrEqual(1);
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe('returns and ratios', () => {
  it('computes total return and CAGR from the ends of the curve', () => {
    const days = 365.25;
    const result = makeResult({ equity: [100, 150], spacing: days * MICROS_PER_DAY });
    const metrics = computeMetrics(result);

    expect(metrics.totalReturn).toBeCloseTo(0.5, 12);
    // One year exactly, so CAGR is the total return.
    expect(metrics.cagr).toBeCloseTo(0.5, 6);
  });

  it('reports a positive Sharpe for a curve that only goes up', () => {
    const equity = Array.from({ length: 60 }, (_, i) => 100 * 1.01 ** i);
    const metrics = computeMetrics(makeResult({ equity }));
    expect(metrics.sharpe ?? 0).toBeGreaterThan(0);
    // Constant compounding has no dispersion, so volatility collapses and Sharpe is enormous.
    expect(metrics.volatility ?? 1).toBeLessThan(1e-6);
  });

  it('penalises downside only, so Sortino exceeds Sharpe on a curve with upside spikes', () => {
    const equity = [100];
    for (let i = 0; i < 60; i++) equity.push((equity[i] ?? 100) * (i % 5 === 0 ? 1.05 : 0.999));
    const metrics = computeMetrics(makeResult({ equity }));
    expect(metrics.sortino ?? 0).toBeGreaterThan(metrics.sharpe ?? 0);
  });

  it('subtracts the risk-free rate before judging the excess', () => {
    const equity = Array.from({ length: 400 }, (_, i) => 100 * 1.0005 ** i);
    const base = computeMetrics(makeResult({ equity, spacing: MICROS_PER_DAY }));
    const withRate = computeMetrics(makeResult({ equity, spacing: MICROS_PER_DAY }), {
      riskFreeRate: 0.2,
    });
    expect(withRate.sharpe ?? 0).toBeLessThan(base.sharpe ?? 0);
  });

  it('honours an explicit periods-per-year over the inferred one', () => {
    const equity = Array.from({ length: 100 }, (_, i) => 100 + i);
    const inferred = computeMetrics(makeResult({ equity }));
    const explicit = computeMetrics(makeResult({ equity }), { periodsPerYear: 252 });
    expect(explicit.periodsPerYear).toBe(252);
    expect(explicit.sharpe).not.toBe(inferred.sharpe);
  });
});

describe('trade statistics', () => {
  const trades = [trade(1, 10), trade(2, -4), trade(3, 6), trade(4, -2, 3)];

  it('splits wins from losses and reports the ratio between them', () => {
    const metrics = computeMetrics(makeResult({ equity: [100, 110], trades }));

    expect(metrics.trades).toBe(4);
    expect(metrics.wins).toBe(2);
    expect(metrics.losses).toBe(2);
    expect(metrics.winRate).toBeCloseTo(0.5, 12);
    expect(metrics.grossProfit).toBe(16 * MONEY);
    expect(metrics.grossLoss).toBe(6 * MONEY);
    expect(metrics.profitFactor).toBeCloseTo(16 / 6, 12);
    expect(metrics.expectancy).toBe(2.5 * MONEY);
    expect(metrics.avgWin).toBe(8 * MONEY);
    expect(metrics.avgLoss).toBe(3 * MONEY);
    expect(metrics.largestWin).toBe(10 * MONEY);
    expect(metrics.largestLoss).toBe(4 * MONEY);
  });

  it('measures exposure as the share of bars spent holding something', () => {
    // Six bars held across four trades, on a two-bar curve of stats.bars = 12.
    const equity = Array.from({ length: 12 }, () => 100);
    const metrics = computeMetrics(makeResult({ equity, trades }));
    expect(metrics.avgBarsHeld).toBeCloseTo(1.5, 12);
    expect(metrics.exposure).toBeCloseTo(6 / 12, 12);
  });
});

describe('numbers that do not exist report null', () => {
  it('has no profit factor when nothing was lost', () => {
    const metrics = computeMetrics(makeResult({ equity: [100, 120], trades: [trade(1, 20)] }));
    expect(metrics.profitFactor).toBeNull();
  });

  it('has no win rate, expectancy or exposure without trades', () => {
    const metrics = computeMetrics(makeResult({ equity: [100, 100] }));
    expect(metrics.winRate).toBeNull();
    expect(metrics.expectancy).toBe(0);
    expect(metrics.avgBarsHeld).toBe(0);
  });

  it('has no Sharpe from a single point and no CAGR from a zero-length run', () => {
    const single = computeMetrics(makeResult({ equity: [100] }));
    expect(single.sharpe).toBeNull();
    expect(single.cagr).toBeNull();
    expect(single.maxDrawdown).toBe(0);
  });

  it('has no Calmar when equity never fell', () => {
    const metrics = computeMetrics(makeResult({ equity: [100, 110, 120] }));
    expect(metrics.maxDrawdown).toBe(0);
    expect(metrics.calmar).toBeNull();
    expect(metrics.recoveryFactor).toBeNull();
  });

  it('survives an empty run without inventing anything', () => {
    const metrics = computeMetrics(makeResult({ equity: [] }));
    expect(metrics.bars).toBe(0);
    expect(metrics.startTs).toBeNull();
    expect(metrics.sharpe).toBeNull();
    expect(metrics.maxDrawdown).toBe(0);
  });
});

describe('modelling caveats', () => {
  it('carries the run warnings and ambiguity count into the metrics', () => {
    const metrics = computeMetrics(
      makeResult({
        equity: [100, 105],
        warnings: ['3 bar(s) could have filled more than one resting order.'],
        ambiguousBars: 3,
      }),
    );
    expect(metrics.ambiguousBars).toBe(3);
    // Carried through, not replaced: the metrics add their own notes about what they withheld.
    expect(metrics.warnings).toContain('3 bar(s) could have filled more than one resting order.');
  });

  it('reports what costs took out of the gross result', () => {
    const metrics = computeMetrics(
      makeResult({ equity: [100, 108], trades: [trade(1, 10), trade(2, -2)], commission: 4 }),
    );
    // Gross result is 8; four of commission is half of it.
    expect(metrics.commissionShareOfGross).toBeCloseTo(0.5, 12);
  });
});
