/**
 * Futures contracts: their codes, their expiries, and which one is the front month.
 *
 * A futures symbol is not a name, it is a coordinate. `WINJ25` is the Ibovespa mini expiring in
 * April 2025, and in May it does not exist. Everything downstream that treats a futures series as
 * if it were a stock — a moving average across a roll, a position held through expiry, a backtest
 * spanning two years of "WIN" — is wrong in a way that does not announce itself, because the
 * numbers still look like prices.
 *
 * This module is the arithmetic that stops that. It knows nothing about data: given a calendar and
 * a date, it says which contract was trading and when it dies. Stitching the series together is a
 * separate job with its own compromises, and lives in `@tapedeck/data`.
 *
 * **The expiry rules are transcribed and not authoritative.** They match B3's published contract
 * specifications as of 2026, and B3 changes them. Every rule is a value on {@link ContractSeries},
 * so a series with a different rule is a different object rather than a fork of this file.
 */

import { type TradingCalendar, civilFromDays, daysFromCivil, weekdayOf } from './time/calendar.ts';
import { type Timestamp, MICROS_PER_DAY } from './time/timestamp.ts';
import { ConfigError } from './util/errors.ts';

/**
 * The exchange month codes, unchanged since the Chicago pits and used by every venue including
 * B3. `I` and `L` are skipped because they read as `1`.
 */
export const MONTH_CODES = 'FGHJKMNQUVXZ' as const;

export function monthCode(month: number): string {
  const code = MONTH_CODES[month - 1];
  if (code === undefined) {
    throw new ConfigError(`month must be 1..12, got ${String(month)}`, { month });
  }
  return code;
}

export function monthOfCode(code: string): number {
  const index = MONTH_CODES.indexOf(code.toUpperCase());
  if (index === -1) {
    throw new ConfigError(`not a futures month code: ${JSON.stringify(code)}`, { code });
  }
  return index + 1;
}

/** How a series decides the last trading day of a contract month. */
export type ExpiryRule =
  /** B3 index futures: the Wednesday closest to the 15th, rolled forward off a holiday. */
  | { readonly kind: 'wednesday-nearest-15th' }
  /** B3 FX futures: the first trading day of the contract month. */
  | { readonly kind: 'first-trading-day' }
  /** The nth trading day counted from the end of the previous month. */
  | { readonly kind: 'last-trading-day' }
  /** A fixed day of the month, rolled forward if the venue is shut. */
  | { readonly kind: 'day-of-month'; readonly day: number };

export interface ContractSeries {
  /** Root symbol without the month and year, e.g. `WIN`. */
  readonly root: string;
  /** Months in which a contract expires, 1-based. Index futures list only the even months. */
  readonly months: readonly number[];
  readonly expiry: ExpiryRule;
  /**
   * Trading days before expiry at which liquidity has moved to the next contract.
   *
   * There is no correct value. Volume migrates over several sessions and the crossover date
   * differs between contracts and between years; picking a number is picking an assumption, so it
   * is named here rather than buried in a stitching routine.
   */
  readonly rollDaysBefore: number;
}

export interface Contract {
  /** Full venue symbol, e.g. `WINJ25`. */
  readonly symbol: string;
  readonly root: string;
  readonly year: number;
  readonly month: number;
  /** Last trading day, at the session close. */
  readonly expiry: Timestamp;
  /** When this contract stops being the front month under the series' roll rule. */
  readonly rollsAt: Timestamp;
}

const SYMBOL_RE = /^([A-Z]{3,4})([FGHJKMNQUVXZ])(\d{2})$/;

/**
 * Renders a contract symbol. The year is two digits, which is what the venue prints and what every
 * B3 tool expects.
 */
export function contractSymbol(root: string, year: number, month: number): string {
  return `${root.toUpperCase()}${monthCode(month)}${String(year % 100).padStart(2, '0')}`;
}

/**
 * Parses `WINJ25` back into its parts.
 *
 * Two digits of year are ambiguous forever, so the century is resolved against `pivotYear`: a code
 * more than fifty years ahead of it is read as the previous century. Guessing silently is how a
 * 2025 contract becomes a 1925 one in a chart.
 */
export function parseContractSymbol(
  symbol: string,
  pivotYear: number,
): { root: string; year: number; month: number } {
  const match = SYMBOL_RE.exec(symbol.toUpperCase());
  if (match === null) {
    throw new ConfigError(`not a futures contract symbol: ${JSON.stringify(symbol)}`, { symbol });
  }
  const root = match[1] ?? '';
  const month = monthOfCode(match[2] ?? '');
  const twoDigit = Number(match[3]);
  const century = Math.floor(pivotYear / 100) * 100;
  let year = century + twoDigit;
  if (year - pivotYear > 50) year -= 100;
  if (pivotYear - year > 50) year += 100;
  return { root, year, month };
}

/** The last trading day of a contract month, as a day index, honouring the venue's closures. */
function expiryDayIndex(
  series: ContractSeries,
  calendar: TradingCalendar,
  year: number,
  month: number,
): number {
  // Midday local, so the question "is this a trading day" is asked at an instant that is
  // unambiguously inside the day being asked about, whatever the session hours are.
  const isTrading = (day: number): boolean =>
    calendar.isTradingDay(calendar.atLocalMinute(day, 720));

  const forward = (day: number): number => {
    for (let i = 0; i < 15; i++) {
      if (isTrading(day + i)) return day + i;
    }
    throw new ConfigError(`no trading day near ${String(year)}-${String(month)}`, { year, month });
  };
  const backward = (day: number): number => {
    for (let i = 0; i < 15; i++) {
      if (isTrading(day - i)) return day - i;
    }
    throw new ConfigError(`no trading day near ${String(year)}-${String(month)}`, { year, month });
  };

  switch (series.expiry.kind) {
    case 'wednesday-nearest-15th': {
      const fifteenth = daysFromCivil(year, month, 15);
      // "Nearest" needs no tie-break: the two candidate Wednesdays are seven days apart, so their
      // distances to the 15th sum to seven and cannot be equal.
      const delta = (3 - weekdayOf(fifteenth) + 7) % 7;
      const forwardWednesday = fifteenth + delta;
      const backwardWednesday = forwardWednesday - 7;
      const nearest =
        fifteenth - backwardWednesday < forwardWednesday - fifteenth
          ? backwardWednesday
          : forwardWednesday;
      // A holiday on the expiry Wednesday pushes the contract on, never back: the contract cannot
      // expire before the exchange said it would.
      return forward(nearest);
    }
    case 'first-trading-day':
      return forward(daysFromCivil(year, month, 1));
    case 'last-trading-day': {
      const firstOfNext =
        month === 12 ? daysFromCivil(year + 1, 1, 1) : daysFromCivil(year, month + 1, 1);
      return backward(firstOfNext - 1);
    }
    case 'day-of-month':
      return forward(daysFromCivil(year, month, series.expiry.day));
  }
}

/** Steps back `count` trading days from `day`. */
function tradingDaysBefore(calendar: TradingCalendar, day: number, count: number): number {
  let remaining = count;
  let cursor = day;
  for (let guard = 0; guard < 400 && remaining > 0; guard++) {
    cursor--;
    if (calendar.isTradingDay(calendar.atLocalMinute(cursor, 720))) remaining--;
  }
  return cursor;
}

/** Builds one contract of a series. */
export function contractOf(
  series: ContractSeries,
  calendar: TradingCalendar,
  year: number,
  month: number,
): Contract {
  if (!series.months.includes(month)) {
    throw new ConfigError(`${series.root} has no contract expiring in month ${String(month)}`, {
      root: series.root,
      month,
      months: series.months,
    });
  }
  const expiryDay = expiryDayIndex(series, calendar, year, month);
  const rollDay = tradingDaysBefore(calendar, expiryDay, series.rollDaysBefore);
  // Local midnight, so `nextClose` returns that day's own close rather than the previous one's.
  const closeOf = (day: number): Timestamp => calendar.nextClose(calendar.atLocalMinute(day, 0));

  return {
    symbol: contractSymbol(series.root, year, month),
    root: series.root,
    year,
    month,
    expiry: closeOf(expiryDay),
    rollsAt: closeOf(rollDay),
  };
}

/** Every contract of a series whose expiry falls in `[from, to)`, in order. */
export function contractsBetween(
  series: ContractSeries,
  calendar: TradingCalendar,
  from: Timestamp,
  to: Timestamp,
): readonly Contract[] {
  const first = civilFromDays(Math.floor(from / MICROS_PER_DAY));
  const last = civilFromDays(Math.floor(to / MICROS_PER_DAY));
  const out: Contract[] = [];
  // A year either side, so a contract expiring just outside the window still shows up as the one
  // that was trading inside it.
  for (let year = first.year - 1; year <= last.year + 1; year++) {
    for (const month of series.months) {
      const contract = contractOf(series, calendar, year, month);
      if (contract.expiry >= from && contract.expiry < to) out.push(contract);
    }
  }
  out.sort((a, b) => a.expiry - b.expiry);
  return out;
}

/**
 * The contract a strategy should be trading at `ts`.
 *
 * "Front month" is defined here as the nearest contract whose roll date has not passed — not the
 * nearest unexpired one. Those differ for a few sessions before every expiry, and that gap is
 * exactly the window where a backtest that gets it wrong is trading an illiquid contract against
 * quotes nobody was making.
 */
export function frontContract(
  series: ContractSeries,
  calendar: TradingCalendar,
  ts: Timestamp,
): Contract {
  const { year } = civilFromDays(Math.floor(ts / MICROS_PER_DAY));
  for (let y = year - 1; y <= year + 2; y++) {
    for (const month of series.months) {
      const contract = contractOf(series, calendar, y, month);
      if (contract.rollsAt > ts) return contract;
    }
  }
  throw new ConfigError(`no ${series.root} contract is front month at ${String(ts)}`, {
    root: series.root,
    ts,
  });
}

/**
 * B3 series, transcribed from the published contract specifications.
 *
 * `rollDaysBefore` is the assumption, not the specification: B3 says when a contract expires and
 * says nothing about when volume leaves it. Five sessions is the conventional figure for the index
 * minis and it is a starting point, not a measurement — the honest version measures it from the
 * volume in your own data.
 */
export const B3_SERIES = {
  /** Ibovespa futures, full size. Even months only. */
  IND: {
    root: 'IND',
    months: [2, 4, 6, 8, 10, 12],
    expiry: { kind: 'wednesday-nearest-15th' },
    rollDaysBefore: 5,
  },
  /** Ibovespa mini. Same expiry calendar as the full contract. */
  WIN: {
    root: 'WIN',
    months: [2, 4, 6, 8, 10, 12],
    expiry: { kind: 'wednesday-nearest-15th' },
    rollDaysBefore: 5,
  },
  /** US dollar futures, full size. Every month, expiring on the first trading day of it. */
  DOL: {
    root: 'DOL',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    expiry: { kind: 'first-trading-day' },
    rollDaysBefore: 3,
  },
  /** US dollar mini. */
  WDO: {
    root: 'WDO',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    expiry: { kind: 'first-trading-day' },
    rollDaysBefore: 3,
  },
} as const satisfies Readonly<Record<string, ContractSeries>>;
