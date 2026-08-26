/**
 * One definition of a run, shared by the demo and the report.
 *
 * These two pages have to agree exactly. If the demo builds a run one way and the report builds it
 * another, the report shows different numbers for the run it claims to describe, and the page that
 * exists to prove the engine is deterministic becomes the page that disproves it. So the sizing,
 * the seed, the preset and the strategy registry live behind here and neither page owns a copy.
 *
 * A run travels between pages as its **configuration**, never as its result. The engine is
 * deterministic: the same parameters over the same committed tape produce the same equity curve on
 * any machine, so the receiving page recomputes rather than being told. That makes a report URL
 * shareable, and it means a stale link cannot show a number the engine would no longer produce.
 */

import type { RunResult } from '@tapedeck/core';
import {
  type CostPreset,
  DEFAULT_STRATEGY,
  type ParamValue,
  type Values,
  executionFor,
  runStrategy,
  strategyById,
} from './strategies.ts';
import {
  DEFAULT_TIMEFRAME,
  type Tape,
  VENUES,
  labelFor,
  marketById,
  quoteOf,
  timeframeById,
  viewOf,
} from './tape.ts';

export {
  DEFAULT_TIMEFRAME,
  EXAMPLE_MARKET,
  EXAMPLE_SIZE_COINS,
  MARKETS,
  type Market,
  TIMEFRAMES,
  type Tape,
  type TapeView,
  type Timeframe,
  VENUES,
  type Venue,
  type VenueId,
  describeQuantity,
  labelFor,
  loadTape,
  marketById,
  marketsByVenue,
  nameFor,
  quantityFor,
  quoteOf,
  tickerFor,
  timeframeById,
  viewOf,
} from './tape.ts';
export {
  type CostPreset,
  DEFAULT_STRATEGY,
  INITIAL_CASH,
  type ParamSpec,
  type ParamValue,
  SEED,
  STRATEGIES,
  type StrategySpec,
  type Values,
  executionFor,
  strategyById,
} from './strategies.ts';

export interface RunConfig {
  /** `venue-symbol`, as `markets.ts` spells it. */
  readonly market: string;
  /** Bar clock the run is replayed on. The tapes are hourly; anything slower is aggregated. */
  readonly timeframe: string;
  readonly strategy: string;
  /** The selected strategy's own parameters. Their shape is the strategy's business, not this file's. */
  readonly params: Values;
  /** Position size in the market's quote currency. See `quantityFor`. */
  readonly notional: number;
  readonly preset: CostPreset;
}

/**
 * The cost settings a market may be run under: its own venue's, plus the two neutral ones.
 *
 * A Coinbase tape priced with Binance's fees would be a report about a market nobody traded in, so
 * the pairing is enforced here rather than left to the person building the form.
 */
export function presetsFor(marketId: string): readonly CostPreset[] {
  const market = marketById(marketId);
  const venue = market === undefined ? undefined : VENUES[market.venue];
  return [...((venue?.presets ?? []) as readonly CostPreset[]), 'stress', 'ideal'];
}

/** The cost setting a market opens under, and the one it falls back to after a venue change. */
export function defaultPresetFor(marketId: string): CostPreset {
  const market = marketById(marketId);
  const venue = market === undefined ? undefined : VENUES[market.venue];
  return (venue?.defaultPreset ?? 'binanceSpot') as CostPreset;
}

export function execute(tape: Tape, config: RunConfig): RunResult {
  const view = viewOf(tape, config.timeframe);
  return runStrategy(
    view.tape,
    config.strategy,
    config.params,
    config.notional,
    executionFor(config.preset, defaultPresetFor(config.market)),
  );
}

// -------------------------------------------------------------------------- travelling as a URL

/** Strategy parameters ride under a `p.` prefix so they cannot collide with the run's own fields. */
const PARAM_PREFIX = 'p.';

export function toQuery(config: RunConfig): string {
  const params = new URLSearchParams({
    symbol: config.market,
    tf: config.timeframe,
    strategy: config.strategy,
    size: String(config.notional),
    costs: config.preset,
  });
  for (const [key, value] of Object.entries(config.params)) {
    params.set(
      `${PARAM_PREFIX}${key}`,
      typeof value === 'boolean' ? (value ? '1' : '0') : String(value),
    );
  }
  return params.toString();
}

/**
 * Reads a configuration out of a query string, or returns `null` if anything is off.
 *
 * Every field is checked against the selected strategy's own bounds, because this input arrives
 * from a URL somebody can edit. `null` rather than a thrown error or a repaired object: a page that
 * silently corrects a link renders a report for a run nobody asked for, and the reader has no way
 * to tell it happened.
 *
 * The two exceptions are both about links that were shared before the page grew: a `symbol` with
 * no venue in it resolves to the Binance market it always meant, and a missing `tf` is the hourly
 * clock, which is the only one that existed. Neither changes the run that was shared.
 */
export function fromQuery(search: string): RunConfig | null {
  const query = new URLSearchParams(search);

  const market = marketById(query.get('symbol') ?? '');
  if (market === undefined) return null;

  const timeframe = timeframeById(query.get('tf') ?? DEFAULT_TIMEFRAME);
  if (timeframe === undefined) return null;

  const spec = strategyById(query.get('strategy') ?? DEFAULT_STRATEGY);
  if (spec === undefined) return null;

  const notional = Number(query.get('size'));
  if (!Number.isFinite(notional) || notional <= 0 || notional > 1e12) return null;

  const preset = query.get('costs') ?? '';
  if (!presetsFor(market.id).includes(preset as CostPreset)) return null;

  const params: Record<string, ParamValue> = {};
  for (const param of spec.params) {
    const raw = query.get(`${PARAM_PREFIX}${param.key}`);
    if (raw === null) {
      params[param.key] = spec.defaults[param.key] ?? 0;
      continue;
    }
    if (param.kind === 'bool') {
      if (raw !== '0' && raw !== '1') return null;
      params[param.key] = raw === '1';
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) return null;
    if (param.kind === 'int' && !Number.isInteger(value)) return null;
    if (param.min !== undefined && value < param.min) return null;
    if (param.max !== undefined && value > param.max) return null;
    params[param.key] = value;
  }

  return {
    market: market.id,
    timeframe: timeframe.id,
    strategy: spec.id,
    params,
    notional,
    preset: preset as CostPreset,
  };
}

/** What each cost setting is called, in English. The demo translates its own copy. */
export const PRESET_LABELS: Readonly<Record<CostPreset, string>> = {
  binanceSpot: 'Binance spot, 0.100% + slippage',
  binanceSpotBnb: 'Binance spot paying in BNB, 0.075%',
  coinbaseExchange: 'Coinbase Exchange, 0.60% taker',
  stress: 'venue fees, bad fills',
  ideal: 'none, the flattering one',
};

/** How a run reads in a sentence, for a page heading. */
export function describeConfig(config: RunConfig): string {
  const spec = strategyById(config.strategy);
  const costs = PRESET_LABELS[config.preset];
  return (
    `${labelFor(config.market)} · ${config.timeframe} · ${spec?.name ?? config.strategy} · ` +
    `${config.notional.toLocaleString('en-US')} ${quoteOf(config.market)} · ${costs}`
  );
}
