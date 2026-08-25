import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  ConfigError,
  MICROS_PER_DAY,
  MICROS_PER_MINUTE,
  asDuration,
  asTimestamp,
  formatTimeframe,
  fromIso,
  fromMillis,
  fromSeconds,
  parseTimeframe,
  toIso,
  toMillis,
  utcDayIndex,
} from '@tapedeck/core';

describe('microsecond timestamps', () => {
  it('converts between milliseconds, seconds and microseconds', () => {
    expect(fromMillis(1_500)).toBe(1_500_000);
    expect(toMillis(asTimestamp(1_500_999))).toBe(1_500);
    expect(fromSeconds(2)).toBe(2_000_000);
  });

  it('round-trips ISO-8601 at millisecond precision', () => {
    const iso = '2026-08-25T12:34:56.789Z';
    expect(toIso(fromIso(iso))).toBe(iso);
  });

  it('rejects an unparseable instant instead of producing NaN time', () => {
    expect(() => fromIso('not-a-date')).toThrow(ConfigError);
  });

  it('keeps microsecond resolution that milliseconds would collapse', () => {
    // Two prints 300 microseconds apart are distinct events on the B3 tape. Rounding them to
    // milliseconds would give them the same timestamp and destroy the total ordering.
    const a = asTimestamp(1_700_000_000_000_100);
    const b = asTimestamp(1_700_000_000_000_400);
    expect(a).not.toBe(b);
    expect(toMillis(a)).toBe(toMillis(b));
  });

  it('stays inside the safe-integer range for any realistic date', () => {
    // Year 2100 in microseconds is still two orders of magnitude below 2^53.
    expect(Number.isSafeInteger(fromIso('2100-01-01T00:00:00.000Z'))).toBe(true);
  });
});

describe('utcDayIndex', () => {
  it('changes exactly at UTC midnight', () => {
    const midnight = fromIso('2026-08-25T00:00:00.000Z');
    expect(utcDayIndex(midnight)).toBe(utcDayIndex(asTimestamp(midnight + MICROS_PER_DAY - 1)));
    expect(utcDayIndex(asTimestamp(midnight + MICROS_PER_DAY))).toBe(utcDayIndex(midnight) + 1);
  });
});

describe('timeframes', () => {
  it('parses the notations a data provider uses', () => {
    expect(parseTimeframe('1m')).toBe(MICROS_PER_MINUTE);
    expect(parseTimeframe('15m')).toBe(15 * MICROS_PER_MINUTE);
    expect(parseTimeframe('4h')).toBe(4 * 60 * MICROS_PER_MINUTE);
    expect(parseTimeframe('1d')).toBe(MICROS_PER_DAY);
    expect(parseTimeframe('500ms')).toBe(500_000);
  });

  it('rejects anything it cannot represent exactly', () => {
    for (const bad of ['', '1', 'm', '0m', '1w', '1.5h', '-1m']) {
      expect(() => parseTimeframe(bad)).toThrow(ConfigError);
    }
  });

  it('round-trips through formatTimeframe', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('1ms', '250ms', '1s', '30s', '1m', '5m', '1h', '4h', '1d'),
        (text) => {
          expect(parseTimeframe(formatTimeframe(parseTimeframe(text)))).toBe(parseTimeframe(text));
        },
      ),
    );
  });

  it('falls back to raw microseconds for a duration no suffix fits', () => {
    expect(formatTimeframe(asDuration(7))).toBe('7us');
  });
});
