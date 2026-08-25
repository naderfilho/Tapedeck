/**
 * The trading calendar.
 *
 * Two kinds of assertion here. The date arithmetic is checked as *properties* — round-tripping,
 * monotonicity, agreement with the platform's own `Date` — because a hand-picked date proves
 * nothing about the one that will break it. The B3 rules are checked against specific dates,
 * because a calendar's whole job is to be right about specific dates.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  type CalendarSpec,
  ALWAYS_OPEN,
  B3,
  ConfigError,
  MICROS_PER_DAY,
  TradingCalendar,
  asTimestamp,
  civilFromDays,
  daysFromCivil,
  easterSunday,
  fromIso,
  weekdayOf,
} from '@tapedeck/core';

const b3 = new TradingCalendar(B3);

/** A local B3 wall-clock time, as the UTC instant it corresponds to. */
function brt(date: string, hour = 12, minute = 0): ReturnType<typeof asTimestamp> {
  return fromIso(
    `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00-03:00`,
  );
}

describe('civil date arithmetic', () => {
  it('round-trips every date the engine can represent', () => {
    fc.assert(
      fc.property(fc.integer({ min: -25_000, max: 90_000 }), (days) => {
        const { year, month, day } = civilFromDays(days);
        expect(daysFromCivil(year, month, day)).toBe(days);
        expect(month).toBeGreaterThanOrEqual(1);
        expect(month).toBeLessThanOrEqual(12);
        expect(day).toBeGreaterThanOrEqual(1);
        expect(day).toBeLessThanOrEqual(31);
      }),
      { numRuns: 500 },
    );
  });

  it('agrees with the platform, which is the only reference that matters', () => {
    fc.assert(
      fc.property(fc.integer({ min: -20_000, max: 60_000 }), (days) => {
        const expected = new Date(days * 86_400_000);
        const { year, month, day } = civilFromDays(days);
        expect(year).toBe(expected.getUTCFullYear());
        expect(month).toBe(expected.getUTCMonth() + 1);
        expect(day).toBe(expected.getUTCDate());
        expect(weekdayOf(days)).toBe(expected.getUTCDay());
      }),
      { numRuns: 500 },
    );
  });

  it('knows the epoch was a Thursday', () => {
    expect(daysFromCivil(1970, 1, 1)).toBe(0);
    expect(weekdayOf(0)).toBe(4);
  });

  it('puts Easter where the church does', () => {
    // Four B3 holidays hang off these dates, so a wrong Easter is four wrong market days a year.
    const expected: Readonly<Record<number, string>> = {
      2021: '2021-04-04',
      2022: '2022-04-17',
      2023: '2023-04-09',
      2024: '2024-03-31',
      2025: '2025-04-20',
      2026: '2026-04-05',
      2027: '2027-03-28',
    };
    for (const [year, date] of Object.entries(expected)) {
      const { year: y, month, day } = civilFromDays(easterSunday(Number(year)));
      const iso = `${String(y)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      expect(iso).toBe(date);
    }
  });

  it('always lands Easter on a Sunday, for any year', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1900, max: 2200 }), (year) => {
        expect(weekdayOf(easterSunday(year))).toBe(0);
      }),
      { numRuns: 300 },
    );
  });
});

describe('B3 trading days', () => {
  it('trades on an ordinary Wednesday', () => {
    expect(b3.isTradingDay(brt('2025-06-11'))).toBe(true);
  });

  it('does not trade at the weekend', () => {
    expect(b3.isTradingDay(brt('2025-06-14'))).toBe(false);
    expect(b3.isTradingDay(brt('2025-06-15'))).toBe(false);
  });

  it('observes the fixed national holidays', () => {
    for (const date of [
      '2025-01-01',
      '2025-04-21',
      '2025-05-01',
      '2025-09-07',
      '2025-11-02',
      '2025-11-15',
      '2025-11-20',
      '2025-12-25',
    ]) {
      expect(b3.isTradingDay(brt(date))).toBe(false);
    }
  });

  it('closes on the 24th and the 31st of December, which are not holidays', () => {
    // Neither is a legal holiday in Brazil and B3 trades on neither. A calendar built only from
    // the statute book would have the market open on both.
    expect(b3.isTradingDay(brt('2025-12-24'))).toBe(false);
    expect(b3.isTradingDay(brt('2025-12-31'))).toBe(false);
  });

  it('observes the four holidays that move with Easter', () => {
    // Easter 2025 was 20 April: Carnival 3-4 March, Good Friday 18 April, Corpus Christi 19 June.
    for (const date of ['2025-03-03', '2025-03-04', '2025-04-18', '2025-06-19']) {
      expect(b3.isTradingDay(brt(date))).toBe(false);
    }
    // And they move: Easter 2024 was 31 March, so Carnival was in February.
    for (const date of ['2024-02-12', '2024-02-13', '2024-03-29', '2024-05-30']) {
      expect(b3.isTradingDay(brt(date))).toBe(false);
    }
    expect(b3.isTradingDay(brt('2024-03-04'))).toBe(true);
  });

  it('counts trading days rather than calendar days', () => {
    // June 2025: 30 calendar days, four full weekends, and Corpus Christi on the 19th.
    const from = brt('2025-06-01', 0);
    const to = brt('2025-07-01', 0);
    expect(b3.tradingDaysBetween(from, to)).toBe(20);
    expect((to - from) / MICROS_PER_DAY).toBe(30);
  });

  it('counts nothing for an empty or backwards range', () => {
    expect(b3.tradingDaysBetween(brt('2025-06-11'), brt('2025-06-11'))).toBe(0);
    expect(b3.tradingDaysBetween(brt('2025-06-11'), brt('2025-06-01'))).toBe(0);
  });
});

describe('B3 session hours', () => {
  it('opens at 09:00 and closes at 18:00 local, whatever that is in UTC', () => {
    expect(b3.isOpen(brt('2025-06-11', 8, 59))).toBe(false);
    expect(b3.isOpen(brt('2025-06-11', 9, 0))).toBe(true);
    expect(b3.isOpen(brt('2025-06-11', 17, 59))).toBe(true);
    // Half-open, like every other interval in this engine.
    expect(b3.isOpen(brt('2025-06-11', 18, 0))).toBe(false);
  });

  it('reports the session it is inside', () => {
    const session = b3.sessionAt(brt('2025-06-11', 14, 30));
    expect(session?.name).toBe('regular');
    expect(session?.open).toBe(brt('2025-06-11', 9, 0));
    expect(session?.close).toBe(brt('2025-06-11', 18, 0));
    expect(b3.sessionAt(brt('2025-06-11', 20, 0))).toBeNull();
  });

  it('is shut all day on a holiday, at every hour', () => {
    for (let hour = 0; hour < 24; hour++) {
      expect(b3.isOpen(brt('2025-04-21', hour))).toBe(false);
    }
  });

  it('puts a Monday-morning instant in the local day São Paulo is in, not the one UTC is in', () => {
    // 01:00 UTC on Tuesday is 22:00 Monday in São Paulo. A `day` order submitted then belongs to
    // Monday's session, and keying it off the UTC day would kill it a session early.
    const lateMonday = fromIso('2025-06-10T01:00:00Z');
    expect(b3.localDayIndex(lateMonday)).toBe(daysFromCivil(2025, 6, 9));
    expect(Math.floor(lateMonday / MICROS_PER_DAY)).toBe(daysFromCivil(2025, 6, 10));
  });
});

describe('when the venue next opens and shuts', () => {
  it('gives the current session close while the market is running', () => {
    expect(b3.nextClose(brt('2025-06-11', 10, 0))).toBe(brt('2025-06-11', 18, 0));
  });

  it('steps over a weekend', () => {
    // Friday evening: the next close is Monday's.
    expect(b3.nextClose(brt('2025-06-13', 19, 0))).toBe(brt('2025-06-16', 18, 0));
    expect(b3.nextOpen(brt('2025-06-13', 19, 0))).toBe(brt('2025-06-16', 9, 0));
  });

  it('steps over a holiday that touches a weekend', () => {
    // Carnival 2025 was Monday the 3rd and Tuesday the 4th of March; trading resumed Wednesday.
    expect(b3.nextOpen(brt('2025-02-28', 19, 0))).toBe(brt('2025-03-05', 9, 0));
  });

  it('returns the instant itself when the market is already open', () => {
    const noon = brt('2025-06-11', 12, 0);
    expect(b3.nextOpen(noon)).toBe(noon);
  });

  it('gives the coming open when the day is a trading day but the bell has not rung', () => {
    expect(b3.nextOpen(brt('2025-06-11', 7, 0))).toBe(brt('2025-06-11', 9, 0));
  });

  it('never goes backwards, for any instant', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: fromIso('2020-01-01T00:00:00Z'), max: fromIso('2035-01-01T00:00:00Z') }),
        (micros) => {
          const ts = asTimestamp(micros);
          expect(b3.nextOpen(ts)).toBeGreaterThanOrEqual(ts);
          expect(b3.nextClose(ts)).toBeGreaterThan(ts);
          // An open that is not now is an open on a day the venue actually trades.
          expect(b3.isOpen(b3.nextOpen(ts))).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('the limits it admits to', () => {
  it('refuses instants from before Brazil abolished daylight saving', () => {
    // In January 2019 São Paulo was UTC-2, not UTC-3. Answering anyway would put every session
    // boundary an hour out and nothing downstream would notice.
    expect(() => b3.isTradingDay(fromIso('2019-01-15T12:00:00Z'))).toThrow(ConfigError);
    expect(() => b3.isTradingDay(fromIso('2019-01-15T12:00:00Z'))).toThrow(/time-zone rules/);
    expect(b3.isTradingDay(fromIso('2020-01-15T12:00:00Z'))).toBe(true);
  });

  it('lets a caller replace the holiday table, because the shipped one is transcribed', () => {
    const withStateHoliday = new TradingCalendar({
      ...B3,
      fixedHolidays: [...B3.fixedHolidays, '07-09'],
    });
    expect(b3.isTradingDay(brt('2025-07-09'))).toBe(true);
    expect(withStateHoliday.isTradingDay(brt('2025-07-09'))).toBe(false);
  });

  it('takes dated exceptions, for a closure no rule predicts', () => {
    const calendar = new TradingCalendar({
      ...B3,
      specialDays: [
        { date: '2025-06-11', sessions: [], reason: 'unscheduled closure' },
        {
          date: '2025-06-12',
          sessions: [{ name: 'half-day', openMinute: 13 * 60, closeMinute: 18 * 60 }],
          reason: 'late open',
        },
      ],
    });
    expect(calendar.isTradingDay(brt('2025-06-11'))).toBe(false);
    expect(calendar.isOpen(brt('2025-06-12', 10, 0))).toBe(false);
    expect(calendar.isOpen(brt('2025-06-12', 14, 0))).toBe(true);
  });
});

describe('rejecting a calendar that cannot be right', () => {
  const cases: readonly (readonly [string, Partial<CalendarSpec>])[] = [
    ['no sessions at all', { sessions: [] }],
    [
      'a session that closes before it opens',
      { sessions: [{ name: 'x', openMinute: 600, closeMinute: 60 }] },
    ],
    [
      'a session running past midnight',
      { sessions: [{ name: 'x', openMinute: 600, closeMinute: 1_500 }] },
    ],
    [
      'a session on half a minute',
      { sessions: [{ name: 'x', openMinute: 0.5, closeMinute: 600 }] },
    ],
    ['a holiday that is not a date', { fixedHolidays: ['not-a-date'] }],
  ];

  for (const [description, override] of cases) {
    it(`refuses ${description}`, () => {
      expect(() => new TradingCalendar({ ...B3, ...override })).toThrow(ConfigError);
    });
  }
});

describe('the always-open calendar', () => {
  const crypto = new TradingCalendar(ALWAYS_OPEN);

  it('is open on Christmas morning and every other instant', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: fromIso('2040-01-01T00:00:00Z') }), (micros) => {
        expect(crypto.isOpen(asTimestamp(micros))).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('counts every calendar day as a trading day', () => {
    const from = fromIso('2025-06-01T00:00:00Z');
    const to = fromIso('2025-07-01T00:00:00Z');
    expect(crypto.tradingDaysBetween(from, to)).toBe(30);
  });

  it('closes at midnight, which is the next open', () => {
    const ts = fromIso('2025-06-11T12:00:00Z');
    expect(crypto.nextClose(ts)).toBe(fromIso('2025-06-12T00:00:00Z'));
    expect(crypto.nextOpen(ts)).toBe(ts);
  });
});
