# 0007 — Node 24 baseline and dependency policy

- Status: Accepted
- Date: 2026-08-25

## Context

The original target was Node 22 LTS. Node 22 entered maintenance in October 2025 and, more
importantly, `node:sqlite` requires `--experimental-sqlite` there. The persistence layer would
then need either a runtime flag or a native module.

## Decision

`engines: ">=24"`.

- `node:sqlite` is available without a flag, so `@tapedeck/store` ships with **no native
  dependency**: no compiler on install, no prebuild matrix, no Windows pain.
- Native TypeScript type stripping means benchmarks and examples run as
  `node bench/replay.bench.ts` with no build step. This is why `erasableSyntaxOnly` is on and why
  the codebase contains no `enum`, no namespaces and no parameter properties.

Runtime dependency allowlist — anything else needs a discussion and an ADR:

| Package       | Allowed in | Why                                               |
| ------------- | ---------- | ------------------------------------------------- |
| `zod`         | data, cli  | Validating data that crosses the process boundary |
| `commander`   | cli        | Argument parsing                                  |
| `node:sqlite` | store      | Built in, no install cost                         |

`ws` had a row here, reserved for the live feed. Phase 4 did not need it: Node 24 ships a global
`WebSocket`, so `@tapedeck/data` reaches it through a four-method `StreamSocket` seam — which is
what makes the live path testable without a network — and keeps `zod` as its only runtime
dependency. The row is gone rather than left unused.

`@tapedeck/core`, `@tapedeck/indicators` and `@tapedeck/report` have zero runtime dependencies and
are expected to keep it that way.

## Alternatives considered

- **Node 22 plus better-sqlite3.** Honours the original request but adds a native module that
  compiles on install; a reviewer cloning the repository on Windows would hit it immediately.
- **Node 22 with SQLite behind a flag.** Puts a footgun in the quickstart.

## Consequences

- Users on Node 22 cannot run Tapedeck. Acceptable: Node 24 is the active LTS.
- `Store` remains an interface, so a better-sqlite3 implementation is a small package away if
  someone needs Node 22 support.
