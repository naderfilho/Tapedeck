# 0015 — B3: sessions, contracts, and where the data may live

- Status: Accepted
- Date: 2026-08-25

## Context

Everything the engine had been built and tested against was crypto: one instrument, open forever,
one symbol that means the same thing next year. B3 breaks all three. The exchange closes at 18:00
in São Paulo and does not open on Carnival. A futures symbol is a coordinate — `WINJ25` exists for
a few months and then does not — so "two years of WIN" is a construction rather than a series. And
B3's prices, unlike Binance's, cannot be put in this repository.

## Decision

### The calendar carries a fixed UTC offset, not a time zone

Resolving a real zone means shipping the IANA database or calling `Intl`, whose answers depend on
the ICU build Node was compiled against. Session boundaries that move with a Node upgrade are not
reproducible, and reproducibility is the property this project exists to demonstrate (ADR-0006).

Brazil abolished daylight saving in 2019, so a fixed `-03:00` is _exactly right_ from November 2019
and _exactly wrong_ before it. The calendar carries `validFrom` and refuses earlier instants rather
than shifting every session by an hour in silence.

Carnival, Good Friday and Corpus Christi are computed from Easter rather than listed, so nobody has
to extend a table each December. The 24th and 31st of December are in the fixed table because B3
does not trade on either and neither is a legal holiday — a calendar built from the statute book
would have the market open on both.

### A `day` order dies at the session close

It used to die when the UTC calendar day changed, which is close enough on an instrument that never
closes and wrong twice on one that does: it kept an order alive through the evening after the bell,
and killed one submitted at 21:00 UTC that São Paulo still called the same session. The worst case
was Friday — an order placed after the close was cancelled at the first bar of Saturday, a day on
which nobody could have cancelled anything.

An order now carries `expiresAt`, computed once at submission. `ALWAYS_OPEN` makes that the next
midnight UTC, so every existing crypto run is unaffected.

### The roll is measured where the data allows it

`ContractSeries.rollDaysBefore` is an assumption and sits where it can be seen. But B3's daily files
carry volume and open interest per contract, so `rollOn: 'volume'` takes the first session on which
the next contract out-traded the current one. That is a fact about what happened; the rule is a
guess about it.

### Difference-adjustment is the default, and both methods are lossy

A back-adjusted price never traded. Difference-adjustment preserves point differences, and a futures
PnL is made of point differences, so it is the default. Ratio-adjustment preserves percentage
returns — and not even exactly, because prices here are fixed-point integers and a scaled price is
rounded back to the instrument's scale. On WIN, which quotes whole index points, that error is
visible in the second decimal.

The stitcher warns when adjustment pushes a bar to zero or below, which happens in deep
backwardation. A negative price is not a price and the engine rejects orders against one, so finding
out at stitch time beats finding out three hundred bars into a run.

### B3 market data is fetched, never committed

B3's Consumption Policy makes B3 the exclusive holder of the data, permits **internal use**, and
requires prior approval and a signed adhesion agreement to redistribute. Backtesting on it locally
is internal use. A public GitHub repository is redistribution. So `B3DataProvider` writes a local
`.tape` and nothing else, and every test fixture is built by the test — zips made with `zlib`, XML
written to the published layout — because a two-kilobyte excerpt is redistribution in exactly the
way a two-gigabyte one is.

This also settles what the B3 example runs on: a seeded random walk, framed loudly as one. The
mechanism it demonstrates — the expiries, the roll, the adjustment, the published tariffs, the
break-even commission — is all real. The PnL is not, and the example says so in its own output.

### The tariffs are B3's, cited and dated

Shipping a backtester with zero costs is not neutral; it is the most flattering assumption
available. `B3_TARIFFS` carries the exchange's published unit costs with a source URL and the date
they were transcribed. WIN and IND are priced in reais; **WDO and DOL are priced in dollars**, so
their cost in reais moves with the exchange rate and the model demands a rate rather than inventing
one. The day-trade reduction is a volume band, and the figure carried is the retail end of it.

Margins are a different problem and remain placeholders: B3 computes overnight margin per portfolio
under CORE, not per contract, and day-trade margin is set by each broker. There is no constant to
look up.

## Alternatives considered

- **A dependency for zip.** B3 ships a zip inside a zip and Node has no reader. The readable subset
  — stored and deflated entries, no encryption — is a central directory and a call to `inflateRaw`,
  about a hundred lines. A third runtime dependency in a repository that has two was the worse
  trade, and the same argument produced the `.tape` format instead of Parquet (ADR-0009).
- **Parsing the price report into a DOM.** Seventy thousand records per file, of which a handful are
  wanted. A tree of all of them costs more memory than the document.
- **Committing a small slice of B3 data so the example runs on real prices.** The slice is
  redistribution, and the repository is a public portfolio. Not a call to make on someone's behalf.
- **Shipping the B3 example with no data at all.** It would not run for anyone who cloned it, which
  is most of the value of having an example.
- **`Intl` for the time zone.** Correct across the 2019 boundary and dependent on the host's ICU.

## Consequences

- `ctx.calendar` is on the strategy context. The lookahead suite's allowlist caught it immediately,
  which is what that allowlist is for; a session calendar is public information published years in
  advance and carries no reference to the tape.
- Two bugs in the B3 example came from the engine being _correct_, and both are now regression
  tests. A strategy asking "how long until the close" from a bar's own close gets tomorrow's bell,
  because a session is half-open and at the closing instant the venue is already shut. And an exit
  submitted on the closing bar fills at the next session's open, because an order cannot match
  against the bar that produced it (ADR-0005) — so a strategy that wants to be flat overnight has
  to send the exit one bar early.
- The B3 fetch is heavy: roughly 250 requests of 15 MB for a year, for a few kilobytes of output.
  The cost is the download, not the storage.
- Daily bars only. Intraday B3 history is a paid product and is not in these files.
