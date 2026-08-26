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
  runStrategy,
  strategyById,
} from './strategies.ts';
import { type MarketSymbol, type Tape, isMarketSymbol, nameFor } from './tape.ts';

export {
  EXAMPLE_SIZE_COINS,
  EXAMPLE_SYMBOL,
  MARKETS,
  type MarketSymbol,
  type Tape,
  describeQuantity,
  loadTape,
  nameFor,
  quantityFor,
  tickerFor,
} from './tape.ts';
export {
  DEFAULT_STRATEGY,
  INITIAL_CASH,
  type ParamSpec,
  type ParamValue,
  SEED,
  STRATEGIES,
  type StrategySpec,
  type Values,
  strategyById,
} from './strategies.ts';

export interface RunConfig {
  readonly symbol: MarketSymbol;
  readonly strategy: string;
  /** The selected strategy's own parameters. Their shape is the strategy's business, not this file's. */
  readonly params: Values;
  /** Position size in quote currency (USDT). See `quantityFor`. */
  readonly notional: number;
  readonly preset: CostPreset;
}

export function execute(tape: Tape, config: RunConfig): RunResult {
  return runStrategy(tape, config.strategy, config.params, config.notional, config.preset);
}

// -------------------------------------------------------------------------- travelling as a URL

/** Strategy parameters ride under a `p.` prefix so they cannot collide with the run's own fields. */
const PARAM_PREFIX = 'p.';

export function toQuery(config: RunConfig): string {
  const params = new URLSearchParams({
    symbol: config.symbol,
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
 */
export function fromQuery(search: string): RunConfig | null {
  const query = new URLSearchParams(search);

  const symbol = query.get('symbol');
  if (symbol === null || !isMarketSymbol(symbol)) return null;

  const spec = strategyById(query.get('strategy') ?? DEFAULT_STRATEGY);
  if (spec === undefined) return null;

  const notional = Number(query.get('size'));
  if (!Number.isFinite(notional) || notional <= 0 || notional > 1e12) return null;

  const preset = query.get('costs');
  if (preset !== 'ideal' && preset !== 'binanceSpot') return null;

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

  return { symbol, strategy: spec.id, params, notional, preset };
}

/** How a run reads in a sentence, for a page heading. */
export function describeConfig(config: RunConfig): string {
  const spec = strategyById(config.strategy);
  const costs = config.preset === 'ideal' ? 'no costs' : 'Binance spot costs';
  return (
    `${nameFor(config.symbol)} · ${spec?.name ?? config.strategy} · ` +
    `${config.notional.toLocaleString('en-US')} USDT · ${costs}`
  );
}
