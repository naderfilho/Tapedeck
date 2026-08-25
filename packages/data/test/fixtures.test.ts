/**
 * The committed fixtures are real Binance data, and these tests treat them as data rather than as
 * decoration: if the file in the repository is corrupt, truncated or out of order, the suite says
 * so. Everything downstream — the example, the benchmark, the report — is only as trustworthy as
 * this file.
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  MICROS_PER_HOUR,
  formatFixed,
  fromIso,
  resolveInstrument,
  toIso,
  validateBarChunk,
} from '@tapedeck/core';
import type { InstrumentId } from '@tapedeck/core';
import { readBarTapeFileSync } from '../src/index.ts';

const TAPE = fileURLToPath(new URL('../../../fixtures/binance-BTCUSDT-1h.tape', import.meta.url));

describe('the BTCUSDT fixture', () => {
  const file = readBarTapeFileSync(TAPE);

  it('declares the instrument it was fetched for', () => {
    expect(file.instrument.symbol).toBe('BTCUSDT');
    expect(file.instrument.venue).toBe('BINANCE');
    expect(file.instrument.priceExp).toBe(2);
    expect(file.instrument.qtyExp).toBe(5);
    expect(file.header.source).toContain('binance:BTCUSDT:1h');
  });

  it('covers a full year of hourly candles with no gaps', () => {
    expect(file.chunk.count).toBe(8_760);
    expect(file.chunk.openTs[0]).toBe(fromIso('2025-08-01T00:00:00.000Z'));
    expect(file.chunk.closeTs[file.chunk.count - 1]).toBe(fromIso('2026-08-01T00:00:00.000Z'));

    for (let i = 1; i < file.chunk.count; i++) {
      // Each bar starts exactly where the previous one ended: no missing hour, no duplicate.
      expect(file.chunk.openTs[i]).toBe(file.chunk.closeTs[i - 1]);
      expect((file.chunk.closeTs[i] ?? 0) - (file.chunk.openTs[i] ?? 0)).toBe(MICROS_PER_HOUR);
    }
  });

  it('passes the same validation the engine applies to any incoming chunk', () => {
    expect(() => {
      validateBarChunk(file.chunk);
    }).not.toThrow();
  });

  it('holds prices at a plausible scale for the period', () => {
    const instrument = resolveInstrument(file.instrument, 0 as InstrumentId);
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < file.chunk.count; i++) {
      low = Math.min(low, file.chunk.low[i] ?? 0);
      high = Math.max(high, file.chunk.high[i] ?? 0);
    }
    // Sanity, not a forecast: BTC traded somewhere between ten thousand and a million dollars.
    expect(low).toBeGreaterThan(1_000_00);
    expect(high).toBeLessThan(1_000_000_00);
    expect(low % instrument.tickSize).toBe(0);
    expect(formatFixed(low, 2)).toMatch(/^\d+\.\d{2}$/);
  });

  it('is readable as a sequence of instants, not just numbers', () => {
    expect(toIso((file.chunk.openTs[0] ?? 0) as never)).toBe('2025-08-01T00:00:00.000Z');
  });
});
