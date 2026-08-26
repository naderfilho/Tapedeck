/**
 * Saved runs, over Supabase's REST endpoint.
 *
 * Sharing is deliberately not in here. A run is fully described by its configuration and the engine
 * is deterministic, so a link is the address bar and nothing needs storing for someone else to open
 * it. Putting sharing behind an account would have invented a dependency the design does not have.
 *
 * What an account buys is a **named list you come back to**. That is the whole feature.
 *
 * Every call carries the reader's access token as well as the publishable key. The token is what
 * `auth.uid()` reads in the policies; without it the row-level security refuses the write, which is
 * exactly what the anonymous probe in `supabase/migrations/0001_saved_runs.sql` demonstrates.
 */

import { type UserSession, config } from './auth.ts';
import type { MarketSymbol, RunConfig } from './run.ts';

export interface SavedRun {
  readonly id: string;
  readonly name: string;
  readonly symbol: MarketSymbol;
  readonly fast_period: number;
  readonly slow_period: number;
  readonly notional: string;
  readonly preset: 'ideal' | 'binanceSpot';
  readonly allow_short: boolean;
  readonly created_at: string;
}

const TABLE = '/rest/v1/saved_runs';

function headers(session: UserSession, extra: Readonly<Record<string, string>> = {}): HeadersInit {
  const settings = config();
  if (settings === null) throw new Error('this deployment has no database configured');
  return {
    apikey: settings.supabaseAnonKey,
    authorization: `Bearer ${session.accessToken}`,
    ...extra,
  };
}

function base(): string {
  const settings = config();
  if (settings === null) throw new Error('this deployment has no database configured');
  return settings.supabaseUrl;
}

/** The reader's own runs, newest first. Policies mean this can only ever return their own. */
export async function list(session: UserSession): Promise<readonly SavedRun[]> {
  const response = await fetch(`${base()}${TABLE}?select=*&order=created_at.desc&limit=50`, {
    headers: headers(session),
  });
  if (!response.ok) throw new Error(`could not load your saved runs (${String(response.status)})`);
  return (await response.json()) as readonly SavedRun[];
}

export async function save(
  session: UserSession,
  name: string,
  run: RunConfig,
): Promise<SavedRun | null> {
  const response = await fetch(`${base()}${TABLE}`, {
    method: 'POST',
    headers: headers(session, {
      'content-type': 'application/json',
      prefer: 'return=representation',
    }),
    body: JSON.stringify({
      // `user_id` is sent rather than defaulted so the insert policy has something to compare
      // `auth.uid()` against. A mismatch is refused by the database, not by this file.
      user_id: session.userId,
      name,
      symbol: run.symbol,
      fast_period: run.fastPeriod,
      slow_period: run.slowPeriod,
      notional: run.notional,
      preset: run.preset,
      allow_short: run.allowShort,
    }),
  });
  if (!response.ok) {
    // The check constraints live in the database because a form is not a guarantee. When one of
    // them fires, the reader gets the reason rather than a status code.
    if (response.status === 409) throw new Error('You already have a run saved under that name.');
    throw new Error(`could not save that run (${String(response.status)})`);
  }
  const rows = (await response.json()) as readonly SavedRun[];
  return rows[0] ?? null;
}

export async function remove(session: UserSession, id: string): Promise<void> {
  const response = await fetch(`${base()}${TABLE}?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: headers(session),
  });
  if (!response.ok) throw new Error(`could not delete that run (${String(response.status)})`);
}

/** A stored row, back in the shape the engine and the form both speak. */
export function toConfig(row: SavedRun): RunConfig {
  return {
    symbol: row.symbol,
    fastPeriod: row.fast_period,
    slowPeriod: row.slow_period,
    notional: Number(row.notional),
    preset: row.preset,
    allowShort: row.allow_short,
  };
}
