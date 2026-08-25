/**
 * When a `day` order dies.
 *
 * Until the trading calendar existed this was "when the UTC calendar day changes", which is close
 * enough to right on an instrument that never closes and wrong twice over on one that does: it
 * kept a B3 order alive through the evening after the bell, and it killed an order submitted at
 * 21:00 UTC that São Paulo still considered the same session.
 *
 * The rule now is the venue's next session close, and these are the cases that distinguish it.
 */

import { describe, expect, it } from 'vitest';
import {
  type BarChunk,
  type CalendarSpec,
  type InstrumentId,
  type OrderCancelledEvent,
  ALWAYS_OPEN,
  B3,
  BarChunkBuilder,
  MICROS_PER_HOUR,
  TradingCalendar,
  asDuration,
  asPrice,
  asQty,
  fromIso,
} from '@tapedeck/core';
import { runScript } from './harness.ts';

const b3 = new TradingCalendar(B3);

/** Hourly bars from a given instant, flat at `price` so nothing fills by accident. */
function hourlyFrom(iso: string, count: number, price = 100): BarChunk {
  const start = fromIso(iso);
  const builder = new BarChunkBuilder(0 as InstrumentId, asDuration(MICROS_PER_HOUR), count);
  for (let i = 0; i < count; i++) {
    const openTs = start + i * MICROS_PER_HOUR;
    builder.push(openTs, openTs + MICROS_PER_HOUR, price, price, price, price, 1_000);
  }
  return builder.build();
}

/**
 * Runs a scripted day order over a chunk and reports the bar close at which it expired.
 *
 * The order is a limit far below the market, so nothing can fill it: the only way it leaves the
 * book is expiry, which is what is being measured.
 */
function expiryOf(chunk: BarChunk, calendar?: CalendarSpec): string | null {
  const expiries: OrderCancelledEvent[] = [];
  runScript({
    rows: [],
    chunkOverride: chunk,
    ...(calendar === undefined ? {} : { calendar }),
    onBar: (bar, ctx) => {
      if (bar.index !== 0) return;
      ctx.submit({
        instrumentId: bar.instrumentId,
        side: 'buy',
        type: 'limit',
        qty: asQty(1),
        limitPrice: asPrice(1),
        tif: 'day',
      });
    },
    onCancel: (event) => {
      if (event.reason === 'expired') expiries.push(event);
    },
  });
  const first = expiries[0];
  return first === undefined ? null : new Date(first.ts / 1_000).toISOString();
}

describe('a day order on a venue that closes', () => {
  it('dies at that afternoon’s close, not at midnight', () => {
    // Submitted on the 10:00 bar of a Wednesday. B3 shuts at 18:00 local, which is 21:00 UTC.
    const chunk = hourlyFrom('2025-06-11T13:00:00Z', 12);
    expect(expiryOf(chunk, B3)).toBe('2025-06-11T21:00:00.000Z');
  });

  it('survives every bar of the session it was placed in', () => {
    let seenWhileWorking = 0;
    runScript({
      rows: [],
      chunkOverride: hourlyFrom('2025-06-11T12:00:00Z', 8),
      calendar: B3,
      onBar: (bar, ctx) => {
        if (bar.index === 0) {
          ctx.submit({
            instrumentId: bar.instrumentId,
            side: 'buy',
            type: 'limit',
            qty: asQty(1),
            limitPrice: asPrice(1),
            tif: 'day',
          });
          return;
        }
        if (ctx.openOrders().length > 0) seenWhileWorking++;
      },
    });
    // 12:00Z is 09:00 in São Paulo; the session runs to 21:00Z, so the order should be alive on
    // every remaining bar of that day.
    expect(seenWhileWorking).toBeGreaterThan(4);
  });

  it('placed after the bell, dies at the next session’s close', () => {
    // 22:00 UTC on Wednesday is 19:00 in São Paulo: the market has shut. The order belongs to
    // Thursday's session and must not be killed the instant Thursday begins.
    const chunk = hourlyFrom('2025-06-11T22:00:00Z', 30);
    expect(expiryOf(chunk, B3)).toBe('2025-06-12T21:00:00.000Z');
  });

  it('placed on a Friday, dies on Friday and not over the weekend', () => {
    const chunk = hourlyFrom('2025-06-13T13:00:00Z', 12);
    expect(expiryOf(chunk, B3)).toBe('2025-06-13T21:00:00.000Z');
  });

  it('placed after Friday’s close, survives the weekend and dies on Monday', () => {
    // The old rule killed this at the first bar of Saturday, a day on which the venue was shut and
    // the order could not have been cancelled by anyone.
    const chunk = hourlyFrom('2025-06-13T22:00:00Z', 80);
    expect(expiryOf(chunk, B3)).toBe('2025-06-16T21:00:00.000Z');
  });

  it('steps over a holiday', () => {
    // Submitted after the close on the eve of Corpus Christi, 19 June 2025.
    const chunk = hourlyFrom('2025-06-18T22:00:00Z', 80);
    expect(expiryOf(chunk, B3)).toBe('2025-06-20T21:00:00.000Z');
  });
});

describe('a day order on a venue that never closes', () => {
  it('still dies at midnight UTC, exactly as it did before calendars existed', () => {
    const chunk = hourlyFrom('2025-06-11T13:00:00Z', 24);
    expect(expiryOf(chunk)).toBe('2025-06-12T00:00:00.000Z');
    expect(expiryOf(chunk, ALWAYS_OPEN)).toBe('2025-06-12T00:00:00.000Z');
  });
});

describe('what the calendar does not change', () => {
  it('leaves a gtc order alone forever', () => {
    const chunk = hourlyFrom('2025-06-11T13:00:00Z', 80);
    let expired = 0;
    runScript({
      rows: [],
      chunkOverride: chunk,
      calendar: B3,
      onBar: (bar, ctx) => {
        if (bar.index !== 0) return;
        ctx.submit({
          instrumentId: bar.instrumentId,
          side: 'buy',
          type: 'limit',
          qty: asQty(1),
          limitPrice: asPrice(1),
          tif: 'gtc',
        });
      },
      onCancel: (event) => {
        if (event.reason === 'expired') expired++;
      },
    });
    expect(expired).toBe(0);
  });

  it('hands the calendar to the strategy, so it can ask about the close itself', () => {
    const closes: string[] = [];
    runScript({
      rows: [],
      chunkOverride: hourlyFrom('2025-06-11T13:00:00Z', 3),
      calendar: B3,
      onBar: (bar, ctx) => {
        closes.push(new Date(ctx.calendar.nextClose(bar.closeTs) / 1_000).toISOString());
      },
    });
    expect(closes).toEqual([
      '2025-06-11T21:00:00.000Z',
      '2025-06-11T21:00:00.000Z',
      '2025-06-11T21:00:00.000Z',
    ]);
    expect(b3.isOpen(fromIso('2025-06-11T14:00:00Z'))).toBe(true);
  });
});
