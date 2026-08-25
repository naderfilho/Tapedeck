/**
 * The live driver.
 *
 * The claim under test is the one the whole project is arranged around: a strategy runs unchanged
 * in backtest and in paper trading. So the assertions here are equalities against the backtest
 * path, not against hand-written numbers — a paper session that produced *plausible* fills would
 * prove nothing.
 *
 * Everything is driven by a fake clock and a fake store. No socket, no timers, no wall clock: the
 * point of the queue is that it makes a live session a pure function of the events it was handed.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  type BarChunk,
  type Clock,
  type LiveEvent,
  type NewOrder,
  type OrderFilledEvent,
  type PaperState,
  type RunOptions,
  type Store,
  type Strategy,
  type StrategyContext,
  type Timestamp,
  Engine,
  LiveSession,
  MICROS_PER_MINUTE,
  MICROS_PER_SECOND,
  NullStore,
  asPrice,
  asQty,
  asTimestamp,
  fixedLatency,
  runBacktest,
} from '@tapedeck/core';
import { type BarRow, TEST_FUTURE, bars } from './helpers.ts';

/** A wall clock the test moves by hand. */
class FakeWallClock implements Clock {
  readonly kind = 'live';
  current: Timestamp = asTimestamp(0);

  now(): Timestamp {
    return this.current;
  }
}

/** The store, in a Map. Enough to lose power and come back. */
function memoryStore(): Store & { readonly states: Map<string, PaperState> } {
  const states = new Map<string, PaperState>();
  const fills = new Map<string, OrderFilledEvent[]>();
  return {
    ...NullStore,
    states,
    paper: {
      snapshot: (state) => {
        // Round-tripped through JSON, because that is what a real store does to it and a field
        // that does not survive serialisation is a field that does not survive a crash.
        states.set(state.sessionId, JSON.parse(JSON.stringify(state)) as PaperState);
        return Promise.resolve();
      },
      appendFill: (sessionId, fill) => {
        const list = fills.get(sessionId) ?? [];
        list.push(fill);
        fills.set(sessionId, list);
        return Promise.resolve();
      },
      restore: (sessionId) => Promise.resolve(states.get(sessionId) ?? null),
      fills: (sessionId) => Promise.resolve(fills.get(sessionId) ?? []),
    },
  };
}

/**
 * A strategy with enough behaviour to be worth comparing: it works both sides, rests a limit
 * order and brackets what it gets, so the broker's book is never trivially empty.
 *
 * It keeps nothing in a field and reads nothing that counts from the start of the process — not a
 * closure variable, not `bar.index`, which is the bar's place in *this run* and restarts with it.
 * That is not incidental: a restarted session restores the account and nothing else, so a strategy
 * meant to survive a restart derives what it needs from event time, from the fill, and from
 * `ctx.portfolio`. The two tests at the end of `crash recovery` pin both halves of that down.
 */
function scriptedStrategy(): Strategy {
  return {
    id: 'live-script',
    onInit: () => undefined,
    onBar: (bar, ctx: StrategyContext) => {
      const flat = ctx.portfolio.position(bar.instrumentId).qty === 0;
      const minute = Math.floor(bar.closeTs / MICROS_PER_MINUTE);
      if (flat && minute % 3 === 0) {
        ctx.submit({
          instrumentId: bar.instrumentId,
          side: bar.close > bar.open ? 'buy' : 'sell',
          type: 'limit',
          qty: asQty(2),
          limitPrice: asPrice(bar.close),
        } satisfies NewOrder);
      }
    },
    onFill: (fill, ctx) => {
      if (fill.leavesQty !== 0 || fill.tag === 'exit') return;
      ctx.submit({
        instrumentId: fill.instrumentId,
        side: fill.side === 'buy' ? 'sell' : 'buy',
        type: 'stop',
        qty: fill.qty,
        stopPrice: asPrice(fill.side === 'buy' ? fill.price - 3 : fill.price + 3),
        tag: 'exit',
      });
    },
  };
}

function runOptions(overrides: Partial<RunOptions<Record<string, never>>> = {}) {
  return {
    instruments: [TEST_FUTURE],
    strategy: scriptedStrategy,
    params: {},
    initialCash: '100000',
    seed: 7,
    flattenAtEnd: false,
    ...overrides,
  } satisfies RunOptions<Record<string, never>>;
}

/** Splits a chunk the way a live feed delivers it: one bar at a time. */
function perBarEvents(chunk: BarChunk): LiveEvent[] {
  const events: LiveEvent[] = [];
  for (let i = 0; i < chunk.count; i++) {
    events.push({
      kind: 'bars',
      chunk: {
        instrumentId: chunk.instrumentId,
        timeframe: chunk.timeframe,
        count: 1,
        openTs: chunk.openTs.subarray(i, i + 1),
        closeTs: chunk.closeTs.subarray(i, i + 1),
        open: chunk.open.subarray(i, i + 1),
        high: chunk.high.subarray(i, i + 1),
        low: chunk.low.subarray(i, i + 1),
        close: chunk.close.subarray(i, i + 1),
        volume: chunk.volume.subarray(i, i + 1),
      },
    });
  }
  return events;
}

const ROWS: readonly BarRow[] = [
  { o: 100, h: 104, l: 99, c: 103 },
  { o: 103, h: 106, l: 101, c: 102 },
  { o: 102, h: 103, l: 96, c: 97 },
  { o: 97, h: 101, l: 95, c: 100 },
  { o: 100, h: 100, l: 92, c: 93 },
  { o: 93, h: 99, l: 92, c: 98 },
  { o: 98, h: 105, l: 97, c: 104 },
  { o: 104, h: 108, l: 103, c: 105 },
  { o: 105, h: 105, l: 98, c: 99 },
];

function fingerprint(fills: readonly OrderFilledEvent[]): string {
  return fills.map((f) => `${f.side}:${String(f.price)}:${String(f.qty)}`).join('|');
}

describe('the live path and the backtest path are the same path', () => {
  it('produces the same fills bar by bar as a single-chunk backtest', async () => {
    const chunk = bars(ROWS);
    const expected = runBacktest(runOptions(), [bars(ROWS)]);

    const session = new LiveSession(runOptions(), {
      sessionId: 'equivalence',
      wallClock: new FakeWallClock(),
    });
    await session.start();
    for (const event of perBarEvents(chunk)) session.receive(event);
    const actual = await session.stop();

    expect(fingerprint(actual.fills)).toBe(fingerprint(expected.fills));
    expect(actual.finalEquity).toBe(expected.finalEquity);
    expect(actual.realizedPnl).toBe(expected.realizedPnl);
    expect(actual.trades.map((t) => t.netPnl)).toEqual(expected.trades.map((t) => t.netPnl));
    expect(actual.fills.length).toBeGreaterThan(0);
  });

  it('gives the same answer for any bar sequence and any chunking of it', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            o: fc.integer({ min: 80, max: 120 }),
            h: fc.integer({ min: 80, max: 130 }),
            l: fc.integer({ min: 70, max: 120 }),
            c: fc.integer({ min: 80, max: 120 }),
          }),
          { minLength: 4, maxLength: 40 },
        ),
        async (raw) => {
          const rows = raw.map((row) => ({
            o: row.o,
            c: row.c,
            h: Math.max(row.h, row.o, row.c),
            l: Math.min(row.l, row.o, row.c),
          }));
          const expected = runBacktest(runOptions(), [bars(rows)]);
          const session = new LiveSession(runOptions(), {
            sessionId: 'property',
            wallClock: new FakeWallClock(),
          });
          await session.start();
          for (const event of perBarEvents(bars(rows))) session.receive(event);
          const actual = await session.stop();

          expect(fingerprint(actual.fills)).toBe(fingerprint(expected.fills));
          expect(actual.finalEquity).toBe(expected.finalEquity);
        },
      ),
      { numRuns: 40 },
    );
  });

  it('replays a recorded event sequence into an identical session', async () => {
    const recorded: LiveEvent[] = [];
    const first = new LiveSession(runOptions(), {
      sessionId: 'record',
      wallClock: new FakeWallClock(),
      onEvent: (event) => recorded.push(event),
    });
    await first.start();
    const clock = new FakeWallClock();
    for (const event of perBarEvents(bars(ROWS))) {
      first.receive(event);
      clock.current = asTimestamp(clock.current + 30 * MICROS_PER_SECOND);
      first.receive({ kind: 'heartbeat', ts: clock.current });
    }
    const original = await first.stop();

    const second = new LiveSession(runOptions(), {
      sessionId: 'replay',
      wallClock: new FakeWallClock(),
    });
    await second.start();
    for (const event of recorded) second.receive(event);
    const replayed = await second.stop();

    expect(fingerprint(replayed.fills)).toBe(fingerprint(original.fills));
    expect(replayed.finalEquity).toBe(original.finalEquity);
  });
});

describe('the queue', () => {
  it('processes events in arrival order, whatever the drain schedule', async () => {
    const events = perBarEvents(bars(ROWS));
    const expected = runBacktest(runOptions(), [bars(ROWS)]);

    const session = new LiveSession(runOptions(), {
      sessionId: 'batched',
      wallClock: new FakeWallClock(),
    });
    await session.start();
    // Enqueue several before draining: a burst after a slow strategy is the normal live case.
    for (const [i, event] of events.entries()) {
      session.enqueue(event);
      if (i % 3 === 2) session.drain();
    }
    const actual = await session.stop();

    expect(fingerprint(actual.fills)).toBe(fingerprint(expected.fills));
  });

  it('refuses events instead of dropping them when it is full', async () => {
    const session = new LiveSession(runOptions(), {
      sessionId: 'full',
      wallClock: new FakeWallClock(),
      maxQueueDepth: 3,
    });
    await session.start();
    const events = perBarEvents(bars(ROWS));

    const accepted = events.map((event) => session.enqueue(event));
    expect(accepted.slice(0, 3)).toEqual([true, true, true]);
    expect(accepted.slice(3).every((ok) => !ok)).toBe(true);
    expect(session.stats.rejected).toBe(events.length - 3);
    expect(session.stats.maxQueueDepth).toBe(3);
    expect(session.warnings().join(' ')).toContain('refused');

    // What was accepted is intact and in order: refusal never reorders the tape.
    expect(session.drain()).toBe(3);
    await session.stop();
  });

  it('accepts again once the queue has been drained', async () => {
    const session = new LiveSession(runOptions(), {
      sessionId: 'recovers',
      wallClock: new FakeWallClock(),
      maxQueueDepth: 2,
    });
    await session.start();
    const events = perBarEvents(bars(ROWS));

    expect(events.slice(0, 2).map((e) => session.enqueue(e))).toEqual([true, true]);
    expect(session.enqueue(events[2]!)).toBe(false);
    session.drain();
    expect(session.enqueue(events[2]!)).toBe(true);
    await session.stop();
  });

  it('refuses to be drained from inside a drain', async () => {
    const session = new LiveSession(
      runOptions({
        strategy: () => ({
          id: 'reentrant',
          onInit: () => undefined,
          onBar: () => {
            session.drain();
          },
        }),
      }),
      { sessionId: 'reentrant', wallClock: new FakeWallClock() },
    );
    await session.start();
    expect(() => {
      session.receive(perBarEvents(bars(ROWS))[0]!);
    }).toThrow(/reentrant/);
  });
});

describe('time between events', () => {
  it('activates a latency-delayed order on a heartbeat, with no market data', async () => {
    const clock = new FakeWallClock();
    const session = new LiveSession(
      runOptions({
        execution: { latency: fixedLatency(90 * MICROS_PER_SECOND) },
        strategy: () => ({
          id: 'one-order',
          onInit: () => undefined,
          onBar: (bar, ctx) => {
            if (bar.index !== 0) return;
            ctx.submit({
              instrumentId: bar.instrumentId,
              side: 'buy',
              type: 'limit',
              qty: asQty(1),
              limitPrice: asPrice(50),
            });
          },
        }),
      }),
      { sessionId: 'heartbeat', wallClock: clock },
    );
    await session.start();
    session.receive(perBarEvents(bars(ROWS))[0]!);

    const pending = session.engine.paperState('heartbeat').openOrders[0];
    expect(pending?.status).toBe('pending');

    // Two minutes of silence. The order's latency elapsed inside it and nothing else did.
    session.receive({ kind: 'heartbeat', ts: asTimestamp(pending!.activeFrom + 1) });
    expect(session.engine.paperState('heartbeat').openOrders[0]?.status).toBe('working');
    expect(session.stats.heartbeats).toBe(1);
    await session.stop();
  });

  it('reports lag against the wall clock without letting it reach the kernel', async () => {
    const clock = new FakeWallClock();
    const session = new LiveSession(runOptions(), { sessionId: 'lag', wallClock: clock });
    await session.start();
    const events = perBarEvents(bars(ROWS, { startTs: 0, timeframe: MICROS_PER_MINUTE }));

    clock.current = asTimestamp(MICROS_PER_MINUTE + 2 * MICROS_PER_SECOND);
    session.receive(events[0]!);
    expect(session.stats.lastLagMicros).toBe(2 * MICROS_PER_SECOND);

    clock.current = asTimestamp(2 * MICROS_PER_MINUTE + 9 * MICROS_PER_SECOND);
    session.receive(events[1]!);
    expect(session.stats.maxLagMicros).toBe(9 * MICROS_PER_SECOND);
    expect(session.warnings().join(' ')).toContain('worst lag');

    // The engine's own clock is still event time: the strategy saw bar close, not 09s later.
    expect(session.engine.paperState('lag').lastEventTs).toBe(2 * MICROS_PER_MINUTE);
    await session.stop();
  });

  it('counts what a reconnection missed', async () => {
    const session = new LiveSession(runOptions(), {
      sessionId: 'gap',
      wallClock: new FakeWallClock(),
    });
    await session.start();
    session.noteStatus({ kind: 'disconnected', reason: '1006' });
    session.noteStatus({ kind: 'gap', sinceMicros: 12 * MICROS_PER_SECOND });

    expect(session.stats.disconnections).toBe(1);
    expect(session.stats.gaps).toBe(1);
    expect(session.warnings().join(' ')).toContain('12.0s of tape unseen');
    await session.stop();
  });
});

describe('crash recovery', () => {
  /** Runs `count` bars of a session, then abandons it without stopping it — as a crash would. */
  async function crashAfter(
    store: Store,
    count: number,
  ): Promise<LiveSession<Record<string, never>>> {
    const session = new LiveSession(runOptions(), {
      sessionId: 'crashy',
      wallClock: new FakeWallClock(),
      store,
      snapshotEvery: 1,
    });
    await session.start();
    for (const event of perBarEvents(bars(ROWS)).slice(0, count)) {
      session.receive(event);
      await session.flush();
    }
    return session;
  }

  it('comes back with the same cash, positions and resting orders', async () => {
    const store = memoryStore();
    // Four bars in, the strategy is short with a stop resting above it: the interesting crash.
    const crashed = await crashAfter(store, 4);
    const before = crashed.engine.paperState('crashy');
    expect(before.positions).toHaveLength(1);
    expect(before.openOrders).toHaveLength(1);

    const resumed = new LiveSession(runOptions(), {
      sessionId: 'crashy',
      wallClock: new FakeWallClock(),
      store,
    });
    expect(await resumed.start()).toBe(true);

    const after = resumed.engine.paperState('crashy');
    expect(after.cash).toBe(before.cash);
    expect(after.positions).toEqual(before.positions);
    expect(after.openOrders).toEqual(before.openOrders);
    expect(after.counters).toEqual(before.counters);
    expect(resumed.warnings().join(' ')).toContain('resumed');
    await resumed.stop();
  });

  it('finishes the run the crashed session was in the middle of', async () => {
    const store = memoryStore();
    const uninterrupted = new LiveSession(runOptions(), {
      sessionId: 'whole',
      wallClock: new FakeWallClock(),
    });
    await uninterrupted.start();
    for (const event of perBarEvents(bars(ROWS))) uninterrupted.receive(event);
    const expected = await uninterrupted.stop();

    await crashAfter(store, 5);
    const resumed = new LiveSession(runOptions(), {
      sessionId: 'crashy',
      wallClock: new FakeWallClock(),
      store,
    });
    await resumed.start();
    for (const event of perBarEvents(bars(ROWS)).slice(5)) resumed.receive(event);
    const actual = await resumed.stop();

    // The account is whole even though half of it was rebuilt from a snapshot: equity is the sum
    // of a life the second process never saw and the fills it made itself.
    expect(actual.finalEquity).toBe(expected.finalEquity);
  });

  it('never hands a restarted session an order or fill id it has already used', async () => {
    const store = memoryStore();
    const crashed = await crashAfter(store, 6);
    const usedFills = crashed.engine.paperState('crashy').counters.nextFillId;

    const resumed = new LiveSession(runOptions(), {
      sessionId: 'crashy',
      wallClock: new FakeWallClock(),
      store,
    });
    await resumed.start();
    for (const event of perBarEvents(bars(ROWS)).slice(6)) resumed.receive(event);
    const result = await resumed.stop();

    for (const fill of result.fills) expect(fill.fillId).toBeGreaterThanOrEqual(usedFills);
  });

  it('refuses market data the restored session has already acted on', async () => {
    const store = memoryStore();
    await crashAfter(store, 5);
    const resumed = new LiveSession(runOptions(), {
      sessionId: 'crashy',
      wallClock: new FakeWallClock(),
      store,
    });
    await resumed.start();

    expect(() => {
      resumed.receive(perBarEvents(bars(ROWS))[0]!);
    }).toThrow();
  });

  it('reports the fills the snapshot did not include', async () => {
    const store = memoryStore();
    const session = new LiveSession(runOptions(), {
      sessionId: 'window',
      wallClock: new FakeWallClock(),
      store,
      // Never snapshot on its own: every fill written after the initial state is a lost fill.
      snapshotEvery: 1_000_000,
    });
    await session.start();
    await session.snapshot();
    for (const event of perBarEvents(bars(ROWS))) {
      session.receive(event);
      await session.flush();
    }

    const resumed = new LiveSession(runOptions(), {
      sessionId: 'window',
      wallClock: new FakeWallClock(),
      store,
    });
    await resumed.start();
    expect(resumed.stats.fillsAfterSnapshot).toBeGreaterThan(0);
    expect(resumed.warnings().join(' ')).toContain('window the previous crash lost');
    await resumed.stop();
  });

  it('restores the account and not the strategy: a strategy that remembers starts over', async () => {
    const store = memoryStore();
    const seen: number[] = [];
    // Counts bars in a field, which is exactly what does not survive. The engine has no way to
    // serialise a closure, and pretending otherwise would be worse than saying so.
    const counting = () => {
      let count = 0;
      return {
        id: 'counter',
        onInit: () => undefined,
        onBar: () => {
          count++;
          seen.push(count);
        },
      } satisfies Strategy;
    };

    const first = new LiveSession(runOptions({ strategy: counting }), {
      sessionId: 'memory',
      wallClock: new FakeWallClock(),
      store,
      snapshotEvery: 1,
    });
    await first.start();
    for (const event of perBarEvents(bars(ROWS)).slice(0, 4)) {
      first.receive(event);
      await first.flush();
    }
    expect(seen).toEqual([1, 2, 3, 4]);

    const resumed = new LiveSession(runOptions({ strategy: counting }), {
      sessionId: 'memory',
      wallClock: new FakeWallClock(),
      store,
    });
    await resumed.start();
    seen.length = 0;
    for (const event of perBarEvents(bars(ROWS)).slice(4, 6)) resumed.receive(event);
    expect(seen).toEqual([1, 2]);
    await resumed.stop();
  });

  it('refuses a snapshot from a different configuration', async () => {
    const store = memoryStore();
    await crashAfter(store, 3);

    const wrongCash = new LiveSession(runOptions({ initialCash: '50000' }), {
      sessionId: 'crashy',
      wallClock: new FakeWallClock(),
      store,
    });
    await expect(wrongCash.start()).rejects.toThrow(/different balance/);
  });
});

describe('the live surface on the engine itself', () => {
  it('refuses to restore after data has been fed', () => {
    const engine = new Engine(runOptions());
    engine.feedBars(bars(ROWS));
    expect(() => {
      engine.restore(engine.paperState('x'));
    }).toThrow(/before any market data/);
  });

  it('ignores a heartbeat that would move time backwards', () => {
    const engine = new Engine(runOptions());
    engine.feedBars(bars(ROWS));
    const at = engine.paperState('x').lastEventTs;
    engine.advanceTo(asTimestamp(at - 1_000));
    expect(engine.paperState('x').lastEventTs).toBe(at);
  });

  it('refuses to advance after the run has finished', () => {
    const engine = new Engine(runOptions());
    engine.feedBars(bars(ROWS));
    engine.finish();
    expect(() => {
      engine.advanceTo(asTimestamp(10 ** 12));
    }).toThrow(/after finish/);
  });
});
