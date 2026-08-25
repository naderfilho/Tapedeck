# 0009 — A columnar `.tape` format instead of Parquet

- Status: Accepted
- Date: 2026-08-25

## Context

Downloaded market data has to live somewhere between the venue and the engine. The engine reads it
exactly one way: a single forward scan over a handful of `Float64Array` columns, at roughly
25 million bars per second. Whatever the container is, it must not stand between those two facts.

## Decision

A small self-describing binary format:

```text
"TAPEDCK1"        8 bytes   magic and format version
headerLength      uint32LE
header            JSON, utf8
padding           to the next 8-byte boundary
columns           back to back, in the order the header declares
```

The header is JSON so the format can gain a field without a version bump, and so that looking at
the first two hundred bytes of a file tells you what you are holding: which instrument, which
scales, which range, fetched by what.

Reading is one `readFile` and one `JSON.parse`. The columns are then **views over the same buffer** —
no parsing, no copy, no conversion. The one wrinkle is alignment: Node pools small buffers, so a
file read can land on any byte offset while a `Float64Array` view needs an 8-byte-aligned start.
The decoder checks and copies only when it must.

The same bytes are what `@tapedeck/store` puts in a SQLite blob, so the cache and a file on disk
are the same artefact and cannot drift apart.

## Alternatives considered

- **Parquet.** The obvious answer, and the right one when data is queried by predicate, shared
  across languages, or larger than memory. None of that applies here. Every usable Node
  implementation costs one to two megabytes of WebAssembly, and the format's strengths — row
  groups, predicate pushdown, per-column encodings — buy nothing for a single sequential scan.
  It remains the right choice for interoperability with pandas, and is on the roadmap as an
  optional export rather than as the storage format.
- **CSV.** Human-readable and forty times larger, and parsing it is most of the replay budget.
  Supported as an _input_ — see `CsvBarProvider` — because that is what people already have.
- **JSON or newline-delimited JSON.** Same parsing cost as CSV with worse density.
- **A packed binary header.** Faster to parse by a few microseconds, once per file, at the cost of
  never being able to look at a file and understand it.

## Consequences

- The format is ours, so it is our job to keep it readable: the magic carries a version, and any
  incompatible change gets a new one.
- Interoperability with the Python ecosystem needs an explicit export step. Accepted; the audience
  for that is not the audience for the engine.
- A `.tape` is not compressed. A year of hourly bars is 480 KiB, and compression would trade the
  zero-copy read for CPU. Minute-resolution data over many years is the case that would change
  this, and it can be handled by compressing the columns individually without touching the header.
