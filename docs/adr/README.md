# Architecture Decision Records

Short records of the decisions that shaped Tapedeck. Each one states the context, the decision,
the alternatives that were rejected and why, and the consequences we accepted.

| ADR                                                    | Title                                                     | Status   |
| ------------------------------------------------------ | --------------------------------------------------------- | -------- |
| [0001](0001-monorepo-layout-and-package-boundaries.md) | Monorepo layout and package boundaries                    | Accepted |
| [0002](0002-fixed-point-money-float-indicators.md)     | Fixed-point integers for money, float64 for indicators    | Accepted |
| [0003](0003-synchronous-deterministic-kernel.md)       | A synchronous kernel for both backtest and live           | Accepted |
| [0004](0004-columnar-tape-and-reused-bar-views.md)     | Columnar tape and reused bar views                        | Accepted |
| [0005](0005-intrabar-execution-and-no-lookahead.md)    | Intrabar execution model and the no-lookahead invariant   | Accepted |
| [0006](0006-determinism-guarantees-and-limits.md)      | Determinism guarantees and their limits                   | Accepted |
| [0007](0007-node-baseline-and-dependency-policy.md)    | Node 24 baseline and dependency policy                    | Accepted |
| [0008](0008-optional-persistence-behind-store.md)      | Optional persistence behind a Store interface             | Accepted |
| [0009](0009-tape-binary-format.md)                     | A columnar .tape format instead of Parquet                | Accepted |
| [0010](0010-indicator-contract.md)                     | The indicator contract                                    | Accepted |
| [0011](0011-read-only-market-data.md)                  | Read-only public market data, and no credentials anywhere | Accepted |
