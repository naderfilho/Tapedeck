import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createRng } from '@tapedeck/core';

function draw(seed: number, label?: string, count = 20): number[] {
  const rng = label === undefined ? createRng(seed) : createRng(seed).fork(label);
  return Array.from({ length: count }, () => rng.nextU32());
}

describe('seeded generator', () => {
  it('reproduces its sequence for the same seed', () => {
    expect(draw(1234)).toEqual(draw(1234));
  });

  it('produces a different sequence for a different seed', () => {
    expect(draw(1)).not.toEqual(draw(2));
  });

  it('stays inside the uint32 range and inside [0, 1)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), (seed) => {
        const rng = createRng(seed);
        for (let i = 0; i < 100; i++) {
          const u = rng.nextU32();
          expect(Number.isInteger(u)).toBe(true);
          expect(u).toBeGreaterThanOrEqual(0);
          expect(u).toBeLessThan(2 ** 32);
          const f = rng.nextFloat();
          expect(f).toBeGreaterThanOrEqual(0);
          expect(f).toBeLessThan(1);
        }
      }),
      { numRuns: 25 },
    );
  });

  it('survives a zero seed rather than collapsing to a fixed point', () => {
    const values = draw(0, undefined, 10);
    expect(new Set(values).size).toBeGreaterThan(1);
  });

  it('keeps nextInt inside its half-open range', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: 1, max: 500 }),
        (min, span) => {
          const rng = createRng(99);
          for (let i = 0; i < 50; i++) {
            const v = rng.nextInt(min, min + span);
            expect(v).toBeGreaterThanOrEqual(min);
            expect(v).toBeLessThan(min + span);
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  it('returns the lower bound when the range is empty', () => {
    expect(createRng(5).nextInt(10, 10)).toBe(10);
  });
});

describe('forked streams', () => {
  it('gives each label its own reproducible sequence', () => {
    expect(draw(7, 'broker')).toEqual(draw(7, 'broker'));
    expect(draw(7, 'broker')).not.toEqual(draw(7, 'strategy'));
  });

  it('is unaffected by how much another fork consumed', () => {
    // The point of forking: adding a component that draws randomness must not shift the numbers
    // another component sees, or every result silently changes when the engine grows a feature.
    const root = createRng(11);
    const broker = root.fork('broker');
    const noisy = root.fork('noisy');
    for (let i = 0; i < 1000; i++) noisy.nextU32();
    const after = Array.from({ length: 10 }, () => broker.nextU32());

    const cleanRoot = createRng(11);
    const cleanBroker = cleanRoot.fork('broker');
    const before = Array.from({ length: 10 }, () => cleanBroker.nextU32());

    expect(after).toEqual(before);
  });

  it('names nested forks by path', () => {
    expect(createRng(1).fork('a').fork('b').label).toBe('root/a/b');
  });
});
