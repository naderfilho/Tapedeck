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

/**
 * The demo lets a visitor pick an instrument, so the fixtures cover more than one.
 *
 * These five are liquid enough over the whole window that the tape has no gaps to explain, and
 * they differ enough in price and lot size to be worth switching between: a strategy that looks
 * like an edge on one of them rarely survives the next. `BTCUSDT` stays first because it is the
 * one the README, the example and every test already talk about.
 */
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'] as const;

/** The CSV sample exists for the CSV provider's tests, which only ever read this one. */
const CSV_SAMPLE_FOR = 'BTCUSDT';

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

async function fetchOne(provider: BinanceDataProvider, symbol: string): Promise<void> {
  const instrument = await provider.describe(symbol);
  console.log(
    `${symbol}: priceExp=${String(instrument.priceExp)} qtyExp=${String(instrument.qtyExp)} ` +
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

  const tapePath = `${fixtures}binance-${symbol}-1h.tape`;
  const bytes = encodeBarTape({
    instrument,
    chunk: bars,
    source: `binance:${symbol}:1h:${toIso(FROM)}..${toIso(TO)}`,
    createdBy: 'tapedeck/scripts/fetch-fixtures',
  });
  writeFileSync(tapePath, bytes);

  console.log(`  ${String(bars.count)} bars`);
  console.log(
    `  ${toIso((bars.openTs[0] ?? 0) as never)} .. ${toIso((bars.closeTs[bars.count - 1] ?? 0) as never)}`,
  );
  console.log(`  ${tapePath}  ${(bytes.byteLength / 1024).toFixed(0)} KiB`);

  if (symbol === CSV_SAMPLE_FOR) {
    const csvPath = `${fixtures}binance-${symbol}-1h-sample.csv`;
    writeFileSync(
      csvPath,
      toCsv(bars, instrument.priceExp, instrument.qtyExp, SAMPLE_ROWS),
      'utf8',
    );
    console.log(`  ${csvPath}  first ${String(SAMPLE_ROWS)} bars, for the CSV provider`);
  }
}

async function main(): Promise<void> {
  // One provider for all of them: it carries the request delay, and hammering the venue with five
  // concurrent paginations is how a fixture script earns a rate-limit ban.
  const provider = new BinanceDataProvider({ requestDelayMs: 400 });
  mkdirSync(fixtures, { recursive: true });

  for (const symbol of SYMBOLS) {
    await fetchOne(provider, symbol);
    console.log('');
  }
}

await main();
