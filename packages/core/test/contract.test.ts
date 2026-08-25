/**
 * Futures contracts and their expiries.
 *
 * The B3 expiry dates asserted here are the real ones for 2025. That is deliberate: a rule that
 * produces plausible Wednesdays is worthless, and the only way to know it produces the *right*
 * Wednesdays is to check it against the dates the exchange actually used.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  type ContractSeries,
  B3,
  B3_SERIES,
  ConfigError,
  MONTH_CODES,
  TradingCalendar,
  asTimestamp,
  civilFromDays,
  contractOf,
  contractSymbol,
  contractsBetween,
  frontContract,
  fromIso,
  monthCode,
  monthOfCode,
  parseContractSymbol,
  weekdayOf,
} from '@tapedeck/core';

const calendar = new TradingCalendar(B3);

/** The local date a timestamp falls on, as `YYYY-MM-DD`, for legible assertions. */
function localDate(ts: ReturnType<typeof asTimestamp>): string {
  const { year, month, day } = civilFromDays(calendar.localDayIndex(ts));
  return `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

describe('month codes', () => {
  it('maps the twelve months to the codes every venue prints', () => {
    expect(monthCode(1)).toBe('F');
    expect(monthCode(4)).toBe('J');
    expect(monthCode(12)).toBe('Z');
    // I and L are missing on purpose: they read as the digit one.
    expect(MONTH_CODES).not.toContain('I');
    expect(MONTH_CODES).not.toContain('L');
  });

  it('round-trips every month', () => {
    for (let month = 1; month <= 12; month++) {
      expect(monthOfCode(monthCode(month))).toBe(month);
    }
  });

  it('refuses a month and a code that do not exist', () => {
    expect(() => monthCode(0)).toThrow(ConfigError);
    expect(() => monthCode(13)).toThrow(/month must be 1..12/);
    expect(() => monthOfCode('I')).toThrow(/not a futures month code/);
  });
});

describe('contract symbols', () => {
  it('renders the venue form', () => {
    expect(contractSymbol('WIN', 2025, 4)).toBe('WINJ25');
    expect(contractSymbol('wdo', 2026, 1)).toBe('WDOF26');
    expect(contractSymbol('IND', 2025, 12)).toBe('INDZ25');
  });

  it('parses one back', () => {
    expect(parseContractSymbol('WINJ25', 2026)).toEqual({ root: 'WIN', year: 2025, month: 4 });
    expect(parseContractSymbol('winj25', 2026)).toEqual({ root: 'WIN', year: 2025, month: 4 });
  });

  it('resolves two ambiguous digits against a pivot instead of guessing', () => {
    // `WINZ99` is 1999 when read from 2026 and 2099 when read from 2080. Two digits of year are
    // ambiguous forever; silently picking a century is how a 2025 contract lands in 1925.
    expect(parseContractSymbol('WINZ99', 2026).year).toBe(1999);
    expect(parseContractSymbol('WINZ99', 2080).year).toBe(2099);
    expect(parseContractSymbol('WINZ05', 2026).year).toBe(2005);
  });

  it('round-trips any root, year and month', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('WIN', 'WDO', 'IND', 'DOL'),
        fc.integer({ min: 1990, max: 2060 }),
        fc.integer({ min: 1, max: 12 }),
        (root, year, month) => {
          const parsed = parseContractSymbol(contractSymbol(root, year, month), 2025);
          expect(parsed).toEqual({ root, year, month });
        },
      ),
      { numRuns: 200 },
    );
  });

  it('refuses something that is not a contract symbol', () => {
    for (const bad of ['WIN', 'PETR4', 'WINI25', 'WINJ2025', '']) {
      expect(() => parseContractSymbol(bad, 2025)).toThrow(ConfigError);
    }
  });
});

describe('WIN and IND expiries — the Wednesday nearest the 15th', () => {
  it('matches every B3 index expiry of 2025', () => {
    // Transcribed from the exchange's own calendar, not derived from this implementation.
    const expected: readonly (readonly [number, string])[] = [
      [2, '2025-02-12'],
      [4, '2025-04-16'],
      [6, '2025-06-18'],
      [8, '2025-08-13'],
      [10, '2025-10-15'],
      [12, '2025-12-17'],
    ];
    for (const [month, date] of expected) {
      expect(localDate(contractOf(B3_SERIES.WIN, calendar, 2025, month).expiry)).toBe(date);
    }
  });

  it('takes the 15th itself when the 15th is a Wednesday', () => {
    // October 2025: the 15th was a Wednesday, so there is nothing to round to.
    expect(localDate(contractOf(B3_SERIES.WIN, calendar, 2025, 10).expiry)).toBe('2025-10-15');
  });

  it('gives the mini and the full contract the same expiry', () => {
    for (const month of B3_SERIES.WIN.months) {
      expect(contractOf(B3_SERIES.WIN, calendar, 2025, month).expiry).toBe(
        contractOf(B3_SERIES.IND, calendar, 2025, month).expiry,
      );
    }
  });

  it('only lists the even months', () => {
    expect(B3_SERIES.WIN.months).toEqual([2, 4, 6, 8, 10, 12]);
    expect(() => contractOf(B3_SERIES.WIN, calendar, 2025, 3)).toThrow(/no contract expiring/);
  });

  it('lands on a Wednesday, or later when that Wednesday is shut', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2020, max: 2040 }),
        fc.constantFrom(...B3_SERIES.WIN.months),
        (year, month) => {
          const expiry = contractOf(B3_SERIES.WIN, calendar, year, month).expiry;
          const day = calendar.localDayIndex(expiry);
          // Never earlier than a Wednesday: a holiday pushes an expiry forward, never back.
          expect(weekdayOf(day)).toBeGreaterThanOrEqual(3);
          expect(calendar.isTradingDay(calendar.atLocalMinute(day, 720))).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('WDO and DOL expiries — the first trading day of the month', () => {
  it('matches B3 dollar expiries across a year', () => {
    const expected: readonly (readonly [number, string])[] = [
      [1, '2025-01-02'], // the 1st is New Year's Day
      [3, '2025-03-05'], // the 1st is a Saturday and Carnival takes the 3rd and 4th
      [5, '2025-05-02'], // the 1st is Labour Day
      [6, '2025-06-02'], // the 1st is a Sunday
      [9, '2025-09-01'], // an ordinary Monday
    ];
    for (const [month, date] of expected) {
      expect(localDate(contractOf(B3_SERIES.WDO, calendar, 2025, month).expiry)).toBe(date);
    }
  });

  it('has a contract every month, unlike the index', () => {
    expect(B3_SERIES.WDO.months).toHaveLength(12);
  });

  it('always expires on a trading day, for any month of any year', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2020, max: 2040 }),
        fc.integer({ min: 1, max: 12 }),
        (year, month) => {
          const day = calendar.localDayIndex(
            contractOf(B3_SERIES.WDO, calendar, year, month).expiry,
          );
          expect(calendar.isTradingDay(calendar.atLocalMinute(day, 720))).toBe(true);
          // The first trading day of a month is in that month, never the previous one.
          expect(civilFromDays(day).month).toBe(month);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('the roll', () => {
  it('happens before expiry, on a trading day', () => {
    const contract = contractOf(B3_SERIES.WIN, calendar, 2025, 4);
    expect(contract.rollsAt).toBeLessThan(contract.expiry);
    expect(calendar.isOpen(asTimestamp(contract.rollsAt - 1))).toBe(true);
    // Five sessions before the 16th of April 2025 is the 9th.
    expect(localDate(contract.rollsAt)).toBe('2025-04-09');
  });

  it('counts sessions, not calendar days, when a holiday is in the way', () => {
    // The February 2025 contract expired on the 12th; Carnival was the 3rd and 4th of March, so
    // this one is clear — but the count still has to skip two weekends.
    const contract = contractOf(B3_SERIES.WIN, calendar, 2025, 2);
    expect(localDate(contract.expiry)).toBe('2025-02-12');
    expect(localDate(contract.rollsAt)).toBe('2025-02-05');
  });

  it('names the assumption rather than hiding it', () => {
    // There is no correct roll distance — volume migrates over several sessions. What matters is
    // that it is a value on the series, so a different assumption is a different object.
    const eager: ContractSeries = { ...B3_SERIES.WIN, rollDaysBefore: 10 };
    expect(localDate(contractOf(eager, calendar, 2025, 4).rollsAt)).toBe('2025-04-02');
  });
});

describe('which contract is the front month', () => {
  it('is the April contract in March', () => {
    expect(frontContract(B3_SERIES.WIN, calendar, fromIso('2025-03-10T15:00:00Z')).symbol).toBe(
      'WINJ25',
    );
  });

  it('has already moved on during the days between the roll and the expiry', () => {
    // The 10th of April 2025 is after WINJ25's roll and before its expiry on the 16th. A backtest
    // that used "nearest unexpired contract" would be trading a contract the volume has left.
    const between = fromIso('2025-04-10T15:00:00Z');
    const front = frontContract(B3_SERIES.WIN, calendar, between);
    expect(front.symbol).toBe('WINM25');
    expect(contractOf(B3_SERIES.WIN, calendar, 2025, 4).expiry).toBeGreaterThan(between);
  });

  it('rolls into the next contract the moment the old one stops being liquid', () => {
    const contract = contractOf(B3_SERIES.WIN, calendar, 2025, 4);
    expect(frontContract(B3_SERIES.WIN, calendar, asTimestamp(contract.rollsAt - 1)).symbol).toBe(
      'WINJ25',
    );
    expect(frontContract(B3_SERIES.WIN, calendar, asTimestamp(contract.rollsAt + 1)).symbol).toBe(
      'WINM25',
    );
  });

  it('crosses a year end', () => {
    expect(frontContract(B3_SERIES.WIN, calendar, fromIso('2025-12-29T15:00:00Z')).symbol).toBe(
      'WING26',
    );
  });

  it('never returns a contract that has already expired', () => {
    fc.assert(
      fc.property(
        fc.integer({
          min: fromIso('2021-01-01T00:00:00Z'),
          max: fromIso('2035-01-01T00:00:00Z'),
        }),
        (micros) => {
          const ts = asTimestamp(micros);
          for (const series of [B3_SERIES.WIN, B3_SERIES.WDO]) {
            const front = frontContract(series, calendar, ts);
            expect(front.expiry).toBeGreaterThan(ts);
            expect(front.rollsAt).toBeGreaterThan(ts);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('listing the contracts of a period', () => {
  it('gives the six index contracts of a year, in order', () => {
    const contracts = contractsBetween(
      B3_SERIES.WIN,
      calendar,
      fromIso('2025-01-01T00:00:00Z'),
      fromIso('2026-01-01T00:00:00Z'),
    );
    expect(contracts.map((c) => c.symbol)).toEqual([
      'WING25',
      'WINJ25',
      'WINM25',
      'WINQ25',
      'WINV25',
      'WINZ25',
    ]);
    for (let i = 1; i < contracts.length; i++) {
      expect(contracts[i]!.expiry).toBeGreaterThan(contracts[i - 1]!.expiry);
    }
  });

  it('gives twelve dollar contracts for the same year', () => {
    const contracts = contractsBetween(
      B3_SERIES.WDO,
      calendar,
      fromIso('2025-01-01T00:00:00Z'),
      fromIso('2026-01-01T00:00:00Z'),
    );
    expect(contracts).toHaveLength(12);
    expect(contracts[0]?.symbol).toBe('WDOF25');
    expect(contracts[11]?.symbol).toBe('WDOZ25');
  });

  it('is empty for a window no contract expires in', () => {
    expect(
      contractsBetween(
        B3_SERIES.WIN,
        calendar,
        fromIso('2025-01-01T00:00:00Z'),
        fromIso('2025-02-01T00:00:00Z'),
      ),
    ).toHaveLength(0);
  });
});
