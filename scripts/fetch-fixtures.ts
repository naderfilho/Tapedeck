/**
 * Regenerates the committed market-data fixtures.
 *
 * ```sh
 * pnpm fixtures
 * ```
 *
 * The range is a pair of fixed dates rather than "the last year", so running this in six months
 * produces the same file. A fixture that drifts with the wall clock is not a fixture.
 *
 * Binance spot data is public and redistributable, which is why the repository can ship it. B3
 * data is neither, which is why the B3 examples will always point at a file you fetched yourself.
 *
 * This script uses `@tapedeck/data` rather than a bespoke downloader: if the provider cannot build
 * the fixtures, the provider is broken.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type BarChunk,
  BarChunkBuilder,
  MICROS_PER_HOUR,
  asDuration,
  formatFixed,
  fromIso,
  toIso,
} from '@tapedeck/core';
import { BinanceDataProvider, encodeBarTape } from '@tapedeck/data';

const SYMBOL = 'BTCUSDT';
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

async function main(): Promise<void> {
  const provider = new BinanceDataProvider({ requestDelayMs: 400 });
  const instrument = await provider.describe(SYMBOL);
  console.log(
    `${SYMBOL}: priceExp=${String(instrument.priceExp)} qtyExp=${String(instrument.qtyExp)} ` +
      `tick=${instrument.tickSize} lot=${instrument.lotSize}`,
  );

  const builder = new BarChunkBuilder(0 as never, TIMEFRAME, 16_384);
  let pages = 0;
  for await (const chunk of provider.bars({
    symbol: SYMBOL,
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
  if (bars.count === 0) throw new Error('the venue returned no candles for the requested range');

  mkdirSync(fixtures, { recursive: true });
  const tapePath = `${fixtures}binance-${SYMBOL}-1h.tape`;
  const bytes = encodeBarTape({
    instrument,
    chunk: bars,
    source: `binance:${SYMBOL}:1h:${toIso(FROM)}..${toIso(TO)}`,
    createdBy: 'tapedeck/scripts/fetch-fixtures',
  });
  writeFileSync(tapePath, bytes);

  const csvPath = `${fixtures}binance-${SYMBOL}-1h-sample.csv`;
  writeFileSync(csvPath, toCsv(bars, instrument.priceExp, instrument.qtyExp, SAMPLE_ROWS), 'utf8');

  console.log(`\n${String(bars.count)} bars written`);
  console.log(
    `  ${toIso((bars.openTs[0] ?? 0) as never)} .. ${toIso((bars.closeTs[bars.count - 1] ?? 0) as never)}`,
  );
  console.log(`  ${tapePath}  ${(bytes.byteLength / 1024).toFixed(0)} KiB`);
  console.log(`  ${csvPath}  first ${String(SAMPLE_ROWS)} bars, for the CSV provider`);
}

await main();
