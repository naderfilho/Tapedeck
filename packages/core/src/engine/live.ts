/**
 * The live driver: the same kernel, fed by a socket instead of by a file.
 *
 * This is where ADR-0003's claim is either true or it is not. A backtest calls `feedBars` in a
 * loop; a paper session calls the *same* method from a queue that a WebSocket handler fills. The
 * strategy is not told which one it is running under, because there is nothing it could correctly
 * do with the answer.
 *
 * Three things are genuinely different live, and each is dealt with here rather than hidden:
 *
 * 1. **Time between events.** A backtest has none: the next bar is the next instant. Live, the
 *    market can go quiet while an order's latency elapses, so the session emits heartbeats and the
 *    engine advances on them. A heartbeat cannot fill anything; it only fires timers already due.
 * 2. **Backpressure.** The queue depth is a number this session reports. When it hits the cap the
 *    session stops accepting rather than dropping the middle of the tape or reordering it — a
 *    paper run that quietly skipped events is a paper run whose fills mean nothing.
 * 3. **Lag.** Wall time minus the event's own timestamp, measured when the event is processed.
 *    The kernel still runs on event time (ADR-0014); lag is reported, not applied, because
 *    applying it would make the same event sequence produce different fills on a busy laptop.
 *
 * Persistence lives at the asynchronous edge, exactly as in a backtest: {@link drain} is
 * synchronous and buffers what needs writing, {@link flush} is awaited by the caller and writes it.
 */

import type { BarChunk, TickChunk } from '../tape/chunk.ts';
import type { OrderFilledEvent } from '../events/events.ts';
import type { StreamStatus } from '../data.ts';
import type { PaperState, Store } from '../store.ts';
import { NullStore } from '../store.ts';
import { type ReadonlyClock, LiveClock } from '../time/clock.ts';
import { type Timestamp, MICROS_PER_SECOND } from '../time/timestamp.ts';
import { IllegalStateError } from '../util/errors.ts';
import { type RunOptions, Engine } from './engine.ts';
import type { RunResult } from './result.ts';

/**
 * One item of work in the queue.
 *
 * A recorded sequence of these *is* a replayable session: feeding them to a fresh engine in order
 * produces the same fills, which is what `live-replay.test.ts` asserts. That is only true because
 * a heartbeat carries the wall-clock reading that produced it rather than reading the clock again
 * at replay time — the nondeterminism is captured at the edge and becomes data.
 */
export type LiveEvent =
  | { readonly kind: 'bars'; readonly chunk: BarChunk }
  | { readonly kind: 'ticks'; readonly chunk: TickChunk }
  | { readonly kind: 'heartbeat'; readonly ts: Timestamp };

export interface LiveSessionOptions {
  /** Identifies the session in the store. Reusing one resumes it. */
  readonly sessionId: string;
  /** Reads wall time, for lag and heartbeats. Injectable so tests do not depend on a real clock. */
  readonly wallClock?: ReadonlyClock | undefined;
  readonly store?: Store | undefined;
  /** Queue cap. Reaching it stops the session accepting events. Defaults to 10,000. */
  readonly maxQueueDepth?: number | undefined;
  /** Snapshot the account every N processed events. Defaults to 50. */
  readonly snapshotEvery?: number | undefined;
  /** Every event that entered the queue, in order. Used to record a session for replay. */
  readonly onEvent?: ((event: LiveEvent) => void) | undefined;
}

export interface LiveStats {
  enqueued: number;
  /** Events refused because the queue was full. Not dropped silently — see {@link enqueue}. */
  rejected: number;
  processed: number;
  heartbeats: number;
  drains: number;
  fills: number;
  queueDepth: number;
  maxQueueDepth: number;
  /** Wall time minus event time for the most recent event, in microseconds. */
  lastLagMicros: number;
  maxLagMicros: number;
  snapshots: number;
  /** Reconnections that admitted to having missed something. */
  gaps: number;
  gapMicros: number;
  disconnections: number;
  restored: boolean;
  /** Fills the store holds that the restored snapshot predates. See {@link start}. */
  fillsAfterSnapshot: number;
}

const DEFAULT_MAX_QUEUE = 10_000;
const DEFAULT_SNAPSHOT_EVERY = 50;
/** Above this, lag stops being jitter and starts being a session that is not keeping up. */
const LAG_WARNING_MICROS = 5 * MICROS_PER_SECOND;

/** Timestamp of the last thing an event says happened. */
function eventTs(event: LiveEvent): Timestamp {
  switch (event.kind) {
    case 'bars': {
      const { chunk } = event;
      return (chunk.closeTs[chunk.count - 1] ?? 0) as Timestamp;
    }
    case 'ticks': {
      const { chunk } = event;
      return (chunk.ts[chunk.count - 1] ?? 0) as Timestamp;
    }
    case 'heartbeat':
      return event.ts;
  }
}

export class LiveSession<P extends object> {
  readonly engine: Engine<P>;
  readonly stats: LiveStats = {
    enqueued: 0,
    rejected: 0,
    processed: 0,
    heartbeats: 0,
    drains: 0,
    fills: 0,
    queueDepth: 0,
    maxQueueDepth: 0,
    lastLagMicros: 0,
    maxLagMicros: 0,
    snapshots: 0,
    gaps: 0,
    gapMicros: 0,
    disconnections: 0,
    restored: false,
    fillsAfterSnapshot: 0,
  };

  private readonly options: LiveSessionOptions;
  private readonly store: Store;
  private readonly wallClock: ReadonlyClock;
  private readonly maxQueue: number;
  private readonly snapshotEvery: number;

  /** FIFO with a moving head: shifting an array of ten thousand events per drain is not free. */
  private readonly queue: LiveEvent[] = [];
  private head = 0;

  /** Fills produced by the last drain, waiting for {@link flush} to write them. */
  private readonly pendingFills: OrderFilledEvent[] = [];
  private sinceSnapshot = 0;
  private draining = false;
  private started = false;
  private stopped = false;

  constructor(runOptions: RunOptions<P>, options: LiveSessionOptions) {
    this.options = options;
    this.store = options.store ?? NullStore;
    this.wallClock = options.wallClock ?? new LiveClock();
    this.maxQueue = Math.max(1, options.maxQueueDepth ?? DEFAULT_MAX_QUEUE);
    this.snapshotEvery = Math.max(1, options.snapshotEvery ?? DEFAULT_SNAPSHOT_EVERY);

    const userOnFill = runOptions.onFill;
    this.engine = new Engine<P>({
      ...runOptions,
      onFill: (fill: OrderFilledEvent): void => {
        this.stats.fills++;
        this.pendingFills.push(fill);
        userOnFill?.(fill);
      },
    });
  }

  /**
   * Restores the account from the store, if this session id has run before.
   *
   * A session that comes back is rebuilt from the snapshot, not from the fill log: the snapshot is
   * the account as the venue would report it, while replaying fills means re-deriving cash from
   * commissions and hoping the derivation matches. Fills recorded *after* the last snapshot are
   * counted and reported rather than replayed — they are the window a crash can lose, and saying
   * how wide it was is more useful than pretending it is zero.
   */
  async start(): Promise<boolean> {
    if (this.started) throw new IllegalStateError('live session already started');
    this.started = true;

    const state = await this.store.paper.restore(this.options.sessionId);
    if (state === null) return false;

    this.engine.restore(state);
    this.stats.restored = true;

    const fills = await this.store.paper.fills(this.options.sessionId);
    for (const fill of fills) {
      if (fill.fillId >= state.counters.nextFillId) this.stats.fillsAfterSnapshot++;
    }
    return true;
  }

  /**
   * Adds an event to the queue. Returns false when the queue is full.
   *
   * Refusing is the honest failure. The alternatives are dropping the oldest event, which
   * rewrites history, and dropping the newest, which is the same thing later; both produce a
   * session whose fills came from a tape nobody has. A caller that sees `false` should close the
   * socket and say so.
   */
  enqueue(event: LiveEvent): boolean {
    if (this.stopped) return false;
    if (this.depth >= this.maxQueue) {
      this.stats.rejected++;
      return false;
    }
    this.queue.push(event);
    this.stats.enqueued++;
    this.options.onEvent?.(event);
    const depth = this.depth;
    this.stats.queueDepth = depth;
    if (depth > this.stats.maxQueueDepth) this.stats.maxQueueDepth = depth;
    return true;
  }

  /**
   * Feeds every queued event to the engine, synchronously, in arrival order.
   *
   * This is the routine a backtest runs, reached through a queue instead of through a `for` loop.
   * Nothing here awaits, so no event can overtake another between the socket and the strategy.
   */
  drain(): number {
    if (this.draining) throw new IllegalStateError('drain() is not reentrant');
    this.draining = true;
    this.stats.drains++;
    let processed = 0;
    try {
      for (;;) {
        const event = this.queue[this.head];
        if (event === undefined) break;
        this.head++;
        this.apply(event);
        processed++;
      }
    } finally {
      this.queue.length = 0;
      this.head = 0;
      this.stats.queueDepth = 0;
      this.draining = false;
    }
    return processed;
  }

  /** What a socket handler does: enqueue, then run the kernel over whatever is waiting. */
  receive(event: LiveEvent): boolean {
    const accepted = this.enqueue(event);
    this.drain();
    return accepted;
  }

  /** Moves time forward to the wall clock. Called on a timer while the market is quiet. */
  heartbeat(): void {
    this.receive({ kind: 'heartbeat', ts: this.wallClock.now() });
  }

  /**
   * Records what the stream said about itself.
   *
   * A disconnection is not a market event and changes no price, but a session that reconnected
   * three times saw three holes in the tape, and the report has to say so.
   */
  noteStatus(status: StreamStatus): void {
    if (status.kind === 'disconnected') this.stats.disconnections++;
    if (status.kind === 'gap') {
      this.stats.gaps++;
      this.stats.gapMicros += status.sinceMicros;
    }
  }

  /** Writes what the last drains produced. The only asynchronous step, and it is at the edge. */
  async flush(): Promise<void> {
    while (this.pendingFills.length > 0) {
      const fill = this.pendingFills.shift();
      if (fill === undefined) break;
      await this.store.paper.appendFill(this.options.sessionId, fill);
    }
    if (this.sinceSnapshot >= this.snapshotEvery) await this.snapshot();
  }

  /** Writes the account as it stands, unconditionally. */
  async snapshot(): Promise<PaperState> {
    const state = this.engine.paperState(this.options.sessionId);
    await this.store.paper.snapshot(state);
    this.sinceSnapshot = 0;
    this.stats.snapshots++;
    return state;
  }

  /**
   * Ends the session: drains what is left, writes the final state, and produces a run result.
   *
   * The result is the same object a backtest produces, so a paper session goes through the same
   * metrics and the same report (ADR-0013). Nothing about the report knows where the bars came
   * from, which is the point.
   */
  async stop(): Promise<RunResult> {
    if (this.stopped) throw new IllegalStateError('live session already stopped');
    this.drain();
    await this.flush();
    await this.snapshot();
    this.stopped = true;
    return this.engine.finish();
  }

  /**
   * What this session could not know, in the same voice the engine uses for a backtest.
   *
   * Printed above the numbers, never below them.
   */
  warnings(): string[] {
    const out: string[] = [];
    const { stats } = this;

    if (stats.restored) {
      out.push(
        `this session resumed '${this.options.sessionId}' from a stored snapshot. The account — ` +
          `cash, cost basis, resting orders — came back; the strategy's own memory did not, and ` +
          `\`bar.index\` restarted at zero because it counts this run's bars. A strategy that has ` +
          `to survive a restart must derive its state from event time, from its fills and from ` +
          `the portfolio, never from a field.`,
      );
    }
    if (stats.fillsAfterSnapshot > 0) {
      out.push(
        `${String(stats.fillsAfterSnapshot)} fill(s) were recorded after the snapshot this ` +
          `session restored from. They are in the audit trail and are not in the restored ` +
          `account: that is the width of the window the previous crash lost.`,
      );
    }
    if (stats.gaps > 0) {
      out.push(
        `the feed reconnected ${String(stats.gaps)} time(s), leaving ` +
          `${(stats.gapMicros / MICROS_PER_SECOND).toFixed(1)}s of tape unseen. Fills that would ` +
          `have happened in those windows did not happen here.`,
      );
    }
    if (stats.rejected > 0) {
      out.push(
        `${String(stats.rejected)} event(s) were refused because the queue was full at ` +
          `${String(this.maxQueue)}. The strategy could not keep up with the market.`,
      );
    }
    if (stats.maxLagMicros > LAG_WARNING_MICROS) {
      out.push(
        `worst lag between an event's timestamp and the moment this session finished processing ` +
          `it was ${(stats.maxLagMicros / MICROS_PER_SECOND).toFixed(2)}s. Part of that is venue ` +
          `and network delay and part is this process; a live account would have filled somewhere ` +
          `inside it.`,
      );
    }
    return out;
  }

  private get depth(): number {
    return this.queue.length - this.head;
  }

  private apply(event: LiveEvent): void {
    const ts = eventTs(event);
    switch (event.kind) {
      case 'bars':
        this.engine.feedBars(event.chunk);
        break;
      case 'ticks':
        this.engine.feedTicks(event.chunk);
        break;
      case 'heartbeat':
        this.engine.advanceTo(event.ts);
        this.stats.heartbeats++;
        break;
    }

    this.stats.processed++;
    this.sinceSnapshot++;
    // Measured after the work, so the number includes this session's own processing time and not
    // only the venue's. Clock skew is in here too; there is no way to separate it from a single
    // side of the connection, and pretending otherwise would be inventing a number.
    const lag = this.wallClock.now() - ts;
    this.stats.lastLagMicros = lag;
    if (lag > this.stats.maxLagMicros) this.stats.maxLagMicros = lag;
  }
}
