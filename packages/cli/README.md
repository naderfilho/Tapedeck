# @tapedeck/cli

The `tapedeck` command: run a backtest, render a report, fetch market data, drive a paper session.

Part of [Tapedeck](../../README.md). See **[the API guide](../../docs/api.md)** for how the pieces
fit together, and the [ADRs](../../docs/adr/) for why they are shaped this way.

**Runtime dependencies:** `commander` for argument parsing, `zod` for validating options.

```bash
tapedeck run strategy.ts --data btc.tape --html out/report.html
tapedeck paper strategy.ts --symbol BTCUSDT --timeframe 1m --duration 3600
tapedeck data fetch --venue b3 --symbol WIN --from 2025-08-01 --to 2026-08-01 -o win.tape
tapedeck report out/run.json --html out/report.html
```

A strategy is a module you point at, not a name in a registry: a strategy is code, and pretending
otherwise means inventing a plugin system nobody asked for.

Every command is an ordinary function taking an IO object, so the tests drive them directly and
assert on what was written instead of spawning a process and grepping stdout.

## Licence

[PolyForm Noncommercial 1.0.0](../../LICENSE.md).
