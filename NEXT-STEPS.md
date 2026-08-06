# Next steps

Written 6 Aug 2026, at v1.1.0. Enough context here to pick this up cold months
later.

**State of play:** the tool works. 128 automated checks pass across four
suites; it has been driven in Chrome against a live stockanalysis page. What it
has *not* had is a real user with a real portfolio, which is the only test that
finds the things testing does not.

Run everything before changing anything:

```bash
node test/adversarial.test.mjs    # 49 checks, synthetic — fast, no network
node test/csv.test.mjs            # 21 checks, no network
node test/engine.test.mjs         # 20 checks, live Yahoo
node test/ui.render.mjs out.html  # 38 checks, live Yahoo, writes a preview
```

The two live suites hit Yahoo. Run them back-to-back too often and you will get
429s — that is the rate limiter working, not a break. Wait a minute.

---

## 1. Use it (the only thing that actually matters)

Install through Tampermonkey from the
[raw URL](https://raw.githubusercontent.com/alfredbirkelund/portfolio-risk-lens/main/portfolio-risk-lens.user.js)
and run a real portfolio through it for a few weeks.

Everything below is optional. This is not. Every bug found so far came from
running the thing, and the remaining ones will too.

Two expectations so nothing looks broken:

- A 30–40 position first load takes roughly ten seconds. That is deliberate
  request pacing to stay under Yahoo's burst limit. It happens once; after that
  the cache serves it.
- Sector/country may briefly show *Unknown* with a warning. That is the Yahoo
  crumb handshake failing. Prices, correlation and every risk figure are
  unaffected — the warning says so explicitly.

## 2. Untested surfaces

Ranked by how likely they are to bite:

- **Tampermonkey installation itself.** All browser testing injected the script
  directly into the page. The `@match`, `@grant` and `@connect` directives have
  never actually been exercised by a userscript manager. If something is wrong
  in the metadata block, this is where it shows.
- **The SPA re-mount.** stockanalysis is a SvelteKit single-page app; the button
  is re-mounted on a 900 ms polling interval after client-side navigation
  (`boot()`, near the end of the file). Navigate between company pages and check
  the button survives and the detected ticker updates.
- **CSV drag-and-drop.** The file input is wired but was only ever tested by
  pasting text into the textarea.
- **A dark-mode host page.** `isDark()` was rewritten in v1.0.1 to read the host
  page's background luminance. It was verified on a light page only. Switch
  stockanalysis to dark and confirm the overlay follows.
- **Firefox and Safari.** Tampermonkey supports both; nothing has been run there.

## 3. Data-layer work, in order of value

**International prices from stockanalysis** — currently the fallback tier only
covers US symbols, so a Tokyo or Copenhagen holding has Yahoo as a single point
of failure. The international *pages* and their `__data.json` respond fine
unauthenticated, but every guess at the history endpoint's URL shape returned
400. Resolve it by opening a logged-in international page (e.g.
`/quote/krx/005930/`), watching the Network tab for the chart request, and
copying the real URL form into `StockAnalysis.bars`.

**Fuller ETF look-through** — Yahoo publishes only each fund's top ten holdings,
so a world tracker leaves ~27% unitemised (reported honestly, but unitemised).
`/etf/{ticker}/holdings/__data.json` on stockanalysis returned a populated
holdings payload during research and may carry the full list. Worth checking.

**FIGI as the identity key** — positions are keyed on the ticker string today,
so a ticker change or a re-listing silently splits a position's history in two.
[OpenFIGI](https://www.openfigi.com/) is free, needs no key, is run by Bloomberg,
and returned `BBG000BG4Q36` for Samsung on KRX during research. Storing the FIGI
alongside the symbol would eliminate a whole class of silent corruption. Do this
before anyone accumulates years of history.

**Factor decomposition** — the Ken French data library downloads cleanly (178 KB,
free, published for thirty years, covers Japan and Asia-Pacific). It would let
the tool split portfolio risk into market/size/value/momentum without any vendor
relationship. Purely additive; nothing depends on it.

## 4. Smaller things

- **No cache eviction.** Storage grows without bound as symbols are added and
  removed. The Data tab reports the size; nothing trims it. A "drop series not
  in the portfolio" sweep would do.
- **Mutual funds are unreliable on Yahoo.** Listed ETFs are solid. Non-listed
  share classes are hit-and-miss — currently they just fail with a visible
  warning, which is acceptable but not good.
- **Stress windows are hardcoded** in `STRESS` and are historical replays at
  fixed weights, not factor shocks. Adding a user-defined date range would be
  cheap.
- **Distribution.** GitHub-only today. Listing on Greasy Fork would add
  discoverability and update infrastructure at no cost. Only worth it once
  someone other than you is using it.

## 5. Things deliberately not done

Recorded so they are not rediscovered as gaps:

- No news, screening, DCF modelling, tax lots, broker sync or real-time quotes.
  stockanalysis is the first scan; this is the second look.
- No hosted web version. Yahoo sends no CORS headers, so a web page physically
  cannot fetch the data without a proxy server — which costs money, pools every
  user onto one rate-limited IP, and makes the operator the party redistributing
  market data. See `docs/DATA-SOURCES.md`.
- No Chrome Web Store listing. A userscript avoids the developer account, the
  per-release review, the privacy-policy compliance and the MV3 migrations, and
  covers Firefox and Safari from the same file. If that changes, only the fetch
  shim needs rewriting — the engine and UI are untouched.

## 6. Two lessons worth not relearning

**Normalised weights hide unit errors.** v0.1.0 shipped a currency bug where FX
was looked up by exact date match; on a miss it fell back to the unconverted
local price, so a KRW price was treated as DKK. Every test passed, because
weights sum to 1 whether or not the conversion happened. Apple read 0.05%
against a true 20.3%. `ui.render.mjs` now converts a reported value back through
an independently fetched spot rate. Any new derived quantity deserves the same
treatment: convert back and check you land where you started.

**Two "maths failures" in the adversarial suite were the test's fault, not the
code's.** Ledoit-Wolf δ = 1.0 on uncorrelated noise is *correct* — the
constant-correlation target is exactly right there, so full shrinkage is
optimal. And max drawdown of −50% was right; the hand calculation had used the
wrong trough. Check the expectation by hand before "fixing" working code.
