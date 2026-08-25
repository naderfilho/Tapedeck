import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { IllegalStateError, InternalError, LiveClock } from '@tapedeck/core';
import { MinHeap } from '../src/util/heap.ts';
import { assertNever, invariant, unreachable } from '../src/util/assert.ts';

describe('assertions', () => {
  it('passes through when the invariant holds and throws a typed error when it does not', () => {
    expect(() => {
      invariant(true, 'fine');
    }).not.toThrow();
    expect(() => {
      invariant(false, 'broken');
    }).toThrow(IllegalStateError);
    expect(() => {
      invariant(false, 'broken');
    }).toThrow('broken');
  });

  it('reports an unreachable branch as an internal bug, not a user error', () => {
    expect(() => unreachable()).toThrow(InternalError);
    expect(() => unreachable('column missing')).toThrow('column missing');
    expect(() => assertNever('surprise' as never)).toThrow(InternalError);
  });
});

describe('MinHeap', () => {
  it('pops in composite key order', () => {
    const heap = new MinHeap<string>();
    heap.push(2, 0, 'b');
    heap.push(1, 1, 'a2');
    heap.push(1, 0, 'a1');
    heap.push(3, 0, 'c');

    expect(heap.size).toBe(4);
    expect(heap.peekKeyA()).toBe(1);
    expect(heap.peek()).toBe('a1');
    expect([heap.pop(), heap.pop(), heap.pop(), heap.pop()]).toEqual(['a1', 'a2', 'b', 'c']);
    expect(heap.pop()).toBeUndefined();
    expect(heap.peekKeyA()).toBeUndefined();
  });

  it('clears everything', () => {
    const heap = new MinHeap<number>();
    heap.push(1, 0, 1);
    heap.clear();
    expect(heap.size).toBe(0);
  });

  it('sorts any sequence of keys', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 100 })), {
          maxLength: 300,
        }),
        (pairs) => {
          const heap = new MinHeap<[number, number]>();
          for (const pair of pairs) heap.push(pair[0], pair[1], pair);
          const popped: [number, number][] = [];
          for (;;) {
            const next = heap.pop();
            if (next === undefined) break;
            popped.push(next);
          }
          const expected = [...pairs].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
          expect(popped).toEqual(expected);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('LiveClock', () => {
  it('reads wall time in microseconds', () => {
    const clock = new LiveClock();
    expect(clock.kind).toBe('live');
    const before = Date.now() * 1000;
    const now = clock.now();
    const after = Date.now() * 1000 + 1000;
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});
