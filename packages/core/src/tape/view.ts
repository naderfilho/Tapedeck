/**
 * Reused market-data views and the guard that keeps them honest (ADR-0004).
 *
 * The engine refills one object per bar instead of allocating one. That is the difference between
 * roughly 300k and roughly 1M bars per second, and it costs exactly one rule: a strategy must not
 * keep the object after its callback returns.
 *
 * Rather than trust the rule, `guarded` mode — the default outside production, and always under
 * test — hands out a revocable `Proxy` and revokes it when the callback returns. Code that stashed
 * the reference and reads it on the next bar throws a `TypeError` on the line that did it, instead
 * of quietly reading a bar from the future.
 */

import { EventKind, type BarEvent, type TickEvent } from '../events/events.ts';
import type { InstrumentId } from '../instrument.ts';
import type { PriceInt, QtyInt } from '../math/fixed.ts';
import type { Timestamp } from '../time/timestamp.ts';
import type { Side } from '../execution/types.ts';
import { IllegalStateError } from '../util/errors.ts';

/**
 * - `reuse` — hand out the shared object. Fastest, and unsafe if a strategy misbehaves.
 * - `guarded` — revocable proxy per callback. Default outside production.
 * - `copy` — a frozen snapshot per callback. Safe, allocates, roughly 2.5x slower.
 */
export type ViewMode = 'reuse' | 'guarded' | 'copy';

export class MutableBarView implements BarEvent {
  readonly kind = EventKind.Bar;
  instrumentId: InstrumentId = 0 as InstrumentId;
  ts: Timestamp = 0 as Timestamp;
  seq = 0;
  openTs: Timestamp = 0 as Timestamp;
  closeTs: Timestamp = 0 as Timestamp;
  open: PriceInt = 0 as PriceInt;
  high: PriceInt = 0 as PriceInt;
  low: PriceInt = 0 as PriceInt;
  close: PriceInt = 0 as PriceInt;
  volume: QtyInt = 0 as QtyInt;
  index = 0;
}

export class MutableTickView implements TickEvent {
  readonly kind = EventKind.Tick;
  instrumentId: InstrumentId = 0 as InstrumentId;
  ts: Timestamp = 0 as Timestamp;
  seq = 0;
  price: PriceInt = 0 as PriceInt;
  size: QtyInt = 0 as QtyInt;
  aggressor: Side | null = null;
  index = 0;
}

function snapshotBar(view: MutableBarView): BarEvent {
  return Object.freeze({
    kind: view.kind,
    instrumentId: view.instrumentId,
    ts: view.ts,
    seq: view.seq,
    openTs: view.openTs,
    closeTs: view.closeTs,
    open: view.open,
    high: view.high,
    low: view.low,
    close: view.close,
    volume: view.volume,
    index: view.index,
  });
}

function snapshotTick(view: MutableTickView): TickEvent {
  return Object.freeze({
    kind: view.kind,
    instrumentId: view.instrumentId,
    ts: view.ts,
    seq: view.seq,
    price: view.price,
    size: view.size,
    aggressor: view.aggressor,
    index: view.index,
  });
}

/**
 * Wraps the handing-out of a reused view to untrusted strategy code.
 *
 * `enter` returns what the strategy sees; `exit` invalidates it. Both are called once per callback
 * and, in `reuse` mode, compile down to nothing meaningful.
 */
export class ViewGate<TPublic extends object, TView extends TPublic> {
  readonly mode: ViewMode;
  private readonly snapshot: (view: TView) => TPublic;
  private revoke: (() => void) | null = null;
  private open = false;

  constructor(mode: ViewMode, snapshot: (view: TView) => TPublic) {
    this.mode = mode;
    this.snapshot = snapshot;
  }

  enter(view: TView): TPublic {
    if (this.open) {
      throw new IllegalStateError('view gate is already open: callbacks must not nest');
    }
    this.open = true;
    switch (this.mode) {
      case 'reuse':
        return view;
      case 'copy':
        return this.snapshot(view);
      case 'guarded': {
        const { proxy, revoke } = Proxy.revocable<TView>(view, {});
        this.revoke = revoke;
        return proxy;
      }
    }
  }

  exit(): void {
    this.open = false;
    if (this.revoke !== null) {
      this.revoke();
      this.revoke = null;
    }
  }
}

export function createBarGate(mode: ViewMode): ViewGate<BarEvent, MutableBarView> {
  return new ViewGate<BarEvent, MutableBarView>(mode, snapshotBar);
}

export function createTickGate(mode: ViewMode): ViewGate<TickEvent, MutableTickView> {
  return new ViewGate<TickEvent, MutableTickView>(mode, snapshotTick);
}
