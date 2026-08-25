/**
 * The scheduler is the part of the event bus where "everything is an event" holds literally
 * (ADR-0004): order activation after latency, day-order expiry, live queue drains.
 *
 * It is a min-heap keyed by `(timestamp, sequence)`. The sequence makes the ordering total — two
 * timers registered for the same microsecond fire in registration order, always — which is what
 * lets the simulated and wall clocks be swapped without changing a result.
 */

import type { Brand } from '../util/brand.ts';
import { MinHeap } from '../util/heap.ts';
import type { SimulatedClock } from './clock.ts';
import type { Timestamp } from './timestamp.ts';

export type TimerId = Brand<number, 'TimerId'>;

export type TimerCallback = (firedAt: Timestamp) => void;

export interface Scheduler {
  /** Schedules `callback` for an absolute time. Times in the past fire at the next drain. */
  at(ts: Timestamp, callback: TimerCallback): TimerId;
  /** Schedules `callback` for `now + delayMicros`. */
  after(delayMicros: number, callback: TimerCallback): TimerId;
  /** Cancels a pending timer. Returns false if it had already fired or was already cancelled. */
  cancel(id: TimerId): boolean;
  /** Number of timers still queued, including cancelled ones not yet reached. */
  readonly pending: number;
}

interface Timer {
  readonly id: TimerId;
  readonly callback: TimerCallback;
  readonly ts: Timestamp;
}

export class SimulatedScheduler implements Scheduler {
  private readonly clock: SimulatedClock;
  private readonly heap = new MinHeap<Timer>();
  private readonly cancelled = new Set<TimerId>();
  private nextId = 1;
  private sequence = 0;

  constructor(clock: SimulatedClock) {
    this.clock = clock;
  }

  get pending(): number {
    return this.heap.size;
  }

  at(ts: Timestamp, callback: TimerCallback): TimerId {
    const id = this.nextId++ as TimerId;
    this.heap.push(ts, this.sequence++, { id, callback, ts });
    return id;
  }

  after(delayMicros: number, callback: TimerCallback): TimerId {
    return this.at((this.clock.now() + delayMicros) as Timestamp, callback);
  }

  cancel(id: TimerId): boolean {
    if (this.cancelled.has(id)) return false;
    this.cancelled.add(id);
    return true;
  }

  /**
   * Fires every timer due at or before `upTo`, advancing the clock to each timer's own timestamp
   * first so that `now()` inside a callback reports the time the callback was scheduled for.
   *
   * A callback may schedule further timers; those are picked up in the same drain if they are also
   * due, which keeps cause and effect inside one simulated instant.
   */
  drainUpTo(upTo: Timestamp): number {
    let fired = 0;
    for (;;) {
      const nextTs = this.heap.peekKeyA();
      if (nextTs === undefined || nextTs > upTo) break;
      const timer = this.heap.pop();
      if (timer === undefined) break;
      if (this.cancelled.delete(timer.id)) continue;
      this.clock.advanceTo(timer.ts);
      timer.callback(timer.ts);
      fired++;
    }
    return fired;
  }

  /** Drops everything pending. Used when a run ends. */
  clear(): void {
    this.heap.clear();
    this.cancelled.clear();
  }
}
