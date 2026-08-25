import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { IllegalStateError, SimulatedClock, SimulatedScheduler, asTimestamp } from '@tapedeck/core';

function setup(): { clock: SimulatedClock; scheduler: SimulatedScheduler; fired: string[] } {
  const clock = new SimulatedClock();
  const scheduler = new SimulatedScheduler(clock);
  return { clock, scheduler, fired: [] };
}

describe('simulated clock', () => {
  it('moves forward and reports the time it was moved to', () => {
    const clock = new SimulatedClock();
    expect(clock.now()).toBe(0);
    clock.advanceTo(asTimestamp(500));
    expect(clock.now()).toBe(500);
    clock.advanceTo(asTimestamp(500));
    expect(clock.now()).toBe(500);
  });

  it('refuses to move backwards, so out-of-order data fails loudly', () => {
    const clock = new SimulatedClock(asTimestamp(100));
    expect(() => {
      clock.advanceTo(asTimestamp(99));
    }).toThrow(IllegalStateError);
  });
});

describe('scheduler ordering', () => {
  it('fires in timestamp order', () => {
    const { scheduler, fired } = setup();
    scheduler.at(asTimestamp(30), () => fired.push('c'));
    scheduler.at(asTimestamp(10), () => fired.push('a'));
    scheduler.at(asTimestamp(20), () => fired.push('b'));
    scheduler.drainUpTo(asTimestamp(100));
    expect(fired).toEqual(['a', 'b', 'c']);
  });

  it('breaks ties by registration order, which is what makes the order total', () => {
    const { scheduler, fired } = setup();
    for (const label of ['first', 'second', 'third']) {
      scheduler.at(asTimestamp(50), () => fired.push(label));
    }
    scheduler.drainUpTo(asTimestamp(50));
    expect(fired).toEqual(['first', 'second', 'third']);
  });

  it('leaves timers beyond the drain horizon pending', () => {
    const { scheduler, fired } = setup();
    scheduler.at(asTimestamp(10), () => fired.push('now'));
    scheduler.at(asTimestamp(1000), () => fired.push('later'));
    expect(scheduler.drainUpTo(asTimestamp(500))).toBe(1);
    expect(fired).toEqual(['now']);
    expect(scheduler.pending).toBe(1);
  });

  it('sets the clock to each timer own timestamp before firing it', () => {
    const { clock, scheduler, fired } = setup();
    scheduler.at(asTimestamp(10), () => fired.push(String(clock.now())));
    scheduler.at(asTimestamp(20), () => fired.push(String(clock.now())));
    scheduler.drainUpTo(asTimestamp(100));
    expect(fired).toEqual(['10', '20']);
  });

  it('runs timers scheduled by a timer inside the same drain when they are due', () => {
    const { scheduler, fired } = setup();
    scheduler.at(asTimestamp(10), () => {
      fired.push('outer');
      scheduler.at(asTimestamp(15), () => fired.push('inner'));
    });
    scheduler.drainUpTo(asTimestamp(50));
    expect(fired).toEqual(['outer', 'inner']);
  });

  it('does not fire a cancelled timer', () => {
    const { scheduler, fired } = setup();
    const id = scheduler.at(asTimestamp(10), () => fired.push('cancelled'));
    scheduler.at(asTimestamp(20), () => fired.push('kept'));
    expect(scheduler.cancel(id)).toBe(true);
    expect(scheduler.cancel(id)).toBe(false);
    scheduler.drainUpTo(asTimestamp(100));
    expect(fired).toEqual(['kept']);
  });

  it('schedules relative to the current simulated time', () => {
    const { clock, scheduler, fired } = setup();
    clock.advanceTo(asTimestamp(1000));
    scheduler.after(250, () => fired.push(String(clock.now())));
    scheduler.drainUpTo(asTimestamp(2000));
    expect(fired).toEqual(['1250']);
  });

  it('drains any set of timers in non-decreasing timestamp order', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 10_000 }), { maxLength: 200 }), (stamps) => {
        const { scheduler } = setup();
        const seen: number[] = [];
        for (const ts of stamps) scheduler.at(asTimestamp(ts), (firedAt) => seen.push(firedAt));
        scheduler.drainUpTo(asTimestamp(20_000));
        expect(seen).toEqual([...stamps].sort((a, b) => a - b));
      }),
      { numRuns: 100 },
    );
  });
});
