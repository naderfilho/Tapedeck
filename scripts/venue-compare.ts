/**
 * The same strategy, the same year, the same asset — priced on two exchanges.
 *
 * ```sh
 * node scripts/venue-compare.ts
 * ```
 *
 * This exists because the landing page makes a claim about venues, and a claim about a number
 * belongs to the run that produced it. The figures it writes to `out/venues.json` are substituted
 * into the page at build time, so the page cannot go on saying something the engine has stopped
 * saying. It is the same discipline as `out/metrics.json`, applied to a second run.
 *
 * What it isolates: a 24/72 crossover over a year of hourly Bitcoin, sized identically in the quote
 * currency, once against Binance's published fee schedule and once against Coinbase Exchange's.
 * Everything the engine is given is the same except the tape and the fee table.
 *
 * What it does *not* isolate: the tapes are two different books. Coinbase quotes BTC against
 * dollars and Binance against a stablecoin, and the Coinbase year has ten fewer hours in it because
 * the venue printed nothing during two outages. So the gap is "fees, on top of a different market",
 * not "fees alone" — which is why the page says the first and not the second.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Engine, PRESETS, parseFixed } from '@tapedeck/core';
import { readBarTapeFileSync } from '@tapedeck/data';
import { computeMetrics } from '@tapedeck/report';
import { type SmaCrossoverParams, smaCrossover } from '../examples/sma-crossover/src/strategy.ts';

const OUT = fileURLToPath(new URL('../out/', import.meta.url));
const INITIAL_CASH = '100000';

/** Size in quote currency, so the two runs risk the same money rather than the same coins. */
const NOTIONAL = 25_000;

const VENUES = [
  { key: 'binance', tape: 'binance-BTCUSDT', preset: PRESETS.binanceSpot },
  { key: 'coinbase', tape: 'coinbase-BTC-USD', preset: PRESETS.coinbaseExchange },
] as const;

interface VenueResult {
  readonly venue: string;
  readonly symbol: string;
  readonly currency: string;
  readonly bars: number;
  readonly commissionModel: string;
  readonly netProfit: string;
  readonly totalReturn: number;
  readonly commissionPaid: string;
  readonly shareOfGross: number | null;
  readonly trades: number;
}

const MONEY = 100_000_000;
const money = (value: number): string => (value / MONEY).toFixed(2);

function runOne(venue: (typeof VENUES)[number]): VenueResult {
  const path = fileURLToPath(new URL(`../fixtures/${venue.tape}-1h.tape`, import.meta.url));
  const tape = readBarTapeFileSync(path);

  // The first close of each tape turns one money size into that venue's own quantity, which is the
  // only way "the same position" means anything across two instruments with different scales.
  const firstClose = (tape.chunk.close[0] ?? 0) / 10 ** tape.instrument.priceExp;
  const qty = Math.max(1, Math.round((NOTIONAL / firstClose) * 10 ** tape.instrument.qtyExp));

  const params: SmaCrossoverParams = {
    fastPeriod: 24,
    slowPeriod: 72,
    qty: parseFixed(String(qty / 10 ** tape.instrument.qtyExp), tape.instrument.qtyExp),
    allowShort: true,
  };

  const execution = venue.preset();
  const engine = new Engine<SmaCrossoverParams>({
    instruments: [tape.instrument],
    strategy: smaCrossover,
    params,
    initialCash: INITIAL_CASH,
    seed: 20260825,
    execution,
    flattenAtEnd: true,
  });

  engine.feedBars(tape.chunk);
  const metrics = computeMetrics(engine.finish());

  return {
    venue: tape.instrument.venue,
    symbol: tape.instrument.symbol,
    currency: tape.instrument.currency,
    bars: tape.chunk.count,
    commissionModel: execution.commission.name,
    netProfit: money(metrics.netProfit),
    totalReturn: metrics.totalReturn,
    commissionPaid: money(metrics.commissionPaid),
    shareOfGross: metrics.commissionShareOfGross,
    trades: metrics.trades,
  };
}

const results = Object.fromEntries(VENUES.map((venue) => [venue.key, runOne(venue)]));

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}venues.json`, `${JSON.stringify(results, null, 2)}\n`, 'utf8');

for (const result of Object.values(results)) {
  console.log(
    `${result.venue}:${result.symbol}  ${result.commissionModel}  ` +
      `net ${result.netProfit} ${result.currency}  fees ${result.commissionPaid}  ` +
      `${String(result.trades)} trades`,
  );
}
console.log('\nvenues out/venues.json');
