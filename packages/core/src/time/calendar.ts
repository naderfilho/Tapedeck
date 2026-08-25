/**
 * Trading calendars: which days a venue trades, and between which hours.
 *
 * The engine has lived without one until now because crypto never closes. B3 does, and the
 * difference is not cosmetic: a `day` order placed on Friday afternoon dies at Friday's close and
 * not at midnight UTC, a strategy that counts bars held is counting sessions rather than calendar
 * days, and a gap over a holiday is not a gap in the data.
 *
 * Three decisions shape this file.
 *
 * **Everything is integer arithmetic on day indices.** No `Date` is allocated, ever. A civil date
 * is converted to and from a day count with Howard Hinnant's algorithm, which is exact for every
 * date this engine can represent, and holiday lookups are a `Set` of day indices built once per
 * year on demand. The engine asks "is this a trading day" once per bar; it must not cost an
 * allocation.
 *
 * **The UTC offset is a fixed number, not a time zone.** Resolving a real time zone means either
 * shipping the IANA database or calling `Intl`, whose answers depend on the ICU build Node was
 * compiled with — and a backtest whose session boundaries move with a Node upgrade is not
 * reproducible (ADR-0006). Brazil abolished daylight saving in 2019, so a fixed `-03:00` is
 * *correct* for B3 from November 2019 onward and wrong before it. {@link B3.validFrom} states
 * that, and {@link TradingCalendar.assertCovers} refuses data from before it rather than quietly
 * shifting every session by an hour.
 *
 * **The holiday table is data, and it is not authoritative.** It is transcribed from the published
 * B3 calendar and marked as needing verification, exactly like the placeholder costs in
 * `PRESETS.b3Futures`. A calendar that is quietly wrong about one Wednesday in February produces a
 * backtest that is quietly wrong about every trade that Wednesday — so
 * {@link CalendarSpec.holidays} is overridable, and a run whose dates matter should override it.
 */

import { ConfigError } from '../util/errors.ts';
import {
  type Timestamp,
  MICROS_PER_DAY,
  MICROS_PER_MINUTE,
  asTimestamp,
  toIso,
} from './timestamp.ts';

/** A contiguous stretch of the local day during which orders match. */
export interface SessionSpec {
  readonly name: string;
  /** Minutes from local midnight, inclusive. */
  readonly openMinute: number;
  /** Minutes from local midnight, exclusive. A session never spans midnight. */
  readonly closeMinute: number;
}

/**
 * A day whose sessions differ from the usual ones — B3's half day after Carnival, for instance.
 * An empty `sessions` array is a closure, which is how a one-off market holiday is expressed.
 */
export interface SpecialDay {
  /** `YYYY-MM-DD` in the calendar's local time. */
  readonly date: string;
  readonly sessions: readonly SessionSpec[];
  readonly reason: string;
}

export interface CalendarSpec {
  readonly id: string;
  /** Minutes to add to UTC to get local time. `-180` for Brazil. */
  readonly utcOffsetMinutes: number;
  readonly sessions: readonly SessionSpec[];
  /** Local weekday numbers that never trade. 0 is Sunday. */
  readonly weekend: readonly number[];
  /** `MM-DD`, observed every year. */
  readonly fixedHolidays: readonly string[];
  /**
   * Offsets in days from Easter Sunday. Carnival Monday is -48, Good Friday -2, Corpus Christi
   * +60. Computing them beats listing them: the list would need extending every December.
   */
  readonly easterHolidays: readonly number[];
  /** Dated exceptions: one-off closures and irregular sessions. */
  readonly specialDays?: readonly SpecialDay[] | undefined;
  /**
   * The instant before which this calendar is not valid, usually because the venue's time zone
   * rules changed. Queries before it throw rather than answer.
   */
  readonly validFrom?: Timestamp | undefined;
}

export interface SessionBounds {
  readonly name: string;
  readonly open: Timestamp;
  readonly close: Timestamp;
}

/** Days from the civil epoch (1970-01-01) — Howard Hinnant's `days_from_civil`, exact. */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

export interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** The inverse of {@link daysFromCivil}. */
export function civilFromDays(days: number): CivilDate {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1_460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return { year: y + (month <= 2 ? 1 : 0), month, day };
}

/**
 * Easter Sunday as a day index, by the anonymous Gregorian algorithm.
 *
 * Four Brazilian market holidays hang off this date and none of them is on a fixed calendar day,
 * so a table of them would be a table someone has to remember to extend.
 */
export function easterSunday(year: number): number {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return daysFromCivil(year, month, day);
}

/** Day of the week for a day index. 0 is Sunday; 1970-01-01 was a Thursday. */
export function weekdayOf(dayIndex: number): number {
  return ((dayIndex % 7) + 11) % 7;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_DAY_RE = /^(\d{2})-(\d{2})$/;

function parseDate(text: string, field: string): number {
  const match = DATE_RE.exec(text);
  if (match === null) {
    throw new ConfigError(`${field} must be YYYY-MM-DD, got ${JSON.stringify(text)}`, { text });
  }
  return daysFromCivil(Number(match[1]), Number(match[2]), Number(match[3]));
}

export class TradingCalendar {
  readonly spec: CalendarSpec;
  private readonly offsetMicros: number;
  private readonly weekend: ReadonlySet<number>;
  private readonly special = new Map<number, SpecialDay>();
  /** Holiday day-indices, built per year the first time that year is asked about. */
  private readonly holidaysByYear = new Map<number, ReadonlySet<number>>();

  constructor(spec: CalendarSpec) {
    if (spec.sessions.length === 0) {
      throw new ConfigError(`calendar ${spec.id} has no sessions`);
    }
    for (const session of spec.sessions) assertSession(session, spec.id);
    for (const day of spec.fixedHolidays) {
      if (!MONTH_DAY_RE.test(day)) {
        throw new ConfigError(`fixed holiday must be MM-DD, got ${JSON.stringify(day)}`, { day });
      }
    }
    this.spec = spec;
    this.offsetMicros = spec.utcOffsetMinutes * MICROS_PER_MINUTE;
    this.weekend = new Set(spec.weekend);
    for (const day of spec.specialDays ?? []) {
      for (const session of day.sessions) assertSession(session, spec.id);
      this.special.set(parseDate(day.date, 'special day'), day);
    }
  }

  /**
   * The local calendar day a UTC instant falls in, as a day index.
   *
   * This is what a `day` order should key off instead of {@link utcDayIndex}: an order submitted
   * at 20:00 UTC on a Monday is a Monday order in São Paulo and a Tuesday order in Tokyo, and the
   * venue is the one that decides.
   */
  localDayIndex(ts: Timestamp): number {
    return Math.floor((ts + this.offsetMicros) / MICROS_PER_DAY);
  }

  /**
   * The UTC instant of a local minute on a given local day.
   *
   * The inverse of {@link localDayIndex} plus {@link localMinuteOfDay}, and the only sanctioned way
   * to turn a day index back into an instant — the arithmetic is short enough to inline and
   * exactly wrong often enough to be worth having in one place.
   */
  atLocalMinute(dayIndex: number, minute: number): Timestamp {
    return asTimestamp(dayIndex * MICROS_PER_DAY - this.offsetMicros + minute * MICROS_PER_MINUTE);
  }

  /** Minutes since local midnight. */
  localMinuteOfDay(ts: Timestamp): number {
    const local = ts + this.offsetMicros;
    return Math.floor(
      (local - Math.floor(local / MICROS_PER_DAY) * MICROS_PER_DAY) / MICROS_PER_MINUTE,
    );
  }

  /** Refuses instants the calendar's fixed UTC offset was never valid for. */
  assertCovers(ts: Timestamp): void {
    const from = this.spec.validFrom;
    if (from !== undefined && ts < from) {
      throw new ConfigError(
        `calendar ${this.spec.id} is only valid from ${toIso(from)}; ${toIso(ts)} predates a ` +
          `change in the venue's time-zone rules and would be shifted by the wrong offset`,
        { calendar: this.spec.id, validFrom: from, requested: ts },
      );
    }
  }

  /** The sessions held on the local day containing `ts`. Empty on a holiday or a weekend. */
  sessionsOn(ts: Timestamp): readonly SessionSpec[] {
    this.assertCovers(ts);
    return this.sessionsOnDay(this.localDayIndex(ts));
  }

  isTradingDay(ts: Timestamp): boolean {
    return this.sessionsOn(ts).length > 0;
  }

  /** True when `ts` falls inside a session. Boundaries are `[open, close)`. */
  isOpen(ts: Timestamp): boolean {
    const minute = this.localMinuteOfDay(ts);
    for (const session of this.sessionsOn(ts)) {
      if (minute >= session.openMinute && minute < session.closeMinute) return true;
    }
    return false;
  }

  /** The session containing `ts`, or `null` when the venue is shut. */
  sessionAt(ts: Timestamp): SessionBounds | null {
    const day = this.localDayIndex(ts);
    const minute = this.localMinuteOfDay(ts);
    for (const session of this.sessionsOn(ts)) {
      if (minute >= session.openMinute && minute < session.closeMinute) {
        return this.boundsOf(day, session);
      }
    }
    return null;
  }

  /**
   * When the venue next shuts, at or after `ts`.
   *
   * This is what a `day` order expires on. Returning the close of the *current* session when one
   * is running, and of the next session otherwise, means an order submitted while the market is
   * shut dies at the end of the session it was waiting for rather than immediately.
   */
  nextClose(ts: Timestamp): Timestamp {
    this.assertCovers(ts);
    const minute = this.localMinuteOfDay(ts);
    let day = this.localDayIndex(ts);

    for (const session of this.sessionsOnDay(day)) {
      if (minute < session.closeMinute) return this.boundsOf(day, session).close;
    }
    for (let ahead = 1; ahead <= LOOKAHEAD_DAYS; ahead++) {
      day++;
      const sessions = this.sessionsOnDay(day);
      const last = sessions[sessions.length - 1];
      if (last !== undefined) return this.boundsOf(day, last).close;
    }
    throw new ConfigError(
      `calendar ${this.spec.id} has no trading day within ${String(LOOKAHEAD_DAYS)} days of ` +
        toIso(ts),
      { calendar: this.spec.id, from: ts },
    );
  }

  /** When the venue next opens, at or after `ts`. Returns `ts` itself if it is already open. */
  nextOpen(ts: Timestamp): Timestamp {
    this.assertCovers(ts);
    const minute = this.localMinuteOfDay(ts);
    let day = this.localDayIndex(ts);

    for (const session of this.sessionsOnDay(day)) {
      if (minute < session.openMinute) return this.boundsOf(day, session).open;
      if (minute < session.closeMinute) return ts;
    }
    for (let ahead = 1; ahead <= LOOKAHEAD_DAYS; ahead++) {
      day++;
      const first = this.sessionsOnDay(day)[0];
      if (first !== undefined) return this.boundsOf(day, first).open;
    }
    throw new ConfigError(
      `calendar ${this.spec.id} has no trading day within ${String(LOOKAHEAD_DAYS)} days of ` +
        toIso(ts),
      { calendar: this.spec.id, from: ts },
    );
  }

  /**
   * How many trading days lie in `[from, to)`.
   *
   * Metrics that annualise need this: dividing by 365 on an instrument that trades 252 days a year
   * reports a Sharpe ratio that is wrong by the square root of the difference.
   */
  tradingDaysBetween(from: Timestamp, to: Timestamp): number {
    this.assertCovers(from);
    if (to <= from) return 0;
    const first = this.localDayIndex(from);
    const last = this.localDayIndex(asTimestamp(to - 1));
    let count = 0;
    for (let day = first; day <= last; day++) {
      if (this.sessionsOnDay(day).length > 0) count++;
    }
    return count;
  }

  private sessionsOnDay(day: number): readonly SessionSpec[] {
    const special = this.special.get(day);
    if (special !== undefined) return special.sessions;
    if (this.weekend.has(weekdayOf(day))) return NO_SESSIONS;
    const { year } = civilFromDays(day);
    if (this.holidaysOf(year).has(day)) return NO_SESSIONS;
    return this.spec.sessions;
  }

  private boundsOf(day: number, session: SessionSpec): SessionBounds {
    const midnight = day * MICROS_PER_DAY - this.offsetMicros;
    return {
      name: session.name,
      open: asTimestamp(midnight + session.openMinute * MICROS_PER_MINUTE),
      close: asTimestamp(midnight + session.closeMinute * MICROS_PER_MINUTE),
    };
  }

  private holidaysOf(year: number): ReadonlySet<number> {
    const cached = this.holidaysByYear.get(year);
    if (cached !== undefined) return cached;

    const days = new Set<number>();
    for (const monthDay of this.spec.fixedHolidays) {
      const match = MONTH_DAY_RE.exec(monthDay);
      if (match === null) continue;
      days.add(daysFromCivil(year, Number(match[1]), Number(match[2])));
    }
    const easter = easterSunday(year);
    for (const offset of this.spec.easterHolidays) days.add(easter + offset);

    this.holidaysByYear.set(year, days);
    return days;
  }
}

const NO_SESSIONS: readonly SessionSpec[] = [];
/** Long enough to step over any closure a real venue has; short enough to fail loudly on a bad spec. */
const LOOKAHEAD_DAYS = 30;

function assertSession(session: SessionSpec, calendarId: string): void {
  const { openMinute, closeMinute } = session;
  if (!Number.isInteger(openMinute) || !Number.isInteger(closeMinute)) {
    throw new ConfigError(`${calendarId}: session bounds must be whole minutes`, { session });
  }
  if (openMinute < 0 || closeMinute > 24 * 60 || closeMinute <= openMinute) {
    throw new ConfigError(
      `${calendarId}: session ${session.name} must satisfy 0 <= open < close <= 1440`,
      { session },
    );
  }
}

const MINUTE = (hours: number, minutes: number): number => hours * 60 + minutes;

/**
 * B3's regular session, as published.
 *
 * **These hours and holidays are transcribed, not authoritative.** B3 revises both, the exchange
 * publishes the definitive calendar every year, and the equity and derivative segments do not keep
 * identical hours. Treat this the way you treat `PRESETS.b3Futures`: a starting point that has to
 * be replaced with the real thing before a result means anything. Overriding is a spread:
 *
 * ```ts
 * new TradingCalendar({ ...B3, fixedHolidays: [...B3.fixedHolidays, '07-09'] });
 * ```
 *
 * Two things it does model, because they change results rather than decorate them: the four
 * Easter-derived holidays, and the 24th and 31st of December, which are not legal holidays and on
 * which B3 does not trade.
 *
 * `validFrom` is 2019-11-03, the end of Brazilian daylight saving. Before that date the local
 * offset alternated between `-03:00` and `-02:00`, and this calendar would silently apply the
 * wrong one; it refuses instead.
 */
export const B3: CalendarSpec = {
  id: 'B3',
  utcOffsetMinutes: -180,
  weekend: [0, 6],
  sessions: [{ name: 'regular', openMinute: MINUTE(9, 0), closeMinute: MINUTE(18, 0) }],
  fixedHolidays: [
    '01-01', // Confraternização Universal
    '04-21', // Tiradentes
    '05-01', // Dia do Trabalho
    '09-07', // Independência
    '10-12', // Nossa Senhora Aparecida
    '11-02', // Finados
    '11-15', // Proclamação da República
    '11-20', // Consciência Negra — national from 2024; B3 observed it earlier in São Paulo
    '12-24', // Not a holiday. B3 does not trade.
    '12-25', // Natal
    '12-31', // Not a holiday. B3 does not trade.
  ],
  easterHolidays: [
    -48, // Carnival Monday
    -47, // Carnival Tuesday
    -2, // Good Friday
    60, // Corpus Christi
  ],
  validFrom: asTimestamp(daysFromCivil(2019, 11, 3) * MICROS_PER_DAY),
};

/** Crypto: always open. Exists so a calendar is never optional in code that wants one. */
export const ALWAYS_OPEN: CalendarSpec = {
  id: 'always-open',
  utcOffsetMinutes: 0,
  weekend: [],
  sessions: [{ name: 'continuous', openMinute: 0, closeMinute: 24 * 60 }],
  fixedHolidays: [],
  easterHolidays: [],
};
