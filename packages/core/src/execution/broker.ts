/**
 * The simulated broker: order lifecycle, matching against market data, and the intrabar policy
 * that decides what to do when a bar hides the answer (ADR-0005).
 *
 * Two rules drive everything here:
 *
 * 1. An order can never match against the bar the decision was made on. Its `activeFrom` is set
 *    when it is submitted and the scheduler moves it into the book at that time, so the earliest
 *    bar it can touch is the next one.
 * 2. When a bar could have filled more than one resting order, the engine does not guess quietly.
 *    It applies the configured policy — pessimistic by default — and counts the bar.
 */

import type { Instrument, InstrumentId, InstrumentRegistry } from '../instrument.ts';
import {
  type PriceInt,
  type QtyInt,
  asMoney,
  asPrice,
  asQty,
  mulMulDiv,
  weightedAverage,
} from '../math/fixed.ts';
import type { ReadonlyClock } from '../time/clock.ts';
import type { Scheduler } from '../time/scheduler.ts';
import type { Timestamp } from '../time/timestamp.ts';
import type { TradingCalendar } from '../time/calendar.ts';
import type { BarEvent, TickEvent } from '../events/events.ts';
import { EventKind } from '../events/events.ts';
import type { Rng } from '../util/rng.ts';
import { IllegalStateError } from '../util/errors.ts';
import type { ExecutionConfig, IntrabarPolicy } from './models.ts';
import { notionalOf } from './models.ts';
import {
  type OrderSnapshot,
  type OrderState,
  createOrderState,
  isOrderStatusLive,
  leavesQty,
  snapshotOrder,
  validateNewOrder,
} from './order.ts';
import type { FillId, Liquidity, NewOrder, OrderAmend, OrderId, Side } from './types.ts';
import type {
  OrderAcceptedEvent,
  OrderAmendedEvent,
  OrderCancelledEvent,
  OrderFilledEvent,
  OrderRejectedEvent,
} from '../events/events.ts';

/** What a strategy may ask of its broker. Identical in backtest and in paper trading. */
export interface Broker {
  submit(request: NewOrder): OrderId;
  cancel(id: OrderId): boolean;
  replace(id: OrderId, amend: OrderAmend): boolean;
  getOrder(id: OrderId): OrderSnapshot | undefined;
  openOrders(instrumentId?: InstrumentId): readonly OrderSnapshot[];
}

/** The engine's hook into the broker. Every callback runs synchronously, in event order. */
export interface BrokerSink {
  onAccepted(event: OrderAcceptedEvent): void;
  onRejected(event: OrderRejectedEvent): void;
  onFilled(event: OrderFilledEvent): void;
  onCancelled(event: OrderCancelledEvent): void;
  onAmended(event: OrderAmendedEvent): void;
}

export interface BrokerStats {
  ordersSubmitted: number;
  ordersRejected: number;
  ordersCancelled: number;
  ordersFilled: number;
  fills: number;
  partialFills: number;
  /**
   * Bars in which two or more resting orders could have filled and the outcome therefore depended
   * on the intrabar path, which an OHLCV bar does not record. Read this next to the trade count:
   * a run where it is a large share of the trades is a run whose numbers are a guess.
   */
  ambiguousBars: number;
  /** Stop-limit orders that triggered inside a bar and had their limit deferred to the next one. */
  stopLimitDeferrals: number;
  /** Orders whose configured latency was shorter than one bar and therefore could not be honoured. */
  subBarLatencyIgnored: number;
  ordersAmended: number;
  /** Legs reduced or cancelled because an OCO sibling filled. */
  ocoReductions: number;
}

export interface SimulatedBrokerOptions {
  readonly registry: InstrumentRegistry;
  readonly clock: ReadonlyClock;
  readonly scheduler: Scheduler;
  readonly execution: ExecutionConfig;
  readonly rng: Rng;
  readonly sink: BrokerSink;
  /** Decides when a `day` order dies. `ALWAYS_OPEN` reproduces the pre-calendar behaviour. */
  readonly calendar: TradingCalendar;
  /** Supplies the monotonic sequence that gives every event its place in the total order. */
  readonly nextSeq: () => number;
}

interface Candidate {
  readonly order: OrderState;
  /** Price before slippage. */
  readonly referencePrice: PriceInt;
  readonly liquidity: Liquidity;
  /** Sort key: which leg of the assumed path the fill sits on, then distance along that leg. */
  readonly leg: number;
  readonly distance: number;
  /**
   * How much worse than the bar's open this fill is *for this order's side*: a buy above the open
   * or a sell below it is adverse. Comparable across sides, which a raw price is not — that is
   * what makes "execute the worst one first" a well-defined instruction.
   */
  readonly adversity: number;
}

export class SimulatedBroker implements Broker {
  private readonly registry: InstrumentRegistry;
  private readonly clock: ReadonlyClock;
  private readonly scheduler: Scheduler;
  private readonly execution: ExecutionConfig;
  private readonly rng: Rng;
  private readonly sink: BrokerSink;
  private readonly calendar: TradingCalendar;
  private readonly nextSeq: () => number;

  private readonly orders = new Map<OrderId, OrderState>();
  /** Live orders per instrument. Dense array: most runs touch one or two instruments. */
  private readonly working: OrderState[][] = [];
  private readonly candidates: Candidate[] = [];

  private nextOrderId = 1;
  private nextFillId = 1;
  private submitSeq = 0;

  readonly stats: BrokerStats = {
    ordersSubmitted: 0,
    ordersRejected: 0,
    ordersCancelled: 0,
    ordersFilled: 0,
    fills: 0,
    partialFills: 0,
    ambiguousBars: 0,
    stopLimitDeferrals: 0,
    subBarLatencyIgnored: 0,
    ordersAmended: 0,
    ocoReductions: 0,
  };

  constructor(options: SimulatedBrokerOptions) {
    this.registry = options.registry;
    this.clock = options.clock;
    this.scheduler = options.scheduler;
    this.execution = options.execution;
    this.rng = options.rng;
    this.sink = options.sink;
    this.calendar = options.calendar;
    this.nextSeq = options.nextSeq;
    for (let i = 0; i < this.registry.size; i++) this.working.push([]);
  }

  // ---------------------------------------------------------------- order entry

  submit(request: NewOrder): OrderId {
    const id = this.nextOrderId++ as OrderId;
    const now = this.clock.now();
    this.stats.ordersSubmitted++;

    const instrument = this.registry.all()[request.instrumentId];
    if (instrument === undefined) {
      this.reject(
        id,
        request.tag ?? null,
        'unknown_instrument',
        `no instrument with id ${String(request.instrumentId)}`,
      );
      return id;
    }
    const rejection = validateNewOrder(request, instrument);
    if (rejection !== null) {
      this.reject(id, request.tag ?? null, rejection.reason, rejection.detail);
      return id;
    }

    const delay = this.execution.latency.delayMicros(this.rng);
    const activeFrom = (now + delay) as Timestamp;
    const order = createOrderState({
      id,
      request,
      submittedTs: now,
      submitSeq: this.submitSeq++,
      activeFrom,
      nextClose: this.calendar.nextClose(now),
    });
    this.orders.set(id, order);

    const accepted: OrderAcceptedEvent = {
      kind: EventKind.OrderAccepted,
      ts: now,
      seq: this.nextSeq(),
      orderId: id,
      instrumentId: order.instrumentId,
      side: order.side,
      type: order.type,
      qty: order.qty,
      limitPrice: order.limitPrice,
      stopPrice: order.stopPrice,
      tif: order.tif,
      tag: order.tag,
      activeFrom,
    };
    this.sink.onAccepted(accepted);

    this.scheduler.at(activeFrom, () => {
      if (order.status !== 'pending') return;
      order.status = 'working';
      this.bookOf(order.instrumentId).push(order);
    });

    return id;
  }

  cancel(id: OrderId): boolean {
    const order = this.orders.get(id);
    if (order === undefined || !isOrderStatusLive(order.status)) return false;
    this.finishCancel(order, 'requested');
    return true;
  }

  /** Where the id counters stand, so a restarted session continues them instead of reusing them. */
  counters(): { readonly nextOrderId: number; readonly nextFillId: number } {
    return { nextOrderId: this.nextOrderId, nextFillId: this.nextFillId };
  }

  /**
   * Rebuilds the book from a snapshot, for a paper session restarting after a crash.
   *
   * No acceptance event is emitted and no strategy hook fires: these orders were accepted before
   * the crash, and telling the strategy about them again would be telling it something happened
   * twice. An order still waiting out its latency gets its activation timer re-armed, because the
   * scheduler died with the process while `activeFrom` did not.
   */
  restore(
    orders: readonly OrderSnapshot[],
    counters: { readonly nextOrderId: number; readonly nextFillId: number },
  ): void {
    if (this.orders.size > 0) {
      throw new IllegalStateError('cannot restore a broker that has already accepted orders');
    }
    this.nextOrderId = counters.nextOrderId;
    this.nextFillId = counters.nextFillId;

    for (const snapshot of orders) {
      const order: OrderState = {
        id: snapshot.id,
        instrumentId: snapshot.instrumentId,
        side: snapshot.side,
        type: snapshot.type,
        tif: snapshot.tif,
        tag: snapshot.tag,
        oco: snapshot.oco,
        submittedTs: snapshot.submittedTs,
        submitSeq: this.submitSeq++,
        expiresAt: snapshot.tif === 'day' ? this.calendar.nextClose(snapshot.submittedTs) : null,
        qty: snapshot.qty,
        limitPrice: snapshot.limitPrice,
        stopPrice: snapshot.stopPrice,
        status: snapshot.status,
        filledQty: snapshot.filledQty,
        avgFillPrice: snapshot.avgFillPrice,
        activeFrom: snapshot.activeFrom,
        triggered: snapshot.triggered,
        latencyCounted: true,
      };
      this.orders.set(order.id, order);
      if (!isOrderStatusLive(order.status)) continue;

      if (order.status === 'pending') {
        this.scheduler.at(order.activeFrom, () => {
          if (order.status !== 'pending') return;
          order.status = 'working';
          this.bookOf(order.instrumentId).push(order);
        });
      } else {
        this.bookOf(order.instrumentId).push(order);
      }
    }
  }

  /**
   * Amends an order in place, keeping its id and its queue position.
   *
   * Validation happens before anything changes, so a rejected amendment leaves the order exactly
   * as it was rather than half-applied — a limit that moved while the quantity did not is a state
   * no venue would have produced.
   */
  replace(id: OrderId, amend: OrderAmend): boolean {
    const order = this.orders.get(id);
    if (order === undefined || !isOrderStatusLive(order.status)) return false;
    const instrument = this.registry.byId(order.instrumentId);

    if (amend.qty !== undefined) {
      if (amend.qty <= order.filledQty || amend.qty % instrument.lotSize !== 0) return false;
    }
    if (amend.limitPrice !== undefined) {
      if (order.limitPrice === null || amend.limitPrice % instrument.tickSize !== 0) return false;
    }
    if (amend.stopPrice !== undefined) {
      if (order.stopPrice === null || amend.stopPrice % instrument.tickSize !== 0) return false;
    }

    this.applyAmend(order, amend, 'requested');
    return true;
  }

  /** Changes an order and emits the record of it. Callers validate first. */
  private applyAmend(order: OrderState, amend: OrderAmend, reason: 'requested' | 'oco'): void {
    const previousQty = order.qty;
    const previousLimitPrice = order.limitPrice;
    const previousStopPrice = order.stopPrice;

    if (amend.qty !== undefined) order.qty = amend.qty;
    if (amend.limitPrice !== undefined) order.limitPrice = amend.limitPrice;
    if (amend.stopPrice !== undefined) order.stopPrice = amend.stopPrice;

    this.stats.ordersAmended++;
    this.sink.onAmended({
      kind: EventKind.OrderAmended,
      ts: this.clock.now(),
      seq: this.nextSeq(),
      orderId: order.id,
      instrumentId: order.instrumentId,
      qty: order.qty,
      previousQty,
      limitPrice: order.limitPrice,
      previousLimitPrice,
      stopPrice: order.stopPrice,
      previousStopPrice,
      reason,
      tag: order.tag,
    });
  }

  /**
   * Reduces every other live leg of an OCO group by `filled`.
   *
   * Reduction rather than cancellation, so a partial fill on one leg leaves the other covering
   * exactly what remains. A leg with nothing left is cancelled. This runs the instant the fill is
   * applied, before the next candidate in the same bar is considered — which is the whole point:
   * building a bracket out of a `cancel` inside `onFill` leaves the sibling live for one more
   * candidate, and a bar that touches both levels executes both.
   */
  private reduceOcoSiblings(filled: OrderState, quantity: QtyInt): void {
    const group = filled.oco;
    if (group === null || quantity <= 0) return;

    for (const other of this.orders.values()) {
      if (other === filled || other.oco !== group) continue;
      if (!isOrderStatusLive(other.status)) continue;

      const remaining = leavesQty(other);
      if (remaining <= quantity) {
        this.stats.ocoReductions++;
        this.finishCancel(other, 'oco');
        continue;
      }
      this.stats.ocoReductions++;
      this.applyAmend(other, { qty: asQty(other.qty - quantity) }, 'oco');
    }
  }

  getOrder(id: OrderId): OrderSnapshot | undefined {
    const order = this.orders.get(id);
    return order === undefined ? undefined : snapshotOrder(order);
  }

  openOrders(instrumentId?: InstrumentId): readonly OrderSnapshot[] {
    const out: OrderSnapshot[] = [];
    for (const order of this.orders.values()) {
      if (!isOrderStatusLive(order.status)) continue;
      if (instrumentId !== undefined && order.instrumentId !== instrumentId) continue;
      out.push(snapshotOrder(order));
    }
    return out;
  }

  /** Cancels everything still live. Called when a run ends. */
  cancelAll(reason: OrderCancelledEvent['reason'] = 'run_ended'): void {
    for (const order of this.orders.values()) {
      if (isOrderStatusLive(order.status)) this.finishCancel(order, reason);
    }
  }

  // ---------------------------------------------------------------- matching

  /**
   * Matches resting orders against a closed bar.
   *
   * Runs before the strategy sees the bar, so a stop placed yesterday is honoured before today's
   * decision is taken — the same order of events a live account experiences.
   */
  onBar(bar: BarEvent): void {
    const book = this.bookOf(bar.instrumentId);
    if (book.length === 0) return;
    const instrument = this.registry.byId(bar.instrumentId);
    const candidates = this.candidates;
    candidates.length = 0;

    for (const order of book) {
      if (!isOrderStatusLive(order.status)) continue;
      if (order.expiresAt !== null && bar.closeTs >= order.expiresAt) {
        this.finishCancel(order, 'expired');
        continue;
      }
      if (order.activeFrom > bar.closeTs) continue;
      if (order.activeFrom > bar.openTs && !order.latencyCounted) {
        // The order became matchable somewhere inside this bar. Where exactly is unknowable from
        // OHLCV, so the sub-bar part of the latency is dropped and counted rather than invented.
        order.latencyCounted = true;
        this.stats.subBarLatencyIgnored++;
      }
      const candidate = this.evaluateBar(order, bar);
      if (candidate !== null) candidates.push(candidate);
    }

    if (candidates.length > 1) {
      this.stats.ambiguousBars++;
      sortCandidates(candidates, this.execution.intrabar);
    }

    for (const candidate of candidates) {
      if (!isOrderStatusLive(candidate.order.status)) continue;
      this.executeFill(candidate, instrument, bar.closeTs, bar.volume, asPrice(bar.high - bar.low));
    }

    this.compact(bar.instrumentId);
  }

  /**
   * Matches resting orders against a single print.
   *
   * There is no ambiguity here: a tick is a price at an instant, so latency is honoured exactly and
   * the intrabar policy never comes into play.
   */
  onTick(tick: TickEvent): void {
    const book = this.bookOf(tick.instrumentId);
    if (book.length === 0) return;
    const instrument = this.registry.byId(tick.instrumentId);

    for (const order of book) {
      if (!isOrderStatusLive(order.status)) continue;
      if (order.expiresAt !== null && tick.ts >= order.expiresAt) {
        this.finishCancel(order, 'expired');
        continue;
      }
      if (order.activeFrom > tick.ts) continue;
      const candidate = this.evaluateTick(order, tick);
      if (candidate === null) continue;
      this.executeFill(candidate, instrument, tick.ts, tick.size, asPrice(0));
    }

    this.compact(tick.instrumentId);
  }

  /**
   * Flattens a position at a given price, used when a run ends with an open position.
   * Commission applies; slippage does not, because this is an accounting act, not a market order.
   */
  forceClose(
    instrumentId: InstrumentId,
    side: Side,
    qty: QtyInt,
    price: PriceInt,
    ts: Timestamp,
  ): OrderFilledEvent {
    const instrument = this.registry.byId(instrumentId);
    const notional = notionalOf(instrument, price, qty);
    const commission = this.execution.commission.charge({
      instrument,
      side,
      qty,
      price,
      notional,
      liquidity: 'taker',
    });
    const event: OrderFilledEvent = {
      kind: EventKind.OrderFilled,
      ts,
      seq: this.nextSeq(),
      orderId: 0 as OrderId,
      fillId: this.nextFillId++ as FillId,
      instrumentId,
      side,
      price,
      qty,
      leavesQty: asQty(0),
      commission,
      slippage: asMoney(0),
      liquidity: 'taker',
      tag: 'end-of-run-flatten',
    };
    this.stats.fills++;
    this.sink.onFilled(event);
    return event;
  }

  // ---------------------------------------------------------------- internals

  private bookOf(instrumentId: InstrumentId): OrderState[] {
    let book = this.working[instrumentId];
    if (book === undefined) {
      book = [];
      this.working[instrumentId] = book;
    }
    return book;
  }

  private compact(instrumentId: InstrumentId): void {
    const book = this.bookOf(instrumentId);
    let write = 0;
    for (let read = 0; read < book.length; read++) {
      const order = book[read];
      if (order === undefined) continue;
      if (!isOrderStatusLive(order.status)) continue;
      book[write++] = order;
    }
    book.length = write;
  }

  private reject(
    id: OrderId,
    tag: string | null,
    reason: OrderRejectedEvent['reason'],
    detail: string,
  ): void {
    this.stats.ordersRejected++;
    this.sink.onRejected({
      kind: EventKind.OrderRejected,
      ts: this.clock.now(),
      seq: this.nextSeq(),
      orderId: id,
      reason,
      detail,
      tag,
    });
  }

  private finishCancel(order: OrderState, reason: OrderCancelledEvent['reason']): void {
    order.status = 'cancelled';
    this.stats.ordersCancelled++;
    this.sink.onCancelled({
      kind: EventKind.OrderCancelled,
      ts: this.clock.now(),
      seq: this.nextSeq(),
      orderId: order.id,
      reason,
      leavesQty: leavesQty(order),
      tag: order.tag,
    });
  }

  /**
   * Decides whether `order` could have filled during `bar`, and at what price.
   *
   * A limit order fills at its limit, or at the open when the bar gapped through it — never at a
   * price better than both. A stop fills at its trigger, or at the open on a gap, which is where
   * most of the difference between a backtest and a live account comes from.
   */
  private evaluateBar(order: OrderState, bar: BarEvent): Candidate | null {
    const buy = order.side === 'buy';

    switch (order.type) {
      case 'market':
        return this.makeCandidate(order, bar.open, 'taker', bar);

      case 'limit': {
        const limit = order.limitPrice;
        if (limit === null) return null;
        if (buy ? bar.low <= limit : bar.high >= limit) {
          const price = buy ? Math.min(limit, bar.open) : Math.max(limit, bar.open);
          return this.makeCandidate(order, asPrice(price), 'maker', bar);
        }
        return null;
      }

      case 'stop': {
        const stop = order.stopPrice;
        if (stop === null) return null;
        if (buy ? bar.high >= stop : bar.low <= stop) {
          order.triggered = true;
          const price = buy ? Math.max(stop, bar.open) : Math.min(stop, bar.open);
          return this.makeCandidate(order, asPrice(price), 'taker', bar);
        }
        return null;
      }

      case 'stop_limit': {
        const stop = order.stopPrice;
        const limit = order.limitPrice;
        if (stop === null || limit === null) return null;

        if (!order.triggered) {
          const touched = buy ? bar.high >= stop : bar.low <= stop;
          if (!touched) return null;
          order.triggered = true;
          if (this.execution.intrabar !== 'optimistic') {
            // The trigger happened somewhere inside the bar; whether price then reached the limit
            // *after* triggering is not recorded by OHLCV. The limit rests from the next bar.
            this.stats.stopLimitDeferrals++;
            return null;
          }
        }
        if (buy ? bar.low <= limit : bar.high >= limit) {
          const price = buy ? Math.min(limit, bar.open) : Math.max(limit, bar.open);
          return this.makeCandidate(order, asPrice(price), 'maker', bar);
        }
        return null;
      }
    }
  }

  private evaluateTick(order: OrderState, tick: TickEvent): Candidate | null {
    const buy = order.side === 'buy';
    const price = tick.price;

    switch (order.type) {
      case 'market':
        return this.makeTickCandidate(order, price, 'taker');

      case 'limit': {
        const limit = order.limitPrice;
        if (limit === null) return null;
        if (buy ? price <= limit : price >= limit) {
          return this.makeTickCandidate(
            order,
            asPrice(buy ? Math.min(limit, price) : Math.max(limit, price)),
            'maker',
          );
        }
        return null;
      }

      case 'stop': {
        const stop = order.stopPrice;
        if (stop === null) return null;
        if (buy ? price >= stop : price <= stop) {
          order.triggered = true;
          return this.makeTickCandidate(order, price, 'taker');
        }
        return null;
      }

      case 'stop_limit': {
        const stop = order.stopPrice;
        const limit = order.limitPrice;
        if (stop === null || limit === null) return null;
        if (!order.triggered) {
          if (buy ? price >= stop : price <= stop) order.triggered = true;
          else return null;
        }
        if (buy ? price <= limit : price >= limit) {
          return this.makeTickCandidate(
            order,
            asPrice(buy ? Math.min(limit, price) : Math.max(limit, price)),
            'maker',
          );
        }
        return null;
      }
    }
  }

  private makeCandidate(
    order: OrderState,
    referencePrice: PriceInt,
    liquidity: Liquidity,
    bar: BarEvent,
  ): Candidate {
    const upBar = bar.close >= bar.open;
    const price: number = referencePrice;
    let leg: number;
    let distance: number;
    if (upBar) {
      // Assumed path: open -> low -> high -> close.
      if (price <= bar.open) {
        leg = 0;
        distance = bar.open - price;
      } else {
        leg = 1;
        distance = price - bar.low;
      }
    } else {
      // Assumed path: open -> high -> low -> close.
      if (price >= bar.open) {
        leg = 0;
        distance = price - bar.open;
      } else {
        leg = 1;
        distance = bar.high - price;
      }
    }
    return {
      order,
      referencePrice,
      liquidity,
      leg,
      distance,
      adversity: order.side === 'buy' ? price - bar.open : bar.open - price,
    };
  }

  private makeTickCandidate(
    order: OrderState,
    referencePrice: PriceInt,
    liquidity: Liquidity,
  ): Candidate {
    return {
      order,
      referencePrice,
      liquidity,
      leg: 0,
      distance: 0,
      // A tick is a single price at a single instant: there is nothing to be ambiguous about.
      adversity: 0,
    };
  }

  private executeFill(
    candidate: Candidate,
    instrument: Instrument,
    ts: Timestamp,
    availableVolume: QtyInt,
    barRange: PriceInt,
  ): void {
    const { order, referencePrice, liquidity } = candidate;
    const remaining = leavesQty(order);
    if (remaining <= 0) return;

    const cap = this.execution.liquidity.maxFillQty({
      instrument,
      remainingQty: remaining,
      barVolume: availableVolume,
    });
    const fillQty = asQty(Math.min(remaining, Math.max(cap, 0)));
    if (fillQty <= 0) return;

    if (order.tif === 'fok' && fillQty < remaining) {
      this.finishCancel(order, 'time_in_force');
      return;
    }

    const price = this.execution.slippage.apply({
      instrument,
      side: order.side,
      type: order.type,
      qty: fillQty,
      referencePrice,
      liquidity,
      barRange,
      rng: this.rng,
    });

    const notional = notionalOf(instrument, price, fillQty);
    const commission = this.execution.commission.charge({
      instrument,
      side: order.side,
      qty: fillQty,
      price,
      notional,
      liquidity,
    });

    // Positive means the fill was worse than the price the decision was based on.
    const slipTicks = order.side === 'buy' ? price - referencePrice : referencePrice - price;
    const slippage = asMoney(
      mulMulDiv(slipTicks, fillQty, instrument.pointValue, instrument.notionalDivisor, 'half-up'),
    );

    order.avgFillPrice = asPrice(
      weightedAverage(order.avgFillPrice, order.filledQty, price, fillQty),
    );
    order.filledQty = asQty(order.filledQty + fillQty);
    const leaves = leavesQty(order);
    order.status = leaves === 0 ? 'filled' : 'partially_filled';

    this.stats.fills++;
    if (leaves > 0) this.stats.partialFills++;
    else this.stats.ordersFilled++;

    const event: OrderFilledEvent = {
      kind: EventKind.OrderFilled,
      ts,
      seq: this.nextSeq(),
      orderId: order.id,
      fillId: this.nextFillId++ as FillId,
      instrumentId: order.instrumentId,
      side: order.side,
      price,
      qty: fillQty,
      leavesQty: leaves,
      commission,
      slippage,
      liquidity,
      tag: order.tag,
    };
    this.sink.onFilled(event);
    this.reduceOcoSiblings(order, fillQty);

    if (leaves > 0 && (order.tif === 'ioc' || order.tif === 'fok')) {
      this.finishCancel(order, 'time_in_force');
    }
  }
}

/**
 * Orders the candidates that a single bar could have filled.
 *
 * `pessimistic` executes the most adverse fill first, which is the only assumption that cannot
 * flatter a strategy: for a bracketed position it means the stop is taken before the target.
 * `ohlc-path` assumes the conventional open-low-high-close (or open-high-low-close) traversal.
 * Ties fall back to submission order, so a result never depends on `Array.prototype.sort`
 * internals.
 */
function sortCandidates(candidates: Candidate[], policy: IntrabarPolicy): void {
  candidates.sort((a, b) => {
    if (policy === 'ohlc-path') {
      if (a.leg !== b.leg) return a.leg - b.leg;
      if (a.distance !== b.distance) return a.distance - b.distance;
    } else if (a.adversity !== b.adversity) {
      return policy === 'pessimistic' ? b.adversity - a.adversity : a.adversity - b.adversity;
    }
    return a.order.submitSeq - b.order.submitSeq;
  });
}
