-- Saved backtest configurations.
--
-- Applied 2026-08-26 to project kefsjdtluuvmqygrfxim, through the dashboard SQL editor, because
-- that project is not reachable from this repository's tooling. Verified afterwards rather than
-- trusted: 11 columns, row-level security on, five policies, seven check constraints; and from
-- outside with the publishable key, an anonymous select returns an empty list while an anonymous
-- insert is refused with 42501. It is committed because a schema nobody can read is a schema
-- nobody can review, and it is idempotent so re-running it is safe.
--
-- **Only the configuration is stored, never the result.** The engine is deterministic: the same
-- parameters over the same committed tape produce the same equity curve, on any machine, forever.
-- Storing a PnL alongside would create a second copy of the truth that can disagree with the first,
-- and the disagreement would be invisible. A share link therefore carries a row id, and the
-- recipient's browser recomputes the numbers rather than being told them.

create table if not exists public.saved_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  name text not null check (char_length(trim(name)) between 1 and 80),

  -- Constrained to the tapes the site actually ships. A row naming an instrument that has no
  -- fixture is a saved run that 404s when it is opened, which is worse than refusing to save it.
  symbol text not null check (symbol in ('BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT')),

  -- The same bounds the form enforces. A check constraint is the only one of the two that survives
  -- someone posting to the REST endpoint directly.
  fast_period integer not null check (fast_period between 2 and 200),
  slow_period integer not null check (slow_period between 3 and 400),
  constraint fast_shorter_than_slow check (fast_period < slow_period),

  -- Position size in USDT. `numeric`, not a float: this repository does not put money in binary
  -- floating point, and a database column is not the place to start.
  notional numeric(18, 2) not null check (notional > 0),

  preset text not null check (preset in ('binanceSpot', 'ideal')),
  allow_short boolean not null default true,

  -- Off by default. Sharing is a deliberate act, not the consequence of saving something.
  is_public boolean not null default false,

  created_at timestamptz not null default now()
);

create index if not exists saved_runs_user_created_idx
  on public.saved_runs (user_id, created_at desc);

alter table public.saved_runs enable row level security;

-- Without these policies the table is readable by nobody, which is the correct default: the
-- publishable key is in the page source, so every rule that matters has to live here.
drop policy if exists "owners read their own runs" on public.saved_runs;
create policy "owners read their own runs"
  on public.saved_runs for select
  using (auth.uid() = user_id);

-- Anyone may read a row its owner marked public. The id is a uuid, so a share link is
-- unguessable, and nothing else in the table is reachable without one.
drop policy if exists "anyone reads a shared run" on public.saved_runs;
create policy "anyone reads a shared run"
  on public.saved_runs for select
  using (is_public);

drop policy if exists "owners insert their own runs" on public.saved_runs;
create policy "owners insert their own runs"
  on public.saved_runs for insert
  with check (auth.uid() = user_id);

drop policy if exists "owners update their own runs" on public.saved_runs;
create policy "owners update their own runs"
  on public.saved_runs for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "owners delete their own runs" on public.saved_runs;
create policy "owners delete their own runs"
  on public.saved_runs for delete
  using (auth.uid() = user_id);
