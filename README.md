# Portfolio Risk Lens

A portfolio construction and risk management overlay for [stockanalysis.com](https://stockanalysis.com).

stockanalysis is an excellent *cross-sectional* research tool — one company at a time. But
every question that actually matters for a portfolio is *joint*: how much of my volatility
does this position really cause, how many of my nine holdings are secretly one bet, what
happens to concentration if I trim this to fund that. It has portfolios and watchlists, but
no portfolio-level risk analysis. This fills that gap without asking you to leave the page
you're already reading.

It is a **userscript**: one file, no server, no account, no build step, no telemetry.
Your holdings and all cached prices stay in your browser.

![status](https://img.shields.io/badge/version-1.0.0-blue) ![license](https://img.shields.io/badge/license-MIT-blue)

---

## Install

1. Install a userscript manager — [Tampermonkey](https://www.tampermonkey.net/) is the usual
   choice and works on Chrome, Edge, Firefox, Safari and Opera.
2. **Chrome/Edge only:** open `chrome://extensions`, click *Details* on Tampermonkey, and
   enable **"Allow User Scripts"**. Since Chrome 138 this is a per-extension toggle — you no
   longer need to turn on global Developer Mode.
3. Click **[install portfolio-risk-lens.user.js](https://raw.githubusercontent.com/alfredbirkelund/portfolio-risk-lens/main/portfolio-risk-lens.user.js)**
   and confirm.
4. Open any page on stockanalysis.com. A **Risk Lens** button appears bottom-right.

Updates are automatic — Tampermonkey checks the `@updateURL` and pulls new versions.

---

## What it does

**Positions** — holdings with shares, cost basis, target weight and a one-line thesis.
Everything converted to your reporting currency at daily FX. **CSV import** handles comma,
semicolon and tab files, including the European convention of semicolons with comma decimal
separators, and matches column names in English, Danish, Norwegian, Swedish and German — so a
Nordic broker export imports without editing.

**Risk**
- **Risk contribution per position** — the share of portfolio volatility each name is
  responsible for. This is rarely its weight, and the gap is the whole point. In the test
  portfolio a 20% position in Novo Nordisk causes 33% of the risk while a 20% position in a
  world tracker causes 9%.
- **Look-through exposure** — funds decomposed to the company, not just the sector. In the
  test portfolio you hold Apple at 20.3% directly *plus* 1.7% inside the world tracker, for a
  true exposure of 22.1%. No holdings list shows you that, and it is exactly the
  concentration people get wrong.
- **Clustered correlation heatmap** — co-moving names sorted together, so blocks of red
  reveal positions that are one bet wearing several tickers.
- **Sector / country / currency exposure**, with funds decomposed rather than counted as one
  position.
- **FX share of volatility** — how much of your risk is currency rather than companies.
- Portfolio drawdown, volatility and benchmark beta.

**Scenarios**
- A what-if sandbox: edit any weight, recompute volatility, concentration and drawdown.
- Historical stress windows (COVID crash, 2022 rate shock, 2023 banking wobble, the August
  2024 yen unwind) replayed through your *current* weights.
- Vol-targeted sizing: the weight at which each name would consume a set share of portfolio
  volatility.

**Data** — cache stats, one-click export of everything, and a self-test button.

Deliberately **not** included: news, screening, DCF modelling, tax lots, broker sync,
real-time quotes. stockanalysis remains the first scan; this is what you open once a name is
already interesting.

---

## How the userscript works

```
  stockanalysis.com page
        │
        │  content-script context (Tampermonkey)
        ▼
  ┌──────────────────────────────────────────────┐
  │  Risk Lens                                   │
  │                                              │
  │  UI overlay ── engine ── cache (GM storage)  │
  │                            │                 │
  │                            ▼                 │
  │                   GM_xmlhttpRequest          │
  └──────────────────────────┼───────────────────┘
                             ▼
                     Yahoo Finance endpoints
```

**Why a userscript rather than a web app.** Neither Yahoo nor stockanalysis sends
`access-control-allow-origin` headers. A normal web page therefore *cannot* fetch this data
from any domain — that's a browser security boundary, not a configuration problem. A hosted
version would need a proxy server, which costs money, pools every user's traffic onto one IP
that gets rate-limited collectively, and makes the operator the party redistributing market
data. `GM_xmlhttpRequest` runs outside the page's CORS policy, so each user's own browser
fetches their own data on their own IP. Nothing is hosted, nothing is redistributed.

**Why a userscript rather than a Chrome extension.** Same data access, far less overhead: no
$5 developer account, no store listing, no privacy policy cross-checked against your manifest
on every release, no 2–5 day review per update, no Manifest V3 migrations, no removal risk.
You ship by pushing a commit. It also covers Firefox and Safari from the same file, which a
Chrome extension does not. If it ever warrants store distribution, only the fetch shim changes —
the engine and UI are untouched.

**The floating button is deliberate.** It is fixed-position rather than injected into
stockanalysis's header, so a redesign of their DOM can't break it. On a company page it
detects the ticker from the URL and offers to add it — `/stocks/aapl/` → `AAPL`,
`/quote/krx/005930/` → `005930.KS`.

**The cache is the source of truth.** Every price series is stored in the userscript
manager's own storage — not site storage, so clearing stockanalysis's cookies won't touch it.
Yahoo is consulted only for bars not already held. If every endpoint died tomorrow the tool
still runs on everything you've loaded.

---

## Data sources

| Layer | Source | Auth | If it breaks |
|---|---|---|---|
| Daily prices, all markets | Yahoo `chart` | none | falls back to stockanalysis (US), then cache |
| Daily prices, US only | stockanalysis `history` | none | history back to 1982 |
| FX (`USD{CUR}=X`) | Yahoo `chart` | none | position excluded with a visible warning |
| Sector, country, fund holdings | Yahoo `quoteSummary` | cookie + crumb | lose labels, keep all risk math |

Layered so no single failure is fatal, and split so the fragile half is non-essential.
Requests are paced — one in flight at a time with exponential backoff on 429 — because Yahoo
rate-limits on burst, and a portfolio refresh is a burst. Verified across US, Tokyo, Seoul,
Xetra, Copenhagen, Amsterdam and UCITS ETFs. See
[docs/DATA-SOURCES.md](docs/DATA-SOURCES.md) for what else was tested and rejected.

---

## Four things this gets right that most retail tools don't

**Trading calendars don't align.** Tokyo closes about fourteen hours before New York on the
same date stamp. Naively correlating daily closes across regions biases correlations toward
zero — it makes a book look diversified when it isn't. Risk Lens switches to weekly sampling
automatically when a portfolio spans regions. The effect is not subtle:

| Pair | Daily ρ | Weekly ρ |
|---|---|---|
| AAPL ~ 7203.T (New York vs Tokyo) | 0.067 | **0.216** |
| AAPL ~ 005930.KS (New York vs Seoul) | −0.006 | **0.135** |
| 7203.T ~ 005930.KS (both Asia, same session) | 0.167 | 0.159 |

The two Asian names trade simultaneously and barely move. The cross-session pairs triple.
Daily data would have told you Apple and Samsung were uncorrelated.

**Covariance matrices need shrinking.** With 30 names and two years of data you are
estimating 465 covariance terms from ~500 observations. The sample matrix is near-singular
and will hand you confidently insane optimal weights. Risk Lens applies Ledoit-Wolf shrinkage
toward a constant-correlation target (Ledoit & Wolf, 2003). On the test portfolio this pulls
the correlation spread from 0.54 to 0.33 at δ = 0.38.

**Currency conversion is as-of, not exact-match.** Equity and FX series do not share a
calendar — Seoul trades on days the FX series skips. An exact-date lookup misses, and the
tempting fallback is to use the local price unconverted. That is how a KRW price ends up
treated as DKK, and it does not look wrong on screen: the weights still sum to 100%, they are
just all wrong. (This project shipped that bug in v0.1.0 and it made Apple read 0.05% against
a true 20.3%. Every test passed while it was live, because normalised weights always sum to
one. The fix is a binary search for the nearest rate at or before the date; a position that
genuinely cannot be converted is excluded with a visible warning rather than counted in the
wrong unit.)

**Numbers are never faked.** Every statistic declares its data requirement. A position with
six months of history shows its weight and sector, and shows *"insufficient history"* where
its beta would be. Failed fetches are reported explicitly and the affected name is excluded
from every figure rather than silently zero-filled.

---

## Testing

Both harnesses slice code out of the shipped userscript rather than duplicating it, so they
test what actually ships. Both run against live Yahoo data for a deliberately awkward
portfolio — US + Japan + Korea + Denmark + a UCITS ETF; five currencies, three regions,
non-overlapping trading sessions.

```bash
node test/engine.test.mjs        # 20 checks on the maths
node test/csv.test.mjs           # 21 checks on import parsing
node test/ui.render.mjs out.html # 33 checks end to end, writes a preview
```

Euler's theorem (risk contributions sum to 1.000000000000), positive semi-definiteness via
Cholesky, shrinkage bounds, weekly-resample integrity, and that diversification actually
reduces volatility below the weighted average of its parts.

The render harness shims `GM_*` and a minimal DOM — including a cookie jar, since Node's
`fetch` has none and the crumb handshake would otherwise be untestable — then runs the real
`analyse()` and renders every tab to a standalone HTML preview.

One test deserves explanation. It converts Toyota's reported per-share value back through an
independently fetched spot rate and asserts the result is a plausible JPY price. That exists
because the v0.1.0 currency bug passed every other check: weights are normalised, so they sum
to 1 whether or not conversion happened. A test that cannot fail is not a test, and the
cheapest way to catch a unit error is to convert back and see if you land where you started.

---

## Status and known limits

**v1.0.0.** Engine, data layer and rendering are tested against live data. Be aware of these:

- **Browser-tested, but not exhaustively.** The button, ticker detection, the overlay, all
  four tabs, the scenario recompute and CSV import of a Danish semicolon file have been driven
  in Chrome against a live stockanalysis page — that pass found and fixed four bugs the
  headless harnesses could not see. Still unexercised: installation through Tampermonkey
  itself (testing injected the script directly), Firefox and Safari, dark-mode host pages,
  the SPA re-mount after client-side navigation, and drag-and-drop of a CSV file. Please open
  issues.
- Look-through covers each fund's **published top holdings** — typically the top ten. The
  remainder is reported as unitemised rather than silently dropped, but a name sitting at
  position 40 of an index fund will not appear by name.
- Yahoo's endpoints are internal, not a contracted API. Stable for years, but no guarantee.
  The cache, the stockanalysis fallback and the adapter boundary are the mitigation.
- Non-listed mutual fund share classes are hit-and-miss on Yahoo. Listed ETFs are reliable.
- Stress windows are historical replays at fixed weights. They are not factor shocks, and
  they assume your current book existed then — which it did not.
- Correlations and volatilities are backward-looking. They describe how these holdings *have*
  moved together, which is not a promise about the next crisis.
- Not investment advice. It is a calculator; the judgement stays yours.

---

## License

MIT — see [LICENSE](LICENSE).
