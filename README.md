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

![status](https://img.shields.io/badge/status-v0.1.0%20alpha-orange) ![license](https://img.shields.io/badge/license-MIT-blue)

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
Everything converted to your reporting currency at daily FX.

**Risk**
- **Risk contribution per position** — the share of portfolio volatility each name is
  responsible for. This is rarely its weight, and the gap is the whole point. In the test
  portfolio a 20% position in Novo Nordisk causes 33% of the risk while a 20% position in a
  world tracker causes 9%.
- **Clustered correlation heatmap** — co-moving names sorted together, so blocks of red
  reveal positions that are one bet wearing several tickers.
- **Sector / country / currency exposure** with **ETF look-through**, so a world tracker is
  decomposed into its underlying sector mix rather than scored as a single position.
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
| Daily prices, all markets | Yahoo `chart` | none | falls back to cache |
| FX (`USD{CUR}=X`) | Yahoo `chart` | none | falls back to cache |
| Sector, country, ETF holdings | Yahoo `quoteSummary` | cookie + crumb | lose labels, keep all risk math |

One upstream dependency, split so the fragile half is non-essential. Verified working across
US, Tokyo, Seoul, Xetra, Copenhagen, Amsterdam and UCITS ETFs. See
[docs/DATA-SOURCES.md](docs/DATA-SOURCES.md) for what else was tested and rejected, and the
fallback adapters designed but not yet needed.

---

## Three things this gets right that most retail tools don't

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
```

Euler's theorem (risk contributions sum to 1.000000000000), positive semi-definiteness via
Cholesky, shrinkage bounds, weekly-resample integrity, and that diversification actually
reduces volatility below the weighted average of its parts.

```bash
node test/ui.render.mjs preview.html    # 18 checks on the full pipeline
```

Shims `GM_*` and a minimal DOM — including a cookie jar, since Node's `fetch` has none and the
crumb handshake would otherwise be untestable — then runs the real `analyse()` and renders
every tab. Checks balanced SVG and table markup, that no `undefined` or `NaN` leaks into the
output, that stress windows are reachable at the default lookback, and that a failed profile
fetch surfaces as a visible warning rather than silent "Unknown" labels. Writes a standalone
HTML preview you can open in any browser.

---

## Status and limits

**v0.1.0, alpha.** The engine is tested; the UI has had far less mileage.

- Yahoo's endpoints are internal, not a contracted API. They have been stable for years but
  carry no guarantee. The cache and the adapter boundary are the mitigation.
- Non-listed mutual fund share classes are hit-and-miss on Yahoo. Listed ETFs are reliable.
- ETF look-through uses sector weights, not full holdings, so overlap between a tracker and a
  single name you also hold directly is not yet netted out.
- Stress windows are historical replays at fixed weights. They are not factor shocks.
- Not investment advice. It is a calculator; the judgement stays yours.

---

## License

MIT — see [LICENSE](LICENSE).
