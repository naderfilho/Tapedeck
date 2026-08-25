/**
 * `@tapedeck/store` — optional persistence.
 *
 * The engine never imports this package. A backtest runs entirely in memory and writes once, at
 * the end, if a store was handed to it; paper trading writes as it goes, because a crash there
 * loses state that cannot be recomputed (ADR-0008).
 *
 * Built on `node:sqlite`, so there is no native module to compile and nothing to install.
 */

export { type SqliteStoreOptions, SqliteStore, openStore } from './sqlite-store.ts';
