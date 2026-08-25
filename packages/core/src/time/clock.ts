/**
 * The clock is one of exactly two things that differ between a backtest and a live session
 * (the other is who fills the event queue). See ADR-0003.
 *
 * It is deliberately tiny: a clock answers what time it is and nothing else. Scheduling lives in
 * {@link ../time/scheduler.js | Scheduler}, because a simulated schedule is driven by the data and
 * a live one by the platform, while `now()` has the same meaning in both.
 */

import { IllegalStateError } from '../util/errors.ts';
import { type Timestamp, asTimestamp, fromMillis } from './timestamp.ts';

export interface ReadonlyClock {
  now(): Timestamp;
}

export interface Clock extends ReadonlyClock {
  readonly kind: 'simulated' | 'live';
}

/**
 * Simulated time. Advanced by the engine to the timestamp of the event being processed, never by
 * itself. Refuses to move backwards, which turns an out-of-order data file into a loud failure
 * instead of a subtly wrong equity curve.
 */
export class SimulatedClock implements Clock {
  readonly kind = 'simulated';
  private current: Timestamp;

  constructor(start: Timestamp = asTimestamp(0)) {
    this.current = start;
  }

  now(): Timestamp {
    return this.current;
  }

  /** Engine-internal. Moves simulated time forward; equal timestamps are allowed. */
  advanceTo(ts: Timestamp): void {
    if (ts < this.current) {
      throw new IllegalStateError(
        `simulated clock cannot move backwards: ${String(this.current)} -> ${String(ts)}`,
        { from: this.current, to: ts },
      );
    }
    this.current = ts;
  }
}

/**
 * Wall-clock time, used by paper trading.
 *
 * This is the only place in the core allowed to read the host clock; ADR-0006 explains why, and
 * the lint rule below is what keeps it the only place.
 */
export class LiveClock implements Clock {
  readonly kind = 'live';

  now(): Timestamp {
    // eslint-disable-next-line no-restricted-syntax -- the one legitimate wall-clock read
    return fromMillis(Date.now());
  }
}
