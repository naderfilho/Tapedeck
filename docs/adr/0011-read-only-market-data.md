# 0011 — Read-only public market data, and no credentials anywhere

- Status: Accepted
- Date: 2026-08-25

## Context

The project needs real data to be worth anything: a strategy result computed on a generated series
says something about the engine and nothing about the market. It also has to be safe to clone and
run, including by someone who has never read the source.

## Decision

**Providers talk to public endpoints and hold no credentials.** `BinanceDataProvider` uses
unauthenticated market-data routes. It cannot place an order because it has no concept of a key,
which is a stronger guarantee than a code review promising it will not. Paper trading (phase 4)
keeps the same property: a live feed drives the _simulated_ broker, so the only thing that reaches
the venue is a subscription.

**Binance spot data is committed to the repository.** It is public and redistributable, so a
reader can clone, run five commands and see a result on prices they recognise. A year of hourly
BTCUSDT is 8,760 bars and 480 KiB. `pnpm fixtures` regenerates it through the same provider a user
would call — if the provider is broken, the fixtures cannot be rebuilt.

**B3 data is never committed.** It is neither public nor redistributable. Every B3 example points
at a file the user fetched themselves, and the instrument specs ship with placeholder costs and
margins that are marked as placeholders.

**The fixture range is two fixed dates, not "the last year".** A fixture that moves with the wall
clock is not a fixture, and a test that depends on one is a test that fails on a Tuesday.

**`fetch` and `sleep` are injectable.** Pagination, truncation of unclosed candles, rate-limit
backoff and malformed payloads are all covered by tests with a scripted `fetch`. A provider whose
only test is that it worked once against the live API has no test.

## Alternatives considered

- **Generating synthetic data for everything.** Reproducible and free, and it flatters every
  strategy: the first synthetic series written for this project gave a moving-average crossover a
  96% win rate. Kept for the benchmark, where only throughput is being measured.
- **Downloading fixtures in CI instead of committing them.** Smaller repository, and the test suite
  then fails whenever the venue is unreachable or rate-limits the runner.
- **Supporting authenticated endpoints now.** More data, and a repository that holds an API key is
  a repository nobody should run casually. Deferred until there is a reason.

## Consequences

- The committed fixture is 480 KiB of binary in git history. It changes only when someone
  deliberately regenerates it.
- Tests assert against real prices, so they must not assert a particular PnL — they assert the
  invariants that hold for any strategy on any data.
- Rate limits are the provider's problem: `Retry-After` is honoured, backoff is exponential, and
  the delay between pages is configurable.
