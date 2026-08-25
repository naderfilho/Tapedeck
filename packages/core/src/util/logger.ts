/**
 * A logger that writes into the run instead of into a console.
 *
 * A backtest that prints to stdout is a backtest whose output depends on where it ran. Entries are
 * stamped with *simulated* time and collected in the run result, so they can be diffed between two
 * runs like any other output, and a paper-trading process can forward them wherever it likes.
 */

import type { Timestamp } from '../time/timestamp.ts';
import type { ReadonlyClock } from '../time/clock.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  readonly ts: Timestamp;
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>> | null;
}

export interface Logger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface BufferedLoggerOptions {
  /** Entries below this level are dropped without allocating. Defaults to `info`. */
  readonly level?: LogLevel | undefined;
  /**
   * Hard cap on retained entries. A strategy that logs on every bar of a million-bar run would
   * otherwise turn its own debug output into the largest object in the process.
   */
  readonly maxEntries?: number | undefined;
}

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class BufferedLogger implements Logger {
  private readonly clock: ReadonlyClock;
  private readonly threshold: number;
  private readonly maxEntries: number;
  private readonly entries: LogEntry[] = [];
  private dropped = 0;

  constructor(clock: ReadonlyClock, options: BufferedLoggerOptions = {}) {
    this.clock = clock;
    this.threshold = LEVEL_ORDER[options.level ?? 'info'];
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  /** Entries retained, oldest first. */
  get records(): readonly LogEntry[] {
    return this.entries;
  }

  /** Entries discarded because the cap was reached. Reported in the run result. */
  get droppedCount(): number {
    return this.dropped;
  }

  debug(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.write('error', message, fields);
  }

  private write(
    level: LogLevel,
    message: string,
    fields: Readonly<Record<string, unknown>> | undefined,
  ): void {
    if (LEVEL_ORDER[level] < this.threshold) return;
    if (this.entries.length >= this.maxEntries) {
      this.dropped++;
      return;
    }
    this.entries.push({
      ts: this.clock.now(),
      level,
      message,
      fields: fields ?? null,
    });
  }
}
