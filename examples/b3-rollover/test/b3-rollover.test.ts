/**
 * The B3 example, as an invariant test.
 *
 * It asserts nothing about PnL. The prices are a seeded random walk, so a PnL assertion would be
 * pinning down noise, and the day someone changes the generator it would fail for no reason worth
 * knowing. What it pins down is the behaviour the example exists to demonstrate — the strategy is
 * flat overnight, the roll happens, the calendar is obeyed — because those hold for any prices.
 */

import { describe, expect, it } from 'vitest';
import {
  type BarChunk,
  type Contract,
  type InstrumentId,
  B3,
  B3_SERIES,
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
  fromIso,
  runBacktest,
} from '@tapedeck/core';
import { type ContractBars, stitchContinuous } from '@tapedeck/data';
import { computeMetrics } from '@tapedeck/report';
import b3Breakout, { DEFAULTS } from '../src/strategy.ts';

const calendar = new TradingCalendar(B3);
const FROM = fromIso('2025-08-01T00:00:00Z');
const TO = fromIso('2026-02-01T00:00:00Z');
const TIMEFRAME = asDuration(15 * MICROS_PER_MINUTE);

function generate(contract: Contract, index: number): BarChunk {
  const rng = createRng(20_260_825).fork(contract.symbol);
  const builder = new BarChunkBuilder(0 as InstrumentId, TIMEFRAME, 8_192);
  let price = 138_000 + index * 900;
  const start = Math.max(FROM, contract.expiry - 120 * 86_400_000_000);

  for (let at = start; at < contract.expiry; at += TIMEFRAME) {
    const ts = asTimestamp(at);
    if (!calendar.isOpen(ts)) continue;
    const open = price;
    price = Math.max(20_000, Math.round((price + (rng.nextFloat() - 0.5) * 260) / 5) * 5);
    const high = Math.max(open, price) + Math.round(rng.nextFloat() * 12) * 5;
    const low = Math.min(open, price) - Math.round(rng.nextFloat() * 12) * 5;
    const sessionsLeft = (contract.expiry - ts) / 86_400_000_000;
    const share = Math.max(0.02, Math.min(1, (sessionsLeft - 3) / 25));
    builder.push(ts, ts + TIMEFRAME, open, high, low, price, Math.round(30_000 * share) + 100);
  }
  return builder.build();
}

const contracts = contractsBetween(B3_SERIES.WIN, calendar, FROM, TO);
const perContract: ContractBars[] = contracts.map((contract, index) => ({
  contract,
  chunk: generate(contract, index),
}));
const series = stitchContinuous({ contracts: perContract, rollOn: 'volume' });

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
      commission: b3FuturesCommission({ tariff: B3_TARIFFS.WIN, dayTrade: true }),
      intrabar: 'pessimistic',
    },
    flattenAtEnd: true,
  },
  [series.chunk],
);

describe('the stitched series', () => {
  it('covers every contract that traded in the window', () => {
    expect(contracts.length).toBeGreaterThan(1);
    expect(series.rolls.length).toBe(contracts.length - 1);
  });

  it('rolled on measured volume, not on the rule', () => {
    for (const roll of series.rolls) expect(roll.trigger).toBe('volume');
  });

  it('has no bar outside a B3 session', () => {
    for (let i = 0; i < series.chunk.count; i++) {
      expect(calendar.isOpen(asTimestamp(series.chunk.openTs[i] ?? 0))).toBe(true);
    }
  });

  it('says that its prices never traded', () => {
    expect(series.warnings.join(' ')).toContain('never traded at the value shown');
  });
});

describe('the strategy', () => {
  it('trades often enough to be worth measuring', () => {
    // The first draft measured time-to-close from the bar's own close, which on the last bar of a
    // session answers with tomorrow's bell. It held one position for the whole run. This is the
    // regression test for that.
    expect(result.trades.length).toBeGreaterThan(20);
  });

  it('is flat overnight, on every session without exception', () => {
    // Walk the fills and check the position is zero at the end of each local day.
    let position = 0;
    let day = -1;
    let carried = 0;
    for (const fill of result.fills) {
      const fillDay = calendar.localDayIndex(fill.ts);
      if (day !== -1 && fillDay !== day && position !== 0) carried++;
      day = fillDay;
      position += fill.side === 'buy' ? fill.qty : -fill.qty;
    }
    expect(carried).toBe(0);
    expect(position).toBe(0);
  });

  it('never opens a position inside the no-entry window before the bell', () => {
    for (const signal of result.signals) {
      const untilClose = calendar.nextClose(signal.ts) - signal.ts;
      expect(untilClose).toBeGreaterThan(DEFAULTS.noEntryMinutes * MICROS_PER_MINUTE);
    }
  });

  it('reconciles, like every other run', () => {
    const identity =
      result.initialCash + result.realizedPnl + result.unrealizedPnl - result.commissionPaid;
    expect(result.finalEquity).toBe(identity);
  });

  it('reports a break-even commission, which is the number that survives synthetic prices', () => {
    const metrics = computeMetrics(result, { periodsPerYear: 252 * 36 });
    expect(metrics.unitsTraded).toBeGreaterThan(0);
    expect(metrics.commissionPerUnit).toBeGreaterThan(0);
  });
});
