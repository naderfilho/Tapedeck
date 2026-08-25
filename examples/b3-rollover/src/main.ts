/**
 * The B3 example: a year of mini-index futures, rolled, stitched and traded.
 *
 * It runs on **generated** data by default, and that needs saying in the first paragraph rather
 * than a footnote. B3's Consumption Policy permits internal use of its market data and requires
 * prior approval to redistribute it, so no B3 price can be committed to this repository
 * (ADR-0011, ADR-0015). Anyone who clones this gets a series produced by a seeded random walk.
 *
 * **So the PnL below means nothing.** A random walk has no edge to find and no edge to miss; the
 * first synthetic series ever written for this project handed a moving-average crossover a 96% win
 * rate. What this example demonstrates is the *mechanism*, and every part of that is real:
 *
 * - the contract expiries are B3's own rules, on B3's own calendar, with Carnival where Carnival is
 * - the roll is measured from the volume crossover, not assumed from a rule
 * - the continuous series is back-adjusted, and the adjustment is reported
 * - the costs are the tariffs B3 publishes, cited and dated
 * - the break-even commission is computed, and that number does not care whether the prices were
 *   real
 *
 * To run it on real prices, fetch them yourself — one command, and the data stays on your machine:
 *
 * ```bash
 * tapedeck data fetch --venue b3 --symbol WIN \
 *   --from 2025-08-01 --to 2026-08-01 --out data/win.tape
 * node examples/b3-rollover/src/main.ts --data data/win.tape
 * ```
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  type BarChunk,
  type Contract,
  type InstrumentId,
  B3,
  B3_TARIFFS,
  BarChunkBuilder,
  INSTRUMENTS,
  MICROS_PER_MINUTE,
  TradingCalendar,
  asDuration,
  asTimestamp,
  b3FuturesCommission,
  contractsBetween,
  createRng,
  fixedTicksSlippage,
  formatFixed,
  fromIso,
  runBacktest,
  toIso,
  uniformLatency,
  volumeParticipation,
} from '@tapedeck/core';
import { type ContractBars, stitchContinuous } from '@tapedeck/data';
import { computeMetrics, formatMetrics, renderHtmlReport } from '@tapedeck/report';
import { B3_SERIES } from '@tapedeck/core';
import b3Breakout, { DEFAULTS } from './strategy.ts';

const calendar = new TradingCalendar(B3);
const FROM = fromIso('2025-08-01T00:00:00Z');
const TO = fromIso('2026-08-01T00:00:00Z');
const TIMEFRAME = asDuration(15 * MICROS_PER_MINUTE);

/**
 * A seeded random walk shaped like a WIN contract.
 *
 * Bars only inside the session, so the calendar has something to be right about; a basis between
 * contracts, so the roll has a gap to adjust away; and volume that migrates from the front to the
 * back over several sessions, so the volume-triggered roll has something to detect.
 */
function generate(contract: Contract, index: number, seed: number): BarChunk {
  const rng = createRng(seed).fork(contract.symbol);
  const builder = new BarChunkBuilder(0 as InstrumentId, TIMEFRAME, 8_192);

  // Contracts further out trade above the front, which is what carry looks like on an index.
  const basis = index * 900;
  let price = 138_000 + basis;
  const start = Math.max(FROM, contract.expiry - 120 * 86_400_000_000);

  for (let at = start; at < contract.expiry; at += TIMEFRAME) {
    const ts = asTimestamp(at);
    if (!calendar.isOpen(ts)) continue;
    const drift = (rng.nextFloat() - 0.5) * 260;
    const open = price;
    price = Math.max(20_000, Math.round((price + drift) / 5) * 5);
    const high = Math.max(open, price) + Math.round(rng.nextFloat() * 12) * 5;
    const low = Math.min(open, price) - Math.round(rng.nextFloat() * 12) * 5;

    // Liquidity leaves a contract as it approaches expiry and arrives in the next one.
    const sessionsLeft = (contract.expiry - ts) / 86_400_000_000;
    const share = Math.max(0.02, Math.min(1, (sessionsLeft - 3) / 25));
    builder.push(ts, ts + TIMEFRAME, open, high, low, price, Math.round(30_000 * share) + 100);
  }
  return builder.build();
}

function bar(label: string, value: string): string {
  return `  ${label.padEnd(24)}${value}`;
}

const contracts = contractsBetween(B3_SERIES.WIN, calendar, FROM, TO);
const perContract: ContractBars[] = contracts.map((contract, index) => ({
  contract,
  chunk: generate(contract, index, 20_260_825),
}));

const series = stitchContinuous({ contracts: perContract, rollOn: 'volume' });

console.log('B3 mini index futures — WIN, rolled and stitched\n');
console.log('Contracts');
for (const contract of contracts) {
  console.log(bar(contract.symbol, `expires ${toIso(contract.expiry).slice(0, 10)}`));
}
console.log('\nRolls');
for (const roll of series.rolls) {
  console.log(
    bar(
      `${roll.from} -> ${roll.to}`,
      `${toIso(roll.ts).slice(0, 10)}  basis ${String(roll.gap)} points  (${roll.trigger})`,
    ),
  );
}

// Above the numbers, always.
if (series.warnings.length > 0) {
  console.log('\nWhat the stitch could not do');
  for (const warning of series.warnings) console.log(`  ! ${warning}`);
}

const commission = b3FuturesCommission({ tariff: B3_TARIFFS.WIN, dayTrade: true });
const result = runBacktest(
  {
    instruments: [INSTRUMENTS.WIN],
    strategy: b3Breakout,
    params: DEFAULTS,
    initialCash: '30000',
    seed: 20_260_825,
    calendar: B3,
    execution: {
      slippage: fixedTicksSlippage(1),
      commission,
      latency: uniformLatency(5_000, 25_000),
      liquidity: volumeParticipation(500),
      intrabar: 'pessimistic',
    },
    flattenAtEnd: true,
  },
  [series.chunk],
);

const metrics = computeMetrics(result, {
  // 252 sessions of 15-minute bars. Inferring this from bar spacing would annualise across the
  // overnight gap and report a volatility the instrument never had.
  periodsPerYear: 252 * 36,
});

console.log(`\nCosts charged: ${commission.name}\n`);
console.log(formatMetrics(metrics, 'BRL'));

const outDir = resolve(process.cwd(), 'out');
mkdirSync(dirname(`${outDir}/x`), { recursive: true });
writeFileSync(
  `${outDir}/b3-report.html`,
  renderHtmlReport(result, metrics, { currency: 'BRL' }),
  'utf8',
);
console.log(`\nreport  out/b3-report.html`);

const breakEven = metrics.breakEvenCommissionPerUnit;
console.log(`
────────────────────────────────────────────────────────────────────────────
These prices were GENERATED, not traded. A seeded random walk has no edge to
find, so the PnL above is noise with a Sharpe ratio attached. B3 market data
cannot be redistributed (ADR-0015), so this is what a clone can run.

What is real: the ${String(contracts.length)} contract expiries above come from B3's rules on B3's
calendar, the ${String(series.rolls.length)} rolls were measured from the volume crossover, and the
commission is B3's published tariff for WIN — ${B3_TARIFFS.WIN.unitCost} ${B3_TARIFFS.WIN.currency} per contract,
read from ${B3_TARIFFS.WIN.readOn}, less the day-trade reduction.

And this number does not care whether the prices were real:
  break-even commission  ${breakEven === null ? 'n/a — it lost before commission' : `${formatFixed(breakEven, 8)} BRL per contract`}
It is the cost at which this strategy stops making money. Compare it against
what your broker charges, on your own data, and you have an answer.
────────────────────────────────────────────────────────────────────────────`);
