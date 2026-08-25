/**
 * Time in Tapedeck is an integer number of microseconds since the Unix epoch, UTC.
 *
 * Microseconds because B3 time-and-sales carries microsecond stamps and rounding them to
 * milliseconds collapses distinct trades onto the same instant, which destroys the total ordering
 * the engine depends on. A `number` holds microsecond precision exactly until the year 2255, so
 * no BigInt is needed anywhere on the hot path.
 *
 * Time zones exist only at the edges: data adapters convert to UTC on ingest and reports convert
 * back for display. The engine never sees a local time.
 */

import type { Brand } from '../util/brand.ts';
import { ConfigError } from '../util/errors.ts';

/** Microseconds since the Unix epoch, UTC. */
export type Timestamp = Brand<number, 'Timestamp'>;

/** A bar duration in microseconds. */
export type Duration = Brand<number, 'Duration'>;

export const MICROS_PER_MILLI = 1_000;
export const MICROS_PER_SECOND = 1_000_000;
export const MICROS_PER_MINUTE = 60 * MICROS_PER_SECOND;
export const MICROS_PER_HOUR = 60 * MICROS_PER_MINUTE;
export const MICROS_PER_DAY = 24 * MICROS_PER_HOUR;

export function asTimestamp(micros: number): Timestamp {
  return micros as Timestamp;
}

export function asDuration(micros: number): Duration {
  return micros as Duration;
}

export function fromMillis(millis: number): Timestamp {
  return (millis * MICROS_PER_MILLI) as Timestamp;
}

export function toMillis(ts: Timestamp): number {
  return Math.floor(ts / MICROS_PER_MILLI);
}

export function fromSeconds(seconds: number): Timestamp {
  return (seconds * MICROS_PER_SECOND) as Timestamp;
}

/** Parses an ISO-8601 instant. Rejects anything `Date` cannot parse unambiguously. */
export function fromIso(iso: string): Timestamp {
  const millis = new Date(iso).getTime();
  if (Number.isNaN(millis)) {
    throw new ConfigError(`not a valid ISO-8601 instant: ${JSON.stringify(iso)}`, { iso });
  }
  return fromMillis(millis);
}

/** Renders a timestamp as ISO-8601 with millisecond precision, for logs and reports. */
export function toIso(ts: Timestamp): string {
  return new Date(toMillis(ts)).toISOString();
}

/**
 * The UTC calendar day a timestamp falls in, as a day index since the epoch.
 * Used to expire day orders without pulling in a calendar or a `Date` allocation per bar.
 */
export function utcDayIndex(ts: Timestamp): number {
  return Math.floor(ts / MICROS_PER_DAY);
}

const TIMEFRAME_RE = /^(\d+)(ms|s|m|h|d)$/;

const UNIT_MICROS: Readonly<Record<string, number>> = {
  ms: MICROS_PER_MILLI,
  s: MICROS_PER_SECOND,
  m: MICROS_PER_MINUTE,
  h: MICROS_PER_HOUR,
  d: MICROS_PER_DAY,
};

/** Parses a timeframe such as `1m`, `15m`, `4h`, `1d` into a duration in microseconds. */
export function parseTimeframe(text: string): Duration {
  const match = TIMEFRAME_RE.exec(text.trim());
  if (match === null) {
    throw new ConfigError(`unrecognised timeframe: ${JSON.stringify(text)}`, { text });
  }
  const count = Number(match[1]);
  const unit = UNIT_MICROS[match[2] ?? ''];
  if (count <= 0 || unit === undefined) {
    throw new ConfigError(`unrecognised timeframe: ${JSON.stringify(text)}`, { text });
  }
  return (count * unit) as Duration;
}

/** Renders a duration back into the shortest timeframe string that round-trips. */
export function formatTimeframe(duration: Duration): string {
  for (const [suffix, unit] of [
    ['d', MICROS_PER_DAY],
    ['h', MICROS_PER_HOUR],
    ['m', MICROS_PER_MINUTE],
    ['s', MICROS_PER_SECOND],
    ['ms', MICROS_PER_MILLI],
  ] as const) {
    if (duration % unit === 0) return `${String(duration / unit)}${suffix}`;
  }
  return `${String(duration)}us`;
}
