# Data sources — what was tested, chosen and rejected

Every claim here was verified by direct request in August 2026, not taken from documentation.
The point of writing it down is so that when something breaks, the replacement is already
chosen and the reasoning doesn't have to be rediscovered.

## The constraint that shapes everything

Neither Yahoo nor stockanalysis returns an `access-control-allow-origin` header. A normal web
page cannot fetch either, from any domain. That is a browser security boundary, and it splits
every possible delivery medium into two camps:

- **Can reach the data:** userscript, browser extension, desktop app, or a server you operate.
- **Cannot:** hosted website, PWA, bookmarklet.

A userscript's `GM_xmlhttpRequest` is not subject to the page's CORS policy, which is the
entire reason this project is shaped the way it is.

## Chosen: Yahoo Finance

**Prices — `query1.finance.yahoo.com/v8/finance/chart/{symbol}`.** No key, no auth. Verified
5 years of daily bars with correct native currency:

| Symbol | Market | Bars | Currency |
|---|---|---|---|
| `AAPL` | US | 1255 | USD |
| `7203.T` | Tokyo | 1223 | JPY |
| `005930.KS` | Korea | 1220 | KRW |
| `SAP.DE` | Xetra | 1275 | EUR |
| `NOVO-B.CO` | Copenhagen | 1253 | DKK |
| `VWCE.DE` / `IWDA.AS` | UCITS ETFs | 1275 / 1281 | EUR |

Uses `adjclose` where available — split and dividend adjusted, which is the correct series
for return calculations.

**FX — same endpoint, `USD{CUR}=X`.** Verified consistent across DKK, EUR, JPY, KRW, SEK,
GBP: always *units of that currency per 1 USD*. Conversion between any two currencies is
therefore uniform, with no special-casing.

**Metadata — `query2.finance.yahoo.com/v10/finance/quoteSummary`.** Requires a cookie/crumb
handshake (prime `fc.yahoo.com`, then `/v1/test/getcrumb`). Returns sector and country for
equities in every market tested, and ETF look-through: `IWDA.AS` returned NVDA 5.17%, AAPL
4.76%, MSFT 2.95%, AMZN 2.58% plus a full sector breakdown.

This tier is deliberately isolated. If the crumb flow breaks, sector labels and look-through
degrade; every risk statistic is unaffected.

**Rate limiting.** The widely reported `YFRateLimitError` problem is a *volume* problem — it
hits code pulling thousands of symbols in loops. A cache-first design fetching ~30 symbols
once a day is nowhere near it.

## Rejected: Stooq

Was the obvious free choice and is now unusable. Every symbol — including plain `aapl.us` —
returns a proof-of-work JavaScript challenge (SHA-256 until four leading zero hex digits)
instead of CSV. Using it programmatically now means deliberately circumventing bot
protection. Not shipped.

## Rejected for v1: stockanalysis.com's own endpoints

Genuinely useful and worth revisiting. All respond **unauthenticated**:

| Endpoint | Returns |
|---|---|
| `/stocks/{t}/__data.json` | ~30 KB structured company data |
| `/etf/{t}/holdings/__data.json` | ETF constituents |
| `/api/quotes/s/{t}` | live quote |
| `/api/search?q=` | exchange-qualified symbols (`krx/…`, `kosdaq/…`) |
| `/api/symbol/s/{t}/history` | price history — AAPL back to **1982**, SPY to 1993 |

The search endpoint solves ticker reconciliation across US/Europe/Japan/Korea, which is
otherwise the hardest engineering problem in this project. The history endpoint is deeper
than most paid feeds.

Not used in v1 for two reasons: Yahoo alone already covers everything, and the international
history endpoint's URL shape is still unknown — the international *pages* and their
`__data.json` work, but history URL guesses returned 400. Determining it requires observing
network traffic on a logged-in international page.

**Legal posture.** `robots.txt` is `User-agent: * / Disallow:` — an empty disallow, permitting
everything for general crawlers; only three SEO spam bots are blocked. The Terms of Use
contain no clause on automated access, scraping, bots or data extraction. The single
restriction is on republishing content in full, which this tool never does: data is fetched by
the user's own browser and stays on their machine.

## Fallback adapters — designed, not yet needed

Ordered by what would be reached for first if Yahoo closed.

**stockanalysis history** — free, deep, already reachable. First fallback for prices.

**EODHD — $19.99/mo, official.** 60+ exchanges, 150,000 tickers, 100k calls/day, accepts
ISIN, CUSIP and FIGI directly. The honest worst case for this project: if every free source
died, $20/month restores full function, paid per-user and optional. No CORS headers, so it
works from a userscript but not a web page.

**OpenFIGI — free, no key, operated by Bloomberg, an OMG open standard.** Verified: querying
Samsung on KRX returned `BBG000BG4Q36`. The robust answer to identity. A FIGI survives ticker
changes, re-listings and mergers, so keying a portfolio on FIGI rather than on the string
`"AAPL"` eliminates a whole category of silent history corruption. Worth adopting before the
first user hits a ticker change.

**ECB Data Portal and Frankfurter — official FX, free, both send `CORS: *`.** Currency is the
one series you can never re-derive, so putting FX on official central-bank footing while
equities ride an unofficial feed is the right asymmetry.

**Ken French Data Library** — verified, 178 KB download. Free, academic, published
continuously for thirty years, covers global regions including Japan and Asia-Pacific. Would
enable factor decomposition (market/size/value/momentum) without any vendor relationship. The
most durable source in the stack.

**SEC EDGAR XBRL** — official, free, US fundamentals. Verified.

## Tested and set aside

| Source | Verdict |
|---|---|
| Twelve Data | `CORS: *`, official, but the free tier is US equities/FX/crypto only — global markets are paid. 800 calls/day, 8/min. |
| Alpha Vantage | `CORS: *` but 25 requests/day. Emergency use only. |
| Financial Modeling Prep | 250 calls/day free; demo token returns 401. |
| Marketstack | 100 requests/**month**. Not viable. |
| Tiingo | 403 without a key; EOD coverage is US-centric. |
| Finnhub | `CORS: *`, key required. |
| Polygon | US-only on cheap tiers. |
