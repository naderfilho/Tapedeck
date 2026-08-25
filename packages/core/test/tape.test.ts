import { describe, expect, it } from 'vitest';
import {
  type InstrumentId,
  BarChunkBuilder,
  IllegalStateError,
  MutableBarView,
  MutableTickView,
  TickChunkBuilder,
  asDuration,
  createBarGate,
  createTickGate,
  validateBarChunk,
} from '@tapedeck/core';

const ZERO = 0 as InstrumentId;

describe('BarChunkBuilder', () => {
  it('grows past its initial capacity without losing a row', () => {
    const builder = new BarChunkBuilder(ZERO, asDuration(60), 2);
    for (let i = 0; i < 100; i++) builder.push(i * 60, (i + 1) * 60, 10, 12, 8, 11, 5);
    const chunk = builder.build();

    expect(chunk.count).toBe(100);
    expect(builder.count).toBe(100);
    expect(chunk.open).toHaveLength(100);
    expect(chunk.closeTs[99]).toBe(6_000);
    expect(() => {
      validateBarChunk(chunk);
    }).not.toThrow();
  });

  it('produces an empty chunk when nothing was pushed', () => {
    const chunk = new BarChunkBuilder(ZERO, asDuration(60)).build();
    expect(chunk.count).toBe(0);
    expect(() => {
      validateBarChunk(chunk);
    }).not.toThrow();
  });
});

describe('TickChunkBuilder', () => {
  it('grows past its initial capacity and keeps the aggressor column aligned', () => {
    const builder = new TickChunkBuilder(ZERO, 1);
    for (let i = 0; i < 50; i++) builder.push(i, 100 + i, 1, i % 2 === 0 ? 1 : -1);
    const chunk = builder.build();

    expect(chunk.count).toBe(50);
    expect(chunk.price[49]).toBe(149);
    expect(chunk.aggressor[0]).toBe(1);
    expect(chunk.aggressor[1]).toBe(-1);
    expect(chunk.aggressor).toHaveLength(50);
  });

  it('defaults the aggressor to unknown', () => {
    const builder = new TickChunkBuilder(ZERO);
    builder.push(1, 100, 5);
    expect(builder.build().aggressor[0]).toBe(0);
  });
});

describe('validateBarChunk', () => {
  it('accepts a chunk that continues where the previous one ended', () => {
    const builder = new BarChunkBuilder(ZERO, asDuration(60), 2);
    builder.push(600, 660, 10, 10, 10, 10, 1);
    expect(() => {
      validateBarChunk(builder.build(), 600);
    }).not.toThrow();
  });

  it('rejects a bar whose close is not after its open', () => {
    const builder = new BarChunkBuilder(ZERO, asDuration(60), 1);
    builder.push(600, 600, 10, 10, 10, 10, 1);
    expect(() => {
      validateBarChunk(builder.build());
    }).toThrow(/closeTs must be after openTs/);
  });

  it('rejects negative volume', () => {
    const builder = new BarChunkBuilder(ZERO, asDuration(60), 1);
    builder.push(0, 60, 10, 10, 10, 10, -1);
    expect(() => {
      validateBarChunk(builder.build());
    }).toThrow(/negative volume/);
  });
});

describe('view gates', () => {
  it('refuses to open twice, which would mean callbacks were nesting', () => {
    const gate = createBarGate('guarded');
    const view = new MutableBarView();
    gate.enter(view);
    expect(() => gate.enter(view)).toThrow(IllegalStateError);
    gate.exit();
    expect(() => gate.enter(view)).not.toThrow();
    gate.exit();
  });

  it('hands back the same object in reuse mode and a fresh one in copy mode', () => {
    const view = new MutableBarView();
    expect(createBarGate('reuse').enter(view)).toBe(view);

    const copyGate = createBarGate('copy');
    const snapshot = copyGate.enter(view);
    copyGate.exit();
    expect(snapshot).not.toBe(view);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('is a no-op to exit a gate that was never entered', () => {
    expect(() => {
      createBarGate('guarded').exit();
    }).not.toThrow();
  });

  it('guards tick views the same way it guards bars', () => {
    const gate = createTickGate('guarded');
    const view = new MutableTickView();
    const guarded = gate.enter(view);
    expect(guarded.price).toBe(0);
    gate.exit();
    expect(() => guarded.price).toThrow(TypeError);
  });

  it('snapshots a tick with all of its fields', () => {
    const gate = createTickGate('copy');
    const view = new MutableTickView();
    view.aggressor = 'buy';
    const snapshot = gate.enter(view);
    gate.exit();
    expect(snapshot.aggressor).toBe('buy');
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});
