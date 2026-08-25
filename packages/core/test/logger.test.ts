import { describe, expect, it } from 'vitest';
import { BufferedLogger, SimulatedClock, asTimestamp } from '@tapedeck/core';

function loggerAt(ts: number, options?: ConstructorParameters<typeof BufferedLogger>[1]) {
  const clock = new SimulatedClock(asTimestamp(ts));
  return { clock, logger: new BufferedLogger(clock, options ?? {}) };
}

describe('buffered logger', () => {
  it('stamps entries with simulated time, not wall time', () => {
    const { clock, logger } = loggerAt(1_000);
    logger.info('first');
    clock.advanceTo(asTimestamp(5_000));
    logger.info('second');
    expect(logger.records.map((r) => r.ts)).toEqual([1_000, 5_000]);
  });

  it('drops entries below the configured level without allocating them', () => {
    const { logger } = loggerAt(0, { level: 'warn' });
    logger.debug('no');
    logger.info('no');
    logger.warn('yes');
    logger.error('also yes');
    expect(logger.records.map((r) => r.level)).toEqual(['warn', 'error']);
  });

  it('keeps structured fields alongside the message', () => {
    const { logger } = loggerAt(0);
    logger.info('order placed', { orderId: 7 });
    expect(logger.records[0]?.fields).toEqual({ orderId: 7 });
    logger.info('no fields');
    expect(logger.records[1]?.fields).toBeNull();
  });

  it('caps the buffer and counts what it dropped', () => {
    const { logger } = loggerAt(0, { maxEntries: 3 });
    for (let i = 0; i < 10; i++) logger.info(`entry ${String(i)}`);
    expect(logger.records).toHaveLength(3);
    expect(logger.droppedCount).toBe(7);
  });
});
