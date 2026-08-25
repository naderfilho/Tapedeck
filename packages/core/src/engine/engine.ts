/**
 * The engine: the loop that turns market data into an equity curve.
 *
 * Order of operations for every bar, and the reason for each step:
 *
 * ```text
 * 1. drain the scheduler      orders whose latency has elapsed enter the book
 * 2. advance the clock        simulated time becomes this bar's close
 * 3. match resting orders     yesterday's stop is honoured before today's decision
 * 4. mark to market           the strategy sees an account priced at this bar
 * 5. onBar                    the strategy decides; anything it submits is active from now on
 * 6. record equity            one point per bar, into a preallocated column
 * ```
 *
 * Step 3 before step 5 is what makes the simulation match a live account: in production, a resting
 * order fills whether or not your strategy is awake.
 *
 * Nothing in this loop allocates. The bar is a reused view, equity goes into a growable
 * `Float64Array`, and fills are the only objects created — a few thousand per run rather than a
 * few million (ADR-0004).
 */

import {
  type Instrument,
  type InstrumentId,
  type InstrumentSpec,
  InstrumentRegistry,
} from '../instrument.ts';
import {
  type PriceInt,
  type QtyInt,
  MONEY_EXP,
  asMoney,
  asQty,
  parseFixed,
} from '../math/fixed.ts';
import { SimulatedClock } from '../time/clock.ts';
import { SimulatedScheduler } from '../time/scheduler.ts';
import { type Timestamp, asTimestamp } from '../time/timestamp.ts';
import { type BarChunk, type TickChunk, validateBarChunk } from '../tape/chunk.ts';
import {
  type ViewMode,
  MutableBarView,
  MutableTickView,
  createBarGate,
  createTickGate,
} from '../tape/view.ts';
import { EventKind, type OrderFilledEvent, type SignalEvent } from '../events/events.ts';
import type { BarIndicator, IndicatorHandle, UseIndicatorOptions } from '../indicator.ts';
import { type ExecutionConfig, PRESETS } from '../execution/models.ts';
import { SimulatedBroker } from '../execution/broker.ts';
import type { NewOrder, OrderAmend, OrderId } from '../execution/types.ts';
import { Portfolio } from '../portfolio/portfolio.ts';
import { TradeLog } from '../portfolio/trades.ts';
import type { PortfolioView, Strategy, StrategyContext, StrategyFactory } from '../strategy.ts';
import { BufferedLogger, type BufferedLoggerOptions } from '../util/logger.ts';
import { createRng } from '../util/rng.ts';
import { ConfigError, IllegalStateError } from '../util/errors.ts';
import { STRICT, unreachable } from '../util/assert.ts';
import { EquityRecorder, type RunResult, type RunStats } from './result.ts';

export interface RunOptions<P extends object> {
  readonly instruments: readonly InstrumentSpec[];
  readonly strategy: StrategyFactory<P>;
  readonly params: P;
  /** Starting balance as a decimal string, e.g. `"100000"`. Parsed exactly (ADR-0002). */
  readonly initialCash: string;
  /** Seeds every random stream in the run. The same seed reproduces the run exactly. */
  readonly seed?: number | undefined;
  /** Defaults to {@link PRESETS.ideal}. Partial overrides are merged over it. */
  readonly execution?: Partial<ExecutionConfig> | undefined;
  /** Defaults to `guarded` outside production, `reuse` in it. See ADR-0004. */
  readonly barViewMode?: ViewMode | undefined;
  readonly recordEquityCurve?: boolean | undefined;
  readonly recordFills?: boolean | undefined;
  readonly recordSignals?: boolean | undefined;
  /** Close open positions at the last price when the run ends. Defaults to true. */
  readonly flattenAtEnd?: boolean | undefined;
  /** Validate every incoming chunk. Defaults to {@link STRICT}. */
  readonly validateData?: boolean | undefined;
  readonly logging?: BufferedLoggerOptions | undefined;
}

const MAX_RECORDED_SIGNALS = 100_000;

export class Engine<P extends object> {
  readonly registry = new InstrumentRegistry();
  private readonly clock = new SimulatedClock();
  private readonly scheduler = new SimulatedScheduler(this.clock);
  private readonly portfolio: Portfolio;
  private readonly tradeLog: TradeLog;
  private readonly broker: SimulatedBroker;
  private readonly strategy: Strategy<P>;
  private readonly context: StrategyContext;
  private readonly logger: BufferedLogger;
  private readonly execution: ExecutionConfig;

  private readonly barView = new MutableBarView();
  private readonly tickView = new MutableTickView();
  private readonly barGate;
  private readonly tickGate;
  private readonly guardedViews: boolean;

  private readonly equity = new EquityRecorder();
  private readonly fills: OrderFilledEvent[] = [];
  /** Registered through `ctx.use()`, updated in registration order once per matching bar. */
  private readonly indicators: { instrumentId: InstrumentId; indicator: BarIndicator<unknown> }[] =
    [];
  private readonly signals: SignalEvent[] = [];

  private readonly options: RunOptions<P>;
  private readonly recordEquity: boolean;
  private readonly recordFills: boolean;
  private readonly recordSignals: boolean;
  private readonly validateData: boolean;

  private seq = 0;
  private barIndex = 0;
  private tickIndex = 0;
  private startTs: Timestamp | null = null;
  private endTs: Timestamp | null = null;
  private lastCloseTs = -Infinity;
  private finished = false;
  private flattenedPositions = 0;

  constructor(options: RunOptions<P>) {
    this.options = options;
    if (options.instruments.length === 0) {
      throw new ConfigError('a run needs at least one instrument');
    }
    for (const spec of options.instruments) this.registry.register(spec);

    this.execution = { ...PRESETS.ideal(), ...options.execution };
    this.recordEquity = options.recordEquityCurve ?? true;
    this.recordFills = options.recordFills ?? true;
    this.recordSignals = options.recordSignals ?? true;
    this.validateData = options.validateData ?? STRICT;

    const mode: ViewMode = options.barViewMode ?? (STRICT ? 'guarded' : 'reuse');
    this.barGate = createBarGate(mode);
    this.tickGate = createTickGate(mode);
    this.guardedViews = mode !== 'reuse';

    const initialCash = asMoney(parseFixed(options.initialCash, MONEY_EXP));
    this.portfolio = new Portfolio(this.registry, initialCash);
    this.tradeLog = new TradeLog(this.registry);
    this.logger = new BufferedLogger(this.clock, options.logging ?? {});

    const rootRng = createRng(options.seed ?? 0);
    this.broker = new SimulatedBroker({
      registry: this.registry,
      clock: this.clock,
      scheduler: this.scheduler,
      execution: this.execution,
      rng: rootRng.fork('broker'),
      nextSeq: () => this.seq++,
      sink: {
        onAccepted: () => {
          // Acceptance carries no information a strategy can act on in a simulation: the order is
          // already in the engine's hands. Kept in the contract for the live broker (Phase 4).
        },
        onRejected: (event) => {
          this.logger.warn('order rejected', { orderId: event.orderId, reason: event.reason });
          this.strategy.onReject?.(event, this.context);
        },
        onFilled: (event) => {
          const effect = this.portfolio.applyFill(event);
          this.tradeLog.onFill(effect);
          if (this.recordFills) this.fills.push(event);
          this.strategy.onFill?.(event, this.context);
        },
        onCancelled: (event) => {
          this.strategy.onCancel?.(event, this.context);
        },
      },
    });

    this.context = this.createContext(rootRng.fork('strategy'));
    this.strategy = options.strategy();
    this.strategy.onInit(this.context, options.params);
  }

  /**
   * Replays one chunk of bars.
   *
   * Chunks must arrive in chronological order. Feeding two instruments means interleaving their
   * chunks by time; the simulated clock refuses to move backwards, so getting it wrong fails
   * immediately rather than producing a plausible, wrong equity curve. A merging multi-instrument
   * feed lands with the data adapters.
   */
  feedBars(chunk: BarChunk): void {
    if (this.finished) throw new IllegalStateError('cannot feed data after finish()');
    if (chunk.instrumentId >= this.registry.size) {
      throw new ConfigError(
        `chunk references unregistered instrument ${String(chunk.instrumentId)}`,
      );
    }
    // Passing the previous chunk's last close makes the ordering check span chunk boundaries,
    // which is where an out-of-order data file usually hides.
    if (this.validateData) validateBarChunk(chunk, this.lastCloseTs);

    const { count, openTs, closeTs, open, high, low, close, volume } = chunk;
    const view = this.barView;
    const onBar = this.strategy.onBar?.bind(this.strategy);
    const indicators = this.indicators;
    const guarded = this.guardedViews;
    const instrumentId = chunk.instrumentId;
    view.instrumentId = instrumentId;

    for (let i = 0; i < count; i++) {
      const barClose = closeTs[i] ?? unreachable('closeTs column shorter than count');
      view.openTs = (openTs[i] ?? unreachable('openTs column')) as Timestamp;
      view.closeTs = barClose as Timestamp;
      view.ts = barClose as Timestamp;
      view.open = (open[i] ?? unreachable('open column')) as PriceInt;
      view.high = (high[i] ?? unreachable('high column')) as PriceInt;
      view.low = (low[i] ?? unreachable('low column')) as PriceInt;
      view.close = (close[i] ?? unreachable('close column')) as PriceInt;
      view.volume = (volume[i] ?? unreachable('volume column')) as QtyInt;
      view.seq = this.seq++;
      view.index = this.barIndex++;

      this.scheduler.drainUpTo(view.closeTs);
      this.clock.advanceTo(view.closeTs);
      if (this.startTs === null) this.startTs = view.closeTs;
      this.endTs = view.closeTs;

      this.broker.onBar(view);
      this.portfolio.mark(instrumentId, view.close);

      // Indicators see the bar before the strategy does, so a value read inside `onBar` always
      // belongs to the bar being shown — never one stale, never one early.
      for (let k = 0; k < indicators.length; k++) {
        const entry = indicators[k];
        if (entry !== undefined && entry.instrumentId === instrumentId)
          entry.indicator.update(view);
      }

      if (onBar !== undefined) {
        if (guarded) {
          const guardedBar = this.barGate.enter(view);
          try {
            onBar(guardedBar, this.context);
          } finally {
            this.barGate.exit();
          }
        } else {
          onBar(view, this.context);
        }
      }

      this.tradeLog.onMark(instrumentId, this.portfolio.unrealizedPnlOf(instrumentId));
      if (this.recordEquity) this.equity.push(barClose, this.portfolio.equity());
      this.lastCloseTs = barClose;
    }
  }

  /**
   * Replays one chunk of ticks.
   *
   * Everything the bar path has to approximate is exact here: latency is honoured to the
   * microsecond and the intrabar policy never applies, because a tick *is* the path.
   */
  feedTicks(chunk: TickChunk): void {
    if (this.finished) throw new IllegalStateError('cannot feed data after finish()');
    if (chunk.instrumentId >= this.registry.size) {
      throw new ConfigError(
        `chunk references unregistered instrument ${String(chunk.instrumentId)}`,
      );
    }

    const { count, ts, price, size, aggressor } = chunk;
    const view = this.tickView;
    const onTick = this.strategy.onTick?.bind(this.strategy);
    const guarded = this.guardedViews;
    const instrumentId = chunk.instrumentId;
    view.instrumentId = instrumentId;

    for (let i = 0; i < count; i++) {
      const at = (ts[i] ?? unreachable('ts column shorter than count')) as Timestamp;
      const side = aggressor[i] ?? 0;
      view.ts = at;
      view.price = (price[i] ?? unreachable('price column')) as PriceInt;
      view.size = (size[i] ?? unreachable('size column')) as QtyInt;
      view.aggressor = side === 1 ? 'buy' : side === -1 ? 'sell' : null;
      view.seq = this.seq++;
      view.index = this.tickIndex++;

      this.scheduler.drainUpTo(at);
      this.clock.advanceTo(at);
      if (this.startTs === null) this.startTs = at;
      this.endTs = at;

      this.broker.onTick(view);
      this.portfolio.mark(instrumentId, view.price);

      if (onTick !== undefined) {
        if (guarded) {
          const guardedTick = this.tickGate.enter(view);
          try {
            onTick(guardedTick, this.context);
          } finally {
            this.tickGate.exit();
          }
        } else {
          onTick(view, this.context);
        }
      }
    }
  }

  /** Ends the run: cancels resting orders, optionally flattens, and assembles the result. */
  finish(): RunResult {
    if (this.finished) throw new IllegalStateError('finish() was already called');
    this.finished = true;

    this.broker.cancelAll('run_ended');

    if (this.options.flattenAtEnd ?? true) {
      const at = this.endTs ?? asTimestamp(0);
      for (const position of this.portfolio.openPositions()) {
        if (position.lastPrice === 0) continue;
        this.flattenedPositions++;
        this.broker.forceClose(
          position.instrumentId,
          position.qty > 0 ? 'sell' : 'buy',
          asQty(Math.abs(position.qty)),
          position.lastPrice,
          at,
        );
      }
    }

    this.strategy.onStop?.(this.context);
    this.scheduler.clear();

    const stats: RunStats = {
      ...this.broker.stats,
      bars: this.barIndex,
      ticks: this.tickIndex,
      signals: this.signals.length,
      logsDropped: this.logger.droppedCount,
      flattenedPositions: this.flattenedPositions,
    };

    return {
      config: {
        strategyId: this.strategy.id,
        seed: this.options.seed ?? 0,
        initialCash: this.portfolio.initialCash,
        instruments: this.registry.all().map((i) => i.key),
        intrabarPolicy: this.execution.intrabar,
        slippageModel: this.execution.slippage.name,
        commissionModel: this.execution.commission.name,
        latencyModel: this.execution.latency.name,
        liquidityModel: this.execution.liquidity.name,
        barViewMode: this.barGate.mode,
        params: this.options.params as Readonly<Record<string, unknown>>,
      },
      stats,
      startTs: this.startTs,
      endTs: this.endTs,
      initialCash: this.portfolio.initialCash,
      finalEquity: this.portfolio.equity(),
      cash: this.portfolio.cash,
      realizedPnl: this.portfolio.realizedPnl(),
      unrealizedPnl: this.portfolio.unrealizedPnl(),
      commissionPaid: this.portfolio.commissionPaid(),
      trades: this.tradeLog.trades,
      equityCurve: this.equity.snapshot(),
      fills: this.fills,
      signals: this.recordSignals ? this.signals : [],
      openPositions: this.portfolio.openPositions(),
      logs: this.logger.records,
      warnings: this.buildWarnings(stats),
    };
  }

  private buildWarnings(stats: RunStats): string[] {
    const warnings: string[] = [];
    const tradeCount = this.tradeLog.trades.length;

    if (stats.ambiguousBars > 0) {
      const share = tradeCount === 0 ? 0 : (stats.ambiguousBars / tradeCount) * 100;
      warnings.push(
        `${String(stats.ambiguousBars)} bar(s) could have filled more than one resting order. ` +
          `Resolved with the '${this.execution.intrabar}' policy; that is ${share.toFixed(1)}% of ` +
          `the ${String(tradeCount)} trade(s) in this run. Feed tick data to remove the assumption.`,
      );
    }
    if (stats.stopLimitDeferrals > 0) {
      warnings.push(
        `${String(stats.stopLimitDeferrals)} stop-limit order(s) triggered inside a bar and had ` +
          `their limit deferred to the next bar, because OHLCV does not record what happened after ` +
          `the trigger.`,
      );
    }
    if (stats.subBarLatencyIgnored > 0) {
      warnings.push(
        `${String(stats.subBarLatencyIgnored)} order(s) had latency shorter than one bar, which ` +
          `cannot be honoured on bar data and was ignored rather than invented. Feed tick data for ` +
          `exact latency.`,
      );
    }
    if (this.tradeLog.openCount > 0) {
      warnings.push(
        `${String(this.tradeLog.openCount)} position(s) were still open when the run ended; their ` +
          `PnL is unrealised and no closed trade was recorded for them.`,
      );
    }
    if (stats.logsDropped > 0) {
      warnings.push(`${String(stats.logsDropped)} log entries were dropped at the buffer cap.`);
    }
    return warnings;
  }

  private createContext(rng: ReturnType<typeof createRng>): StrategyContext {
    const portfolioView: PortfolioView = {
      cash: () => this.portfolio.cash,
      equity: () => this.portfolio.equity(),
      realizedPnl: () => this.portfolio.realizedPnl(),
      unrealizedPnl: () => this.portfolio.unrealizedPnl(),
      marginUsed: () => this.portfolio.marginUsed(),
      position: (instrumentId: InstrumentId) => this.portfolio.positionOf(instrumentId),
    };

    return {
      clock: this.clock,
      log: this.logger,
      rng,
      portfolio: portfolioView,
      now: (): Timestamp => this.clock.now(),
      instrument: (instrumentId: InstrumentId): Instrument => this.registry.byId(instrumentId),
      use: <T>(indicator: BarIndicator<T>, options?: UseIndicatorOptions): IndicatorHandle<T> => {
        const instrumentId = options?.instrumentId ?? (0 as InstrumentId);
        // Validates eagerly: a typo in the instrument id should fail at registration, not by
        // silently producing an indicator that never receives a bar.
        this.registry.byId(instrumentId);
        this.indicators.push({ instrumentId, indicator });
        return Object.freeze({
          get name(): string {
            return indicator.name;
          },
          get ready(): boolean {
            return indicator.ready;
          },
          get value(): T | null {
            return indicator.value;
          },
        });
      },
      instrumentOf: (venue: string, symbol: string): Instrument =>
        this.registry.require(venue, symbol),
      submit: (order: NewOrder): OrderId => this.broker.submit(order),
      cancel: (id: OrderId): boolean => this.broker.cancel(id),
      replace: (id: OrderId, amend: OrderAmend): boolean => this.broker.replace(id, amend),
      order: (id: OrderId) => this.broker.getOrder(id),
      openOrders: (instrumentId?: InstrumentId) => this.broker.openOrders(instrumentId),
      signal: (
        instrumentId: InstrumentId,
        direction: 'long' | 'short' | 'flat',
        strength = 1,
        tag?: string,
      ): void => {
        if (!this.recordSignals || this.signals.length >= MAX_RECORDED_SIGNALS) return;
        this.signals.push({
          kind: EventKind.Signal,
          ts: this.clock.now(),
          seq: this.seq++,
          instrumentId,
          direction,
          strength,
          tag: tag ?? null,
        });
      },
    };
  }
}

/** Convenience wrapper for the common case: one strategy, a finite sequence of chunks. */
export function runBacktest<P extends object>(
  options: RunOptions<P>,
  chunks: Iterable<BarChunk>,
): RunResult {
  const engine = new Engine(options);
  for (const chunk of chunks) engine.feedBars(chunk);
  return engine.finish();
}

/** The same, for a provider that streams chunks asynchronously. */
export async function runBacktestAsync<P extends object>(
  options: RunOptions<P>,
  chunks: AsyncIterable<BarChunk>,
): Promise<RunResult> {
  const engine = new Engine(options);
  for await (const chunk of chunks) engine.feedBars(chunk);
  return engine.finish();
}
