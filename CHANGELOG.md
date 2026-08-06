# Changelog

## v1.0.0 — 2026-08-06

First complete release. The engine, the data layer and the interface are all
tested against live data; what remains untested is interaction in a real browser
(see *Known limits* in the README).

### Added

- **Security-level look-through.** Funds are now decomposed to the company, not
  just the sector. If you hold a world tracker and also hold Apple directly, the
  tool states your real Apple exposure and how much larger it is than the
  holdings list suggests. Fund weight beyond the published top holdings is
  reported as unitemised rather than quietly dropped.
- **CSV import and export.** Detects comma, semicolon and tab delimiters, and
  handles the European convention of semicolons with comma decimal separators —
  the case where a naive parser silently turns `1.234,5` into garbage. Column
  names are matched by alias in English, Danish, Norwegian, Swedish and German,
  so a Nordic broker export imports without editing. Import merges on symbol
  rather than replacing, so it tops a portfolio up instead of destroying rows the
  file happens not to mention.
- **Settings panel** — benchmark, history window, return sampling override, risk
  budget and cache TTL, all editable in the interface instead of by editing code.
- **Second price source.** stockanalysis.com's history endpoint is now a fallback
  behind Yahoo for US-listed symbols, with history back to 1982. Yahoo is no
  longer a single point of failure for the US sleeve. The Data tab reports which
  source each figure came from.
- **Request pacing and backoff.** One request in flight at a time, a short gap
  between them, and exponential backoff on 429 and 5xx.

### Fixed

- **Currency conversion silently failed when calendars disagreed.** FX rates were
  looked up by exact date match, but equity and FX series do not share a
  calendar — Seoul trades on days the FX series skips. On a miss the code fell
  back to the *unconverted local price*, so a KRW price was treated as DKK. This
  did not look wrong on screen; it just made every portfolio weight wrong. Apple
  was showing 0.05% where its true weight was 20.3%. Lookups are now as-of
  (nearest observation at or before the date) via binary search, and a position
  that genuinely cannot be converted is excluded from weights with a visible
  warning rather than counted in the wrong unit.
- **Stress windows were unreachable at default settings.** The default lookback
  was five years while the stress list starts at the 2020 COVID crash, so every
  window fell outside history for every user. Default is now ten years.
- **Failed profile fetches were silent.** A failed crumb handshake rendered every
  holding as sector "Unknown", which reads as real data. It now surfaces a
  warning naming which figures are affected and which are not.

### Testing

Three harnesses, all slicing code out of the shipped userscript rather than
duplicating it: `engine.test.mjs` (20 checks), `csv.test.mjs` (21 checks),
`ui.render.mjs` (33 checks, end to end against live data).

The FX bug is the reason the render harness now cross-checks a converted price
back against an independent spot rate. Every prior check passed while the numbers
were wrong — weights sum to 1 whether or not the conversion happened, because
they are normalised. A test that cannot fail is not a test.

## v0.1.0 — 2026-08-06

Initial release. Risk engine with Ledoit-Wolf shrinkage, Euler risk
contributions, correlation clustering, sector look-through, multi-currency
handling, historical stress replay and vol-targeted sizing.
