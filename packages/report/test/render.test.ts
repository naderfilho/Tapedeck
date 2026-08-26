import { describe, expect, it } from 'vitest';
import {
  computeMetrics,
  formatMetrics,
  metricsToJson,
  metricsToJsonString,
  renderHtmlReport,
  roundSignificant,
} from '../src/index.ts';
import { makeResult, trade } from './helpers.ts';

const RESULT = makeResult({
  equity: [100, 110, 96, 105, 130],
  trades: [trade(1, 12), trade(2, -5), trade(3, 8, 4)],
  commission: 3,
  warnings: ['2 bar(s) could have filled more than one resting order.'],
  ambiguousBars: 2,
});
const METRICS = computeMetrics(RESULT);

describe('roundSignificant', () => {
  it('keeps twelve significant digits by default', () => {
    expect(roundSignificant(1 / 3)).toBe(0.333333333333);
    expect(roundSignificant(2 / 3)).toBe(0.666666666667);
  });

  it('passes null through and never produces negative zero', () => {
    expect(roundSignificant(null)).toBeNull();
    expect(roundSignificant(Number.NaN)).toBeNull();
    expect(roundSignificant(Number.POSITIVE_INFINITY)).toBeNull();
    // Negative zero would serialise as "-0" and break byte-identical JSON.
    expect(Object.is(roundSignificant(-0), 0)).toBe(true);
  });

  it('is what makes two runs produce identical JSON despite Math.pow', () => {
    // The last bit of pow is not specified across V8 versions; twelve digits is far inside that.
    const perturbed = METRICS.cagr === null ? null : METRICS.cagr * (1 + Number.EPSILON);
    expect(roundSignificant(perturbed)).toBe(roundSignificant(METRICS.cagr));
  });
});

describe('metrics as JSON', () => {
  const json = metricsToJson(METRICS);

  it('reports money as exact decimal strings, never as floats', () => {
    expect(json.equity.initial).toBe('100.00000000');
    expect(json.equity.netProfit).toBe('30.00000000');
    expect(json.trades.grossProfit).toBe('20.00000000');
    expect(json.costs.commissionPaid).toBe('3.00000000');
  });

  it('groups the numbers the way a reader asks for them', () => {
    expect(Object.keys(json)).toEqual(['period', 'equity', 'risk', 'trades', 'costs', 'modelling']);
    expect(json.trades.count).toBe(3);
    expect(json.risk.maxDrawdown).toBeCloseTo(14 / 110, 10);
    expect(json.modelling.ambiguousBars).toBe(2);
    expect(json.modelling.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it('serialises identically twice, which is the point of the rounding', () => {
    expect(metricsToJsonString(METRICS)).toBe(metricsToJsonString(computeMetrics(RESULT)));
  });

  it('describes an unrecovered drawdown as unrecovered', () => {
    const falling = metricsToJson(computeMetrics(makeResult({ equity: [100, 90, 85] })));
    expect(falling.risk.maxDrawdownRecovered).toBeNull();
    expect(falling.risk.maxDrawdownStart).not.toBeNull();
  });
});

describe('metrics as text', () => {
  const text = formatMetrics(METRICS, 'USDT');

  it('puts the caveats above the numbers they qualify', () => {
    const caveatAt = text.indexOf('Modelling caveats');
    const resultAt = text.indexOf('Result');
    expect(caveatAt).toBeGreaterThanOrEqual(0);
    expect(caveatAt).toBeLessThan(resultAt);
  });

  it('shows every section a reader expects', () => {
    for (const heading of ['Period', 'Result', 'Risk', 'Trades', 'Costs']) {
      expect(text).toContain(heading);
    }
    expect(text).toContain('USDT');
  });

  it('writes n/a rather than a number for what could not be computed', () => {
    const flat = formatMetrics(computeMetrics(makeResult({ equity: [100, 100] })));
    expect(flat).toContain('n/a');
  });
});

describe('the HTML report', () => {
  const html = renderHtmlReport(RESULT, METRICS, { currency: 'USDT' });

  it('is a complete, self-contained document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    expect(html).toContain('<style>');
  });

  it('has no scripts and reaches for nothing off the machine', () => {
    // A report should still open in five years, from a USB stick, with no network.
    expect(html).not.toContain('<script');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
    expect(html).not.toContain('src=');
  });

  it('leads with what the run could not know', () => {
    const caveatAt = html.indexOf('What this run could not know');
    const resultAt = html.indexOf('>Result<');
    expect(caveatAt).toBeGreaterThanOrEqual(0);
    expect(caveatAt).toBeLessThan(resultAt);
    expect(html).toContain('more than one resting order');
  });

  it('draws every chart', () => {
    expect(html).toContain('aria-label="Equity curve"');
    expect(html).toContain('aria-label="Drawdown"');
    expect(html).toContain('aria-label="Trade distribution"');
    expect(html.match(/<path/g)?.length ?? 0).toBeGreaterThan(2);
  });

  it('lists the trades with their fees', () => {
    expect(html.match(/<tr class="(win|loss)">/g)).toHaveLength(3);
    expect(html).toContain('<th>Fees</th>');
  });

  it('names the execution models the run actually used', () => {
    expect(html).toContain('Intrabar policy');
    expect(html).toContain('pessimistic');
  });

  it('escapes anything that came from outside', () => {
    const hostile = makeResult({
      equity: [100, 101],
      warnings: ['<img src=x onerror="alert(1)">'],
    });
    const rendered = renderHtmlReport(hostile, computeMetrics(hostile));
    expect(rendered).toContain('&lt;img src=x');
    expect(rendered).not.toContain('<img src=x');
  });

  it('renders a run with no trades and no equity without falling over', () => {
    const empty = makeResult({ equity: [] });
    const rendered = renderHtmlReport(empty, computeMetrics(empty));
    expect(rendered).toContain('No equity curve was recorded.');
    expect(rendered).toContain('No closed trades to plot.');
  });

  it('abbreviates large axis labels instead of printing every digit', () => {
    const thousands = makeResult({ equity: [50_000, 60_000, 55_000] });
    expect(renderHtmlReport(thousands, computeMetrics(thousands))).toContain('k<');

    const millions = makeResult({ equity: [5_000_000, 6_000_000, 5_500_000] });
    expect(renderHtmlReport(millions, computeMetrics(millions))).toContain('M<');
  });

  it('shades no drawdown span on a curve that never fell', () => {
    const rising = makeResult({ equity: [100, 110, 120] });
    const rendered = renderHtmlReport(rising, computeMetrics(rising));
    expect(rendered).toContain('aria-label="Equity curve"');
    // The class exists in the stylesheet either way; what matters is that no rect uses it.
    expect(rendered).not.toContain('<rect class="drawdown-span"');
  });

  it('marks a losing run without pretending otherwise', () => {
    const losing = makeResult({ equity: [100, 80], trades: [trade(1, -20)] });
    const rendered = renderHtmlReport(losing, computeMetrics(losing));
    expect(rendered).toContain('card bad');
    expect(rendered).toContain('<tr class="loss">');
  });

  it('truncates a very long trade table and says that it did', () => {
    const many = makeResult({
      equity: [100, 120],
      trades: Array.from({ length: 40 }, (_, i) => trade(i + 1, i % 2 === 0 ? 5 : -3)),
    });
    const rendered = renderHtmlReport(many, computeMetrics(many), { maxTradeRows: 10 });
    expect(rendered).toContain('Showing the first 10 of 40 trades.');
  });
});
