# 0001 — Monorepo layout and package boundaries

- Status: Accepted
- Date: 2026-08-25

## Context

Tapedeck has to serve two very different consumers: a backtest that streams millions of bars
through a tight loop, and a paper-trading process that sits idle waiting for a WebSocket frame.
Both must run _the same strategy code_. If the engine and the I/O adapters share a package, the
hot loop inevitably starts importing HTTP clients, schema validators and file formats, and the
"same pipeline" promise erodes one import at a time.

## Decision

A pnpm workspace with a dependency graph that only ever points inward:

```text
cli ──► data ──► core ◄── indicators
 │       │        ▲
 ├──► report ─────┤
 └──► store ──────┘
```

- `@tapedeck/core` defines the contracts (events, Clock, Strategy, Broker, DataProvider, Store)
  and the deterministic engine. It has **zero runtime dependencies** and imports from no other
  workspace package.
- `@tapedeck/indicators` depends on core types only (`import type`), never on core's runtime.
- `@tapedeck/data`, `@tapedeck/report`, `@tapedeck/store` implement core's interfaces.
- `@tapedeck/cli` is the only package allowed to wire concrete implementations together.

Cross-package imports go through the package entry point; deep imports into another package's
`src/` are not allowed.

## Alternatives considered

- **Single package.** Simpler to publish, but nothing would stop `zod` or `ws` from ending up on
  the hot path, and consumers embedding the engine would pay for adapters they never use.
- **A standalone types package.** Splitting the contract from the invariants that enforce it: the
  fixed-point helpers and the event contracts are the same body of knowledge and belong together.

## Consequences

- Adding an adapter never touches core. Adding a field to core ripples outward, which is the
  direction we want the pain to flow.
- Contributors must respect the direction of the arrows; the absence of workspace dependencies in
  `packages/core/package.json` makes violations visible in review.
- Publishing is multi-package, handled by changesets with a fixed version group.
