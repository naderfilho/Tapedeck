/**
 * Regenerates the committed market-data fixtures.
 *
 * ```sh
 * corepack pnpm fixtures                       # every tape
 * corepack pnpm fixtures coinbase-BTC-USD      # or just the ones named
 * ```
 *
 * The range is a pair of fixed dates rather than "the last year", so running this in six months
 * produces the same file. A fixture that drifts with the wall clock is not a fixture.
 *
 * Binance and Coinbase both publish this data on unauthenticated endpoints, which is why the
 * repository can ship it. B3 data is neither free nor redistributable, which is why the B3 examples
 * will always point at a file you fetched yourself.
 *
 * This script uses the providers in `@tapedeck/data` rather than a bespoke downloader: if a
 * provider cannot build the fixtures, the provider is broken.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type BarChunk,
  type DataProvider,
  BarChunkBuilder,
  MICROS_PER_HOUR,
  asDuration,
  formatFixed,
  fromIso,
  toIso,
} from '@tapedeck/core';
import { BinanceDataProvider, CoinbaseDataProvider, encodeBarTape } from '@tapedeck/data';
import { TAPES } from '../demo/src/markets.ts';

/** The CSV sample exists for the CSV provider's tests, which only ever read this one. */
const CSV_SAMPLE_FOR = 'binance-BTCUSDT';

const FROM = fromIso('2025-08-01T00:00:00.000Z');
const TO = fromIso('2026-08-01T00:00:00.000Z');
const TIMEFRAME = asDuration(MICROS_PER_HOUR);
const SAMPLE_ROWS = 240;

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url));

function toCsv(chunk: BarChunk, priceExp: number, qtyExp: number, rows: number): string {
  const lines = ['timestamp,open,high,low,close,volume'];
  const count = Math.min(rows, chunk.count);
  for (let i = 0; i < count; i++) {
    lines.push(
      [
        toIso((chunk.openTs[i] ?? 0) as never),
        formatFixed(chunk.open[i] ?? 0, priceExp),
        formatFixed(chunk.high[i] ?? 0, priceExp),
        formatFixed(chunk.low[i] ?? 0, priceExp),
        formatFixed(chunk.close[i] ?? 0, priceExp),
        formatFixed(chunk.volume[i] ?? 0, qtyExp),
      ].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

async function fetchOne(provider: DataProvider, id: string, symbol: string): Promise<void> {
  const instrument = await provider.describe(symbol);
  console.log(
    `${id}: priceExp=${String(instrument.priceExp)} qtyExp=${String(instrument.qtyExp)} ` +
      `tick=${instrument.tickSize} lot=${instrument.lotSize}`,
  );

  const builder = new BarChunkBuilder(0 as never, TIMEFRAME, 16_384);
  let pages = 0;
  for await (const chunk of provider.bars({
    symbol,
    timeframe: TIMEFRAME,
    from: FROM,
    to: TO,
    chunkSize: 1_000,
  })) {
    pages++;
    builder.append(chunk);
    if (pages % 3 === 0) console.log(`  ${String(builder.count)} bars...`);
  }

  const bars = builder.build();
  if (bars.count === 0) {
    throw new Error(`the venue returned no candles for ${symbol} in the requested range`);
  }

  const tapePath = `${fixtures}${id}-1h.tape`;
  const bytes = encodeBarTape({
    instrument,
    chunk: bars,
    source: `${provider.id}:${symbol}:1h:${toIso(FROM)}..${toIso(TO)}`,
    createdBy: 'tapedeck/scripts/fetch-fixtures',
  });
  writeFileSync(tapePath, bytes);

  console.log(`  ${String(bars.count)} bars`);
  console.log(
    `  ${toIso((bars.openTs[0] ?? 0) as never)} .. ${toIso((bars.closeTs[bars.count - 1] ?? 0) as never)}`,
  );
  console.log(`  ${tapePath}  ${(bytes.byteLength / 1024).toFixed(0)} KiB`);

  if (id === CSV_SAMPLE_FOR) {
    const csvPath = `${fixtures}binance-BTCUSDT-1h-sample.csv`;
    writeFileSync(
      csvPath,
      toCsv(bars, instrument.priceExp, instrument.qtyExp, SAMPLE_ROWS),
      'utf8',
    );
    console.log(`  ${csvPath}  first ${String(SAMPLE_ROWS)} bars, for the CSV provider`);
  }
}

async function main(): Promise<void> {
  // One provider per venue for all of its symbols: each carries the request delay, and hammering
  // an exchange with concurrent paginations is how a fixture script earns a rate-limit ban.
  const providers: Record<string, DataProvider> = {
    binance: new BinanceDataProvider({ requestDelayMs: 400 }),
    coinbase: new CoinbaseDataProvider({ requestDelayMs: 200 }),
  };

  mkdirSync(fixtures, { recursive: true });

  const wanted = new Set(process.argv.slice(2));
  const selected = TAPES.filter((tape) => wanted.size === 0 || wanted.has(tape.id));
  if (selected.length === 0) {
    throw new Error(`nothing matched. Known tapes: ${TAPES.map((tape) => tape.id).join(', ')}`);
  }

  for (const tape of selected) {
    const provider = providers[tape.venue];
    if (provider === undefined) throw new Error(`no provider for ${tape.venue}`);
    await fetchOne(provider, tape.id, tape.symbol);
    console.log('');
  }
}

await main();
