// ==UserScript==
// @name         Portfolio Risk Lens
// @namespace    https://github.com/alfredbirkelund/portfolio-risk-lens
// @version      1.1.0
// @description  Portfolio construction and risk management overlay for stockanalysis.com. Correlation, risk contribution, currency/sector exposure with ETF look-through, scenario sandbox and vol-targeted sizing. All data stays on your machine.
// @author       Alfred Birkelund
// @license      MIT
// @match        https://stockanalysis.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addStyle
// @connect      query1.finance.yahoo.com
// @connect      query2.finance.yahoo.com
// @connect      fc.yahoo.com
// @connect      stockanalysis.com
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/alfredbirkelund/portfolio-risk-lens/main/portfolio-risk-lens.user.js
// @downloadURL  https://raw.githubusercontent.com/alfredbirkelund/portfolio-risk-lens/main/portfolio-risk-lens.user.js
// ==/UserScript==

/* eslint-disable no-console */
(function () {
  'use strict';

  const VERSION = '1.1.0';

  // ==========================================================================
  // 1. CONFIG
  // ==========================================================================

  const DEFAULTS = {
    base: 'USD',              // reporting currency
    benchmark: 'URTH',        // iShares MSCI World; '^GSPC' for S&P 500
    years: 10,                // history window; must reach the oldest stress window
    freq: 'auto',             // 'auto' | 'weekly' | 'daily'
    maxRiskPct: 30,           // flag positions contributing more than this share of risk
    barsTtlHours: 12,         // refetch bars older than this
    metaTtlDays: 30           // sector/holdings move slowly
  };

  // Minimum observations before a statistic is shown at all. Below this we
  // print "insufficient history" rather than a number derived from noise.
  const MIN_OBS = { daily: 60, weekly: 26 };

  // stockanalysis URL segment -> Yahoo suffix. Best-effort; unknown exchanges
  // fall back to manual entry rather than guessing wrong.
  const EXCHANGE_SUFFIX = {
    krx: '.KS', kosdaq: '.KQ', tyo: '.T', hkg: '.HK', sha: '.SS', shz: '.SZ',
    tpe: '.TW', sgx: '.SI', asx: '.AX', nse: '.NS', bom: '.BO',
    lon: '.L', epa: '.PA', etr: '.DE', fra: '.F', ams: '.AS', bru: '.BR',
    lis: '.LS', mil: '.MI', bme: '.MC', swx: '.SW', vie: '.VI', waw: '.WA',
    cph: '.CO', sto: '.ST', hel: '.HE', osl: '.OL', ice: '.IC',
    tsx: '.TO', tsxv: '.V', bmv: '.MX', bvmf: '.SA', jse: '.JO'
  };

  // ==========================================================================
  // 2. STORAGE  (GM storage, not site storage: survives clearing site data,
  //    isolated from the page, and never leaves the machine)
  // ==========================================================================

  const Store = {
    get: (k, d) => { try { return GM_getValue(k, d); } catch (e) { return d; } },
    set: (k, v) => { try { GM_setValue(k, v); } catch (e) { console.warn('[PRL] store', e); } },
    del: (k) => { try { GM_deleteValue(k); } catch (e) { /* noop */ } },
    keys: () => { try { return GM_listValues(); } catch (e) { return []; } }
  };

  const settings = () => Object.assign({}, DEFAULTS, Store.get('settings', {}));
  const saveSettings = (s) => Store.set('settings', Object.assign({}, settings(), s));

  /** Positions: [{sym, shares, cost, target, note}] — sym is a Yahoo symbol. */
  const positions = () => Store.get('positions', []);
  const savePositions = (p) => Store.set('positions', p);

  // ==========================================================================
  // 3. NETWORK  (GM_xmlhttpRequest is what makes this possible at all — it is
  //    not subject to the page's CORS policy, so we can read endpoints that a
  //    plain web page is forbidden from touching.)
  // ==========================================================================

  function httpGet(url, { timeout = 25000, responseType } = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout,
        responseType,
        onload: (r) => resolve({ status: r.status, text: r.responseText, response: r.response }),
        onerror: () => reject(new Error('network error: ' + url)),
        ontimeout: () => reject(new Error('timeout: ' + url))
      });
    });
  }

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  /**
   * Yahoo rate-limits on burst, not on volume. A portfolio refresh is a burst
   * of thirty-odd requests, so without pacing a user who hits Refresh twice
   * gets a wall of 429s and concludes the tool is broken. One in-flight
   * request at a time, a small gap between them, and exponential backoff on
   * 429/5xx keeps a normal refresh comfortably inside the limit.
   */
  const POLITE_GAP_MS = 120;
  const MAX_ATTEMPTS = 4;
  let queue = Promise.resolve();

  function enqueue(fn) {
    const next = queue.then(fn, fn);
    queue = next.then(() => sleep(POLITE_GAP_MS), () => sleep(POLITE_GAP_MS));
    return next;
  }

  async function getJSON(url, opts) {
    return enqueue(async () => {
      let wait = 900;
      for (let attempt = 1; ; attempt++) {
        const r = await httpGet(url, opts);
        if (r.status >= 200 && r.status < 300) {
          try { return JSON.parse(r.text); }
          catch (e) { throw new Error('bad JSON from ' + url); }
        }
        const retryable = r.status === 429 || r.status >= 500;
        if (!retryable || attempt >= MAX_ATTEMPTS) {
          throw new Error('HTTP ' + r.status + (r.status === 429 ? ' (rate limited — wait a minute and refresh)' : '') + ' for ' + url);
        }
        await sleep(wait);
        wait *= 2;
      }
    });
  }

  // ==========================================================================
  // 4. YAHOO ADAPTER
  //    Two tiers deliberately kept separate:
  //      - bars + FX   : no auth, the load-bearing path
  //      - meta        : needs a cookie/crumb handshake; if it breaks we lose
  //                      sector labels and ETF look-through, never risk math.
  // ==========================================================================

  const Yahoo = {
    _crumb: null,

    async crumb() {
      if (this._crumb) return this._crumb;
      // Priming call sets the cookie GM_xmlhttpRequest will send back.
      try { await enqueue(() => httpGet('https://fc.yahoo.com', { timeout: 12000 })); } catch (e) { /* expected to 404 */ }
      const r = await enqueue(() => httpGet('https://query2.finance.yahoo.com/v1/test/getcrumb', { timeout: 12000 }));
      const c = (r.text || '').trim();
      if (!c || c.length > 32 || /[<>]/.test(c)) throw new Error('no crumb');
      this._crumb = c;
      return c;
    },

    /** Daily close series. Returns {currency, rows:[[isoDate, close]]}. */
    async bars(symbol, years) {
      const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
        encodeURIComponent(symbol) + '?range=' + years + 'y&interval=1d';
      const j = await getJSON(url);
      const res = j && j.chart && j.chart.result && j.chart.result[0];
      if (!res) throw new Error('no data for ' + symbol);
      const ts = res.timestamp || [];
      const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
      // adjclose is split/dividend adjusted — the correct series for returns.
      const adj = res.indicators && res.indicators.adjclose && res.indicators.adjclose[0];
      const close = (adj && adj.adjclose) || q.close || [];
      const rows = [];
      for (let i = 0; i < ts.length; i++) {
        const c = close[i];
        if (c === null || c === undefined || !isFinite(c)) continue;
        rows.push([isoDay(ts[i] * 1000), c]);
      }
      if (!rows.length) throw new Error('empty series for ' + symbol);
      return { currency: (res.meta && res.meta.currency) || 'USD', rows };
    },

    /** Sector / country / ETF holdings. Optional enrichment. */
    async meta(symbol) {
      const crumb = await this.crumb();
      const url = 'https://query2.finance.yahoo.com/v10/finance/quoteSummary/' +
        encodeURIComponent(symbol) +
        '?modules=assetProfile,topHoldings,quoteType&crumb=' + encodeURIComponent(crumb);
      const j = await getJSON(url);
      const root = (j.quoteSummary || j.finance || {});
      const res = root.result && root.result[0];
      if (!res) throw new Error('no meta for ' + symbol);
      const prof = res.assetProfile || {};
      const th = res.topHoldings || {};
      const qt = res.quoteType || {};
      const raw = (v) => (v && typeof v === 'object' && 'raw' in v) ? v.raw : v;
      return {
        sector: prof.sector || null,
        country: prof.country || null,
        industry: prof.industry || null,
        type: qt.quoteType || null,          // EQUITY | ETF | MUTUALFUND
        name: qt.longName || qt.shortName || null,
        holdings: (th.holdings || []).map((h) => ({
          sym: h.symbol || null, name: h.holdingName || null, w: raw(h.holdingPercent) || 0
        })),
        sectorWeights: (th.sectorWeightings || []).map((o) => {
          const k = Object.keys(o)[0];
          return { sector: prettySector(k), w: raw(o[k]) || 0 };
        })
      };
    }
  };

  // ==========================================================================
  // 4b. STOCKANALYSIS ADAPTER  (fallback price source)
  //
  //    Same origin as the page we run on, so no extra permission is needed.
  //    Its history goes deeper than most paid feeds — AAPL back to 1982 — but
  //    only US-listed symbols are addressable through this route, so it is a
  //    fallback for the US sleeve rather than a general replacement.
  // ==========================================================================

  /** Keep only the trailing `years` of a [[isoDate, value]] series. */
  function trimToYears(rows, years) {
    if (!years || !rows || rows.length < 2) return rows;
    const cut = new Date(Date.now() - years * 365.25 * 864e5).toISOString().slice(0, 10);
    const i = rows.findIndex((r) => r[0] >= cut);
    return i > 0 ? rows.slice(i) : rows;
  }

  const StockAnalysis = {
    supports: (symbol) => !/[.=^]/.test(symbol),   // plain US tickers only

    async bars(symbol) {
      if (!this.supports(symbol)) throw new Error('unsupported symbol');
      const t = symbol.toLowerCase();
      let j = null;
      for (const kind of ['s', 'e']) {           // stock, then ETF
        try {
          j = await getJSON(`https://stockanalysis.com/api/symbol/${kind}/${t}/history?type=chart&range=10Y`);
          if (j && j.status === 200 && Array.isArray(j.data) && j.data.length) break;
          j = null;
        } catch (e) { j = null; }
      }
      if (!j) throw new Error('no stockanalysis data for ' + symbol);
      const rows = j.data
        .filter((d) => Array.isArray(d) && isFinite(d[1]))
        .map((d) => [isoDay(d[0]), d[1]]);
      if (!rows.length) throw new Error('empty stockanalysis series for ' + symbol);
      return { currency: 'USD', rows };
    }
  };

  // ==========================================================================
  // 5. CACHE  — the cache is the source of truth. Yahoo is only ever consulted
  //    for bars we do not already have. If every endpoint died tomorrow the
  //    tool still runs on everything ever loaded.
  // ==========================================================================

  const Cache = {
    async bars(symbol, { force = false } = {}) {
      const key = 'bars:' + symbol;
      const hit = Store.get(key, null);
      const ttl = settings().barsTtlHours * 3600e3;
      if (!force && hit && (Date.now() - hit.fetched) < ttl) return hit;

      // Tier 1: Yahoo. Tier 2: stockanalysis (US only). Tier 3: whatever is
      // already cached, flagged stale. The tool degrades; it does not stop.
      const tried = [];
      for (const src of [
        { name: 'yahoo', get: () => Yahoo.bars(symbol, settings().years) },
        { name: 'stockanalysis', get: () => StockAnalysis.bars(symbol) }
      ]) {
        try {
          const fresh = await src.get();
          // Sources honour the requested window inconsistently — stockanalysis
          // ignores it entirely and hands back everything it has, which for
          // AAPL is 11,000 bars from 1982. Trim centrally so the lookback
          // setting means the same thing whichever tier answered, and so the
          // cache does not quietly grow to megabytes.
          const rows = trimToYears(fresh.rows, settings().years);
          const rec = { fetched: Date.now(), currency: fresh.currency, rows, source: src.name, stale: false };
          Store.set(key, rec);
          return rec;
        } catch (e) { tried.push(`${src.name}: ${e.message || e}`); }
      }
      if (hit) return Object.assign({}, hit, { stale: true, error: tried.join(' | ') });
      throw new Error(tried.join(' | '));
    },

    async meta(symbol, { force = false } = {}) {
      const key = 'meta:' + symbol;
      const hit = Store.get(key, null);
      const ttl = settings().metaTtlDays * 86400e3;
      if (!force && hit && (Date.now() - hit.fetched) < ttl) return hit;
      try {
        const fresh = await Yahoo.meta(symbol);
        const rec = Object.assign({ fetched: Date.now() }, fresh);
        Store.set(key, rec);
        return rec;
      } catch (e) {
        return hit || { fetched: 0, sector: null, country: null, type: null, holdings: [], sectorWeights: [], error: String(e.message || e) };
      }
    },

    /** FX: units of `cur` per 1 USD, as an iso->rate map. USD is the identity. */
    async fx(cur, { force = false } = {}) {
      if (cur === 'USD') return { currency: 'USD', map: null };
      const sym = 'USD' + cur + '=X';
      const rec = await this.bars(sym, { force });
      const map = new Map();
      for (const [d, v] of rec.rows) map.set(d, v);
      return { currency: cur, map, stale: rec.stale };
    },

    clearPrices() {
      for (const k of Store.keys()) if (k.indexOf('bars:') === 0) Store.del(k);
    },

    stats() {
      let bars = 0, meta = 0, bytes = 0;
      for (const k of Store.keys()) {
        const v = Store.get(k, null);
        const n = JSON.stringify(v || '').length;
        bytes += n;
        if (k.indexOf('bars:') === 0) bars++;
        if (k.indexOf('meta:') === 0) meta++;
      }
      return { bars, meta, kb: Math.round(bytes / 1024) };
    }
  };

  // ==========================================================================
  // 6. MATH
  // ==========================================================================

  const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

  function prettySector(k) {
    return String(k).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
      .replace('Realestate', 'Real Estate');
  }

  /**
   * Align price series onto a common date grid.
   * Forward-fills each series (a stale close is better than a hole), then keeps
   * only dates where every series has a value. Series are converted to `base`
   * currency first so asset moves and FX moves can be separated later.
   */
  function alignSeries(seriesList) {
    const dates = new Set();
    for (const s of seriesList) for (const [d] of s.rows) dates.add(d);
    const grid = Array.from(dates).sort();

    const filled = seriesList.map((s) => {
      const m = new Map(s.rows);
      const out = new Array(grid.length).fill(null);
      let last = null;
      for (let i = 0; i < grid.length; i++) {
        const v = m.get(grid[i]);
        if (v !== undefined) last = v;
        out[i] = last;
      }
      return out;
    });

    // Trim leading dates where any series has no observation yet.
    let start = 0;
    for (let i = 0; i < grid.length; i++) {
      if (filled.every((f) => f[i] !== null)) { start = i; break; }
      if (i === grid.length - 1) return { dates: [], cols: seriesList.map(() => []) };
    }
    return { dates: grid.slice(start), cols: filled.map((f) => f.slice(start)) };
  }

  /** Keep the last observation of each ISO week. Removes cross-region session-lag bias. */
  function toWeekly(dates, cols) {
    const keep = [];
    for (let i = 0; i < dates.length; i++) {
      const isLast = i === dates.length - 1 || weekKey(dates[i + 1]) !== weekKey(dates[i]);
      if (isLast) keep.push(i);
    }
    return { dates: keep.map((i) => dates[i]), cols: cols.map((c) => keep.map((i) => c[i])) };
  }

  function weekKey(iso) {
    const d = new Date(iso + 'T00:00:00Z');
    const day = (d.getUTCDay() + 6) % 7;          // Mon=0
    d.setUTCDate(d.getUTCDate() - day + 3);        // Thursday of this ISO week
    return d.toISOString().slice(0, 10);
  }

  /** Simple returns, T x N. */
  function returnsMatrix(cols) {
    const T = cols[0].length - 1;
    const R = [];
    for (let t = 0; t < T; t++) {
      const row = new Array(cols.length);
      for (let j = 0; j < cols.length; j++) {
        const p0 = cols[j][t], p1 = cols[j][t + 1];
        row[j] = (p0 && isFinite(p0) && isFinite(p1)) ? (p1 / p0 - 1) : 0;
      }
      R.push(row);
    }
    return R;
  }

  const colMeans = (R) => {
    const N = R[0].length, m = new Array(N).fill(0);
    for (const r of R) for (let j = 0; j < N; j++) m[j] += r[j];
    return m.map((v) => v / R.length);
  };

  function sampleCov(R) {
    const T = R.length, N = R[0].length, mu = colMeans(R);
    const S = Array.from({ length: N }, () => new Array(N).fill(0));
    for (const r of R) {
      for (let i = 0; i < N; i++) {
        const di = r[i] - mu[i];
        for (let j = i; j < N; j++) {
          const v = di * (r[j] - mu[j]);
          S[i][j] += v;
          if (i !== j) S[j][i] += v;
        }
      }
    }
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) S[i][j] /= T;
    return S;
  }

  /**
   * Ledoit-Wolf shrinkage toward the constant-correlation target.
   *
   * With ~30 names and a few hundred observations the sample covariance matrix
   * is near-singular: it has more free parameters than the data can support and
   * produces confidently insane optimal weights. Shrinking it toward a
   * structured target is what makes position sizing trustworthy.
   *
   * Ledoit & Wolf (2003), "Honey, I Shrunk the Sample Covariance Matrix".
   */
  function ledoitWolf(R) {
    const T = R.length, N = R[0].length;
    const S = sampleCov(R);
    const mu = colMeans(R);
    const sd = S.map((row, i) => Math.sqrt(Math.max(row[i], 1e-18)));

    // average pairwise correlation
    let rSum = 0, rN = 0;
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
      rSum += S[i][j] / (sd[i] * sd[j]); rN++;
    }
    const rBar = rN ? rSum / rN : 0;

    // target F
    const F = Array.from({ length: N }, () => new Array(N).fill(0));
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      F[i][j] = (i === j) ? S[i][i] : rBar * sd[i] * sd[j];
    }

    // pi: sum of asymptotic variances of the sample covariance entries
    const PI = Array.from({ length: N }, () => new Array(N).fill(0));
    for (const r of R) {
      for (let i = 0; i < N; i++) {
        const di = r[i] - mu[i];
        for (let j = 0; j < N; j++) {
          const d = di * (r[j] - mu[j]) - S[i][j];
          PI[i][j] += d * d;
        }
      }
    }
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) PI[i][j] /= T;
    let piHat = 0;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) piHat += PI[i][j];

    // rho: covariance between target and sample estimation error
    let rhoHat = 0;
    for (let i = 0; i < N; i++) rhoHat += PI[i][i];
    const theta = (i, j) => {           // cov( (x_i - m_i)^2 , (x_i-m_i)(x_j-m_j) )
      let s = 0;
      for (const r of R) {
        const di = r[i] - mu[i], dj = r[j] - mu[j];
        s += (di * di - S[i][i]) * (di * dj - S[i][j]);
      }
      return s / T;
    };
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      if (i === j) continue;
      rhoHat += (rBar / 2) * ((sd[j] / sd[i]) * theta(i, j) + (sd[i] / sd[j]) * theta(j, i));
    }

    // gamma: misspecification of the target
    let gammaHat = 0;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const d = F[i][j] - S[i][j]; gammaHat += d * d;
    }

    let delta = gammaHat > 0 ? ((piHat - rhoHat) / gammaHat) / T : 0;
    delta = Math.max(0, Math.min(1, delta));

    const Sig = Array.from({ length: N }, () => new Array(N).fill(0));
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      Sig[i][j] = delta * F[i][j] + (1 - delta) * S[i][j];
    }
    return { Sigma: Sig, delta, sample: S };
  }

  function corrFromCov(S) {
    const N = S.length, sd = S.map((r, i) => Math.sqrt(Math.max(r[i], 1e-18)));
    return S.map((row, i) => row.map((v, j) => clamp(v / (sd[i] * sd[j]), -1, 1)));
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const matVec = (M, v) => M.map((row) => row.reduce((s, x, j) => s + x * v[j], 0));
  const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

  /** Average-linkage clustering on correlation distance; returns a leaf order. */
  function clusterOrder(C) {
    const N = C.length;
    if (N < 3) return C.map((_, i) => i);
    let clusters = C.map((_, i) => [i]);
    const dist = (a, b) => {
      let s = 0;
      for (const i of a) for (const j of b) s += Math.sqrt(Math.max(0, 2 * (1 - C[i][j])));
      return s / (a.length * b.length);
    };
    while (clusters.length > 1) {
      let bi = 0, bj = 1, best = Infinity;
      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          const d = dist(clusters[i], clusters[j]);
          if (d < best) { best = d; bi = i; bj = j; }
        }
      }
      const merged = clusters[bi].concat(clusters[bj]);
      clusters = clusters.filter((_, k) => k !== bi && k !== bj);
      clusters.push(merged);
    }
    return clusters[0];
  }

  function maxDrawdown(rets) {
    let peak = 1, v = 1, mdd = 0, from = 0, at = 0, peakIdx = 0;
    for (let i = 0; i < rets.length; i++) {
      v *= (1 + rets[i]);
      if (v > peak) { peak = v; peakIdx = i; }
      const dd = v / peak - 1;
      if (dd < mdd) { mdd = dd; from = peakIdx; at = i; }
    }
    return { mdd, from, at };
  }

  // ==========================================================================
  // 7. RISK ENGINE
  // ==========================================================================

  async function analyse(onProgress = () => {}, force = false) {
    const S = settings();

    // Rows the user typed that cannot be used must be *named*, not quietly
    // dropped. A position that silently vanishes reads as "I don't own that",
    // which is the most expensive kind of wrong in a risk tool.
    const invalid = [];
    const merged = [];
    const byIndex = new Map();
    for (const p of positions()) {
      const sym = String(p.sym || '').trim().toUpperCase();
      if (!sym) continue;
      const n = Number(p.shares);
      if (!isFinite(n) || n <= 0) {
        invalid.push(`${sym} (shares "${String(p.shares || '').slice(0, 12)}")`);
        continue;
      }
      if (byIndex.has(sym)) {
        // Two rows of one ticker is one position. Keeping both would also put a
        // perfectly-correlated pair into the covariance matrix and distort it.
        const e = merged[byIndex.get(sym)];
        e.shares = String(Number(e.shares) + n);
        e.note = e.note || p.note;
        e.duplicated = true;
      } else {
        byIndex.set(sym, merged.length);
        merged.push(Object.assign({}, p, { sym, shares: String(n) }));
      }
    }
    const duplicates = merged.filter((p) => p.duplicated).map((p) => p.sym);
    const pos = merged;
    if (!pos.length) return { empty: true, invalid, failures: [] };

    const syms = pos.map((p) => p.sym);
    const wanted = syms.concat([S.benchmark]);

    // --- fetch bars -------------------------------------------------------
    // Null-prototype: these are keyed by user-supplied symbols and vendor
    // currency codes, so an inherited property must never masquerade as a hit.
    const barsBySym = Object.create(null);
    const failures = [];
    for (let i = 0; i < wanted.length; i++) {
      const s = wanted[i];
      onProgress(`prices ${i + 1}/${wanted.length} · ${s}`);
      try { barsBySym[s] = await Cache.bars(s, { force }); }
      catch (e) { failures.push({ sym: s, why: String(e.message || e) }); }
    }
    const live = pos.filter((p) => barsBySym[p.sym]);
    if (!live.length) return { empty: true, failures };

    // --- fx ---------------------------------------------------------------
    const currencies = Array.from(new Set(live.map((p) => barsBySym[p.sym].currency)));
    const fx = Object.create(null);
    for (const c of currencies) {
      onProgress(`fx · ${c}`);
      try { fx[c] = await Cache.fx(c, { force }); }
      catch (e) { failures.push({ sym: 'USD' + c + '=X', why: String(e.message || e) }); }
    }
    const baseFx = S.base === 'USD' ? { map: null } : (fx[S.base] || await Cache.fx(S.base).catch(() => ({ map: null })));

    // FX lookup must be as-of, not exact-match. Equity and FX series do not
    // share a calendar — Seoul trades on days the FX series skips and vice
    // versa — so requiring an exact date hit would silently drop conversions
    // and leave prices in their local currency. A KRW price treated as DKK
    // does not look wrong on screen; it just makes every weight a lie.
    const fxIndex = Object.create(null);
    const indexOf = (cur) => {
      if (fxIndex[cur] !== undefined) return fxIndex[cur];
      const map = fx[cur] && fx[cur].map;
      fxIndex[cur] = map ? { dates: Array.from(map.keys()).sort(), map } : null;
      return fxIndex[cur];
    };
    if (S.base !== 'USD' && !fx[S.base] && baseFx && baseFx.map) fx[S.base] = baseFx;

    /** Units of `cur` per 1 USD, as of `date` (nearest observation at or before). */
    const rateAt = (cur, date) => {
      if (cur === 'USD') return 1;
      const ix = indexOf(cur);
      if (!ix) return null;
      const hit = ix.map.get(date);
      if (hit) return hit;
      const { dates } = ix;
      let lo = 0, hi = dates.length - 1, best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (dates[mid] <= date) { best = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (best < 0) best = 0;                       // before the FX series starts
      return ix.map.get(dates[best]) || null;
    };

    const fxUnavailable = new Set();
    const convert = (price, cur, date) => {
      if (cur === S.base) return price;
      const perLocal = rateAt(cur, date);
      const perBase = rateAt(S.base, date);
      if (!perLocal || !perBase) { fxUnavailable.add(cur); return null; }
      return price * (1 / perLocal) * perBase;
    };

    const toBase = (rows, cur) => {
      if (cur === S.base) return rows;
      const out = [];
      for (const [d, p] of rows) {
        const v = convert(p, cur, d);
        if (v !== null) out.push([d, v]);
      }
      return out;
    };

    // --- meta (optional) ---------------------------------------------------
    // Enrichment only, but its failure must still be visible: silently showing
    // every holding as sector "Unknown" would look like real data.
    const metaBySym = Object.create(null);
    let metaFailed = 0;
    for (let i = 0; i < live.length; i++) {
      onProgress(`profile ${i + 1}/${live.length}`);
      const m = await Cache.meta(live[i].sym);
      if (m.error) metaFailed++;
      metaBySym[live[i].sym] = m;
    }

    // --- weights -----------------------------------------------------------
    const unconverted = [];
    const valueOf = (p) => {
      const rec = barsBySym[p.sym];
      const [lastDate, lastPx] = rec.rows[rec.rows.length - 1];
      const px = convert(lastPx, rec.currency, lastDate);
      if (px === null) {
        // Refuse to mix currencies silently. The position is reported, but its
        // value is withheld rather than quoted in the wrong unit.
        unconverted.push(`${p.sym} (${rec.currency})`);
        return null;
      }
      return Number(p.shares) * px;
    };
    const values = live.map(valueOf);
    const total = values.reduce((a, b) => a + (b || 0), 0);
    const w = values.map((v) => (total > 0 && v ? v / total : 0));

    // --- align & returns ---------------------------------------------------
    const seriesList = live.map((p) => ({
      rows: toBase(barsBySym[p.sym].rows, barsBySym[p.sym].currency)
    }));
    const localList = live.map((p) => ({ rows: barsBySym[p.sym].rows }));

    let { dates, cols } = alignSeries(seriesList);
    let localCols = alignSeries(localList).cols;

    // Cross-region portfolios need weekly sampling: Tokyo closes ~14h before
    // New York on the same date stamp, which biases daily correlations toward
    // zero and makes the book look more diversified than it is.
    const regions = new Set(live.map((p) => regionOf(barsBySym[p.sym].currency)));
    const freq = S.freq === 'auto' ? (regions.size > 1 ? 'weekly' : 'daily') : S.freq;
    if (freq === 'weekly') {
      const wk = toWeekly(dates, cols); dates = wk.dates; cols = wk.cols;
      localCols = toWeekly(alignSeries(localList).dates, localCols).cols;
    }
    const periodsPerYear = freq === 'weekly' ? 52 : 252;
    const enough = dates.length - 1 >= MIN_OBS[freq];

    let risk = null;
    if (enough && live.length >= 2) {
      const R = returnsMatrix(cols);
      const { Sigma, delta } = ledoitWolf(R);
      const C = corrFromCov(Sigma);
      const Sw = matVec(Sigma, w);
      const varP = Math.max(dot(w, Sw), 1e-18);
      const volP = Math.sqrt(varP);

      const contrib = w.map((wi, i) => (wi * Sw[i]) / varP);   // sums to 1
      const assetVol = Sigma.map((r, i) => Math.sqrt(Math.max(r[i], 1e-18)) * Math.sqrt(periodsPerYear));

      // portfolio return series at current weights
      const rp = R.map((row) => dot(w, row));
      const dd = maxDrawdown(rp);

      // FX contribution: same portfolio measured in local currency terms
      const Rl = returnsMatrix(localCols);
      const rpLocal = Rl.map((row) => dot(w, row));
      const volLocal = Math.sqrt(variance(rpLocal)) * Math.sqrt(periodsPerYear);

      // beta vs benchmark
      let beta = null;
      const bRec = barsBySym[S.benchmark];
      if (bRec) {
        const bSeries = toBase(bRec.rows, bRec.currency);
        let al = alignSeries([{ rows: bSeries }].concat(seriesList));
        if (freq === 'weekly') al = toWeekly(al.dates, al.cols);
        if (al.dates.length - 1 >= MIN_OBS[freq]) {
          const Rb = returnsMatrix(al.cols);
          const rb = Rb.map((r) => r[0]);
          const rpAl = Rb.map((r) => dot(w, r.slice(1)));
          beta = covariance(rpAl, rb) / Math.max(variance(rb), 1e-18);
        }
      }

      risk = {
        C, Sigma, delta, contrib, assetVol,
        volAnn: volP * Math.sqrt(periodsPerYear),
        volLocalAnn: volLocal,
        rp, R, dates: dates.slice(1), dd, beta,
        order: clusterOrder(C)
      };
    }

    // --- exposures with ETF look-through ----------------------------------
    const exposures = buildExposures(live, w, metaBySym, barsBySym);

    return {
      empty: false, base: S.base, freq, periodsPerYear, enough,
      obs: Math.max(0, dates.length - 1),
      positions: live.map((p, i) => ({
        ...p, value: values[i], weight: w[i],
        currency: barsBySym[p.sym].currency,
        source: barsBySym[p.sym].source,
        stale: barsBySym[p.sym].stale,
        meta: metaBySym[p.sym] || {}
      })),
      total, risk, exposures, failures,
      warnings: buildWarnings(live, barsBySym, metaFailed, unconverted, invalid, duplicates)
    };
  }

  const variance = (a) => { const m = a.reduce((s, x) => s + x, 0) / a.length; return a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length; };
  const covariance = (a, b) => {
    const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length;
    return a.reduce((s, x, i) => s + (x - ma) * (b[i] - mb), 0) / a.length;
  };

  function regionOf(cur) {
    if (['JPY', 'KRW', 'HKD', 'CNY', 'TWD', 'SGD', 'INR', 'AUD'].includes(cur)) return 'APAC';
    if (['USD', 'CAD', 'BRL', 'MXN'].includes(cur)) return 'AMER';
    return 'EMEA';
  }

  /** Root symbol for cross-source matching: AAPL == AAPL, 7203.T == 7203. */
  const rootSym = (s) => String(s || '').split('.')[0].toUpperCase();

  const isFundMeta = (m) => m.type === 'ETF' || m.type === 'MUTUALFUND' ||
    (m.sectorWeights || []).length > 0 || (m.holdings || []).length > 0;

  /**
   * Sector / country / currency exposure, plus security-level look-through.
   *
   * The look-through is the point of the whole exercise: if you hold a world
   * tracker at 36% and Apple directly at 12%, your real Apple exposure is not
   * 12% — it is 12% plus 4.76% of the tracker. Nothing in a holdings list
   * shows you that, and it is exactly the concentration people get wrong.
   */
  function buildExposures(live, w, metaBySym, barsBySym) {
    const sector = new Map(), country = new Map(), currency = new Map();
    const add = (m, k, v) => m.set(k || 'Unknown', (m.get(k || 'Unknown') || 0) + v);

    // key -> { name, direct, indirect, via:Set }
    const look = new Map();
    const touch = (key, name) => {
      if (!look.has(key)) look.set(key, { key, name: name || key, direct: 0, indirect: 0, via: new Set() });
      const e = look.get(key);
      if (name && (e.name === e.key)) e.name = name;
      return e;
    };

    let unitemised = 0;   // fund weight not covered by the published top holdings

    live.forEach((p, i) => {
      const meta = metaBySym[p.sym] || {};
      add(currency, barsBySym[p.sym].currency, w[i]);
      const fund = isFundMeta(meta);

      if (fund && (meta.sectorWeights || []).length) {
        // Distribute the fund's weight across its sector mix so a world tracker
        // is not scored as one concentrated position.
        const sw = meta.sectorWeights.filter((s) => s.w > 0);
        const tot = sw.reduce((a, b) => a + b.w, 0) || 1;
        for (const s of sw) add(sector, s.sector, w[i] * (s.w / tot));
        add(country, 'Diversified fund', w[i]);
      } else {
        add(sector, meta.sector, w[i]);
        add(country, meta.country, w[i]);
      }

      if (fund && (meta.holdings || []).length) {
        let covered = 0;
        for (const h of meta.holdings) {
          if (!(h.w > 0)) continue;
          covered += h.w;
          const e = touch(rootSym(h.sym || h.name), h.name || h.sym);
          e.indirect += w[i] * h.w;
          e.via.add(p.sym);
        }
        const rest = Math.max(0, 1 - covered);
        unitemised += w[i] * rest;
        if (rest > 0) {
          const e = touch('~rest:' + p.sym, `Rest of ${p.sym} (not itemised)`);
          e.indirect += w[i] * rest;
          e.via.add(p.sym);
        }
      } else {
        const e = touch(rootSym(p.sym), meta.name || p.sym);
        e.direct += w[i];
      }
    });

    const srt = (m) => Array.from(m, ([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v);
    const lookthrough = Array.from(look.values())
      .map((e) => ({ ...e, total: e.direct + e.indirect, via: Array.from(e.via) }))
      .sort((a, b) => b.total - a.total);

    return {
      sector: srt(sector), country: srt(country), currency: srt(currency),
      lookthrough, unitemised,
      // names held both directly and inside a fund — the hidden concentration
      overlaps: lookthrough.filter((e) => e.direct > 0 && e.indirect > 0)
    };
  }

  function buildWarnings(live, barsBySym, metaFailed, unconverted, invalid, duplicates) {
    const out = [];
    if (invalid && invalid.length) {
      out.push(`Ignored ${invalid.length} row(s) with a missing or non-positive share count: ${invalid.join(', ')}. Fix the share count to include them.`);
    }
    if (duplicates && duplicates.length) {
      out.push(`Combined duplicate rows for ${duplicates.join(', ')} into one position each. Two rows of one ticker would also have entered the correlation matrix as a perfectly-correlated pair and distorted it.`);
    }
    if (unconverted && unconverted.length) {
      out.push(`No exchange rate available for ${unconverted.join(', ')} — these positions are excluded from weights and totals rather than counted in the wrong currency.`);
    }
    if (metaFailed) {
      out.push(metaFailed === live.length
        ? 'Company profiles unavailable (the Yahoo crumb handshake failed) — sector and country show as Unknown and ETF look-through is off. Prices, correlation and every risk figure are unaffected.'
        : `${metaFailed} of ${live.length} company profiles unavailable — those positions show sector Unknown.`);
    }
    for (const p of live) {
      const rec = barsBySym[p.sym];
      if (rec.stale) out.push(`${p.sym}: using cached prices (refresh failed)`);
      if (rec.rows.length < 120) out.push(`${p.sym}: only ${rec.rows.length} daily observations`);
    }
    return out;
  }

  // ==========================================================================
  // 7b. CSV IMPORT / EXPORT
  //
  //    Nobody types thirty positions by hand. Import has to survive whatever
  //    the user's broker or spreadsheet emits — including the European
  //    convention of semicolon delimiters with comma decimal separators, which
  //    a naive split(',') turns into silent garbage.
  // ==========================================================================

  const CSV_FIELDS = ['sym', 'shares', 'cost', 'target', 'note'];
  // Aliases are compared after stripping every non-a-z character, so Nordic
  // headers appear here in both their transliterated and stripped forms
  // ("Vægt" -> "vgt", "Vaegt" -> "vaegt"). Broker exports are the realistic
  // import source and they are not in English.
  const HEADER_ALIASES = {
    sym: ['sym', 'symbol', 'ticker', 'yahoo', 'code', 'instrument', 'security',
          'vrdipapir', 'vaerdipapir', 'papir', 'aktie', 'namn', 'navn', 'name'],
    shares: ['shares', 'quantity', 'qty', 'units', 'amount', 'position', 'holding',
             'antal', 'antall', 'stk', 'stykk', 'anzahl'],
    cost: ['cost', 'costbasis', 'price', 'avgprice', 'averageprice', 'buyprice',
           'unitcost', 'gak', 'kurs', 'kjopskurs', 'kobskurs', 'anskaffelseskurs', 'preis'],
    target: ['target', 'targetweight', 'targetpct', 'targetallocation', 'weight',
             'allocation', 'maal', 'ml', 'vgt', 'vaegt', 'vekt', 'vikt', 'andel'],
    note: ['note', 'notes', 'thesis', 'comment', 'remark', 'kommentar', 'notat', 'anmerkung']
  };

  function parseCSV(text) {
    const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return { rows: [], error: 'empty input' };

    // Delimiter: whichever is more common in the first line.
    const head = lines[0];
    const semi = (head.match(/;/g) || []).length;
    const comma = (head.match(/,/g) || []).length;
    const tab = (head.match(/\t/g) || []).length;
    const delim = tab > Math.max(semi, comma) ? '\t' : (semi > comma ? ';' : ',');
    // With semicolon delimiters, commas are decimal separators.
    const decimalComma = delim === ';';

    const split = (line) => {
      const out = []; let cur = '', q = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
        else if (c === delim && !q) { out.push(cur); cur = ''; }
        else cur += c;
      }
      out.push(cur);
      return out.map((s) => s.trim());
    };

    const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, '');
    const first = split(lines[0]);
    const mapped = first.map((h) => {
      const n = norm(h);
      return CSV_FIELDS.find((f) => HEADER_ALIASES[f].includes(n)) || null;
    });
    const hasHeader = mapped.filter(Boolean).length >= 2;
    const cols = hasHeader ? mapped : CSV_FIELDS.slice(0, first.length);

    const numeric = (v) => {
      if (v == null) return '';
      let s = String(v).replace(/[^\d.,\-]/g, '');
      if (!s) return '';
      if (decimalComma) s = s.replace(/\./g, '').replace(',', '.');
      else if ((s.match(/,/g) || []).length && !/\.\d/.test(s)) s = s.replace(/,/g, '');
      else s = s.replace(/,/g, '');
      return s;
    };

    const rows = [];
    const skipped = [];
    for (const line of lines.slice(hasHeader ? 1 : 0)) {
      const cells = split(line);
      const o = { sym: '', shares: '', cost: '', target: '', note: '' };
      cols.forEach((f, i) => { if (f && cells[i] !== undefined) o[f] = cells[i]; });
      o.sym = (o.sym || '').replace(/^["']|["']$/g, '').toUpperCase();
      o.shares = numeric(o.shares);
      o.cost = numeric(o.cost);
      o.target = numeric(o.target);
      if (!o.sym || !/^[A-Z0-9][A-Z0-9.\-=^]*$/.test(o.sym)) { skipped.push(line); continue; }
      rows.push(o);
    }
    return { rows, skipped, delim, hasHeader, decimalComma };
  }

  function positionsToCSV(pos) {
    const q = (v) => {
      let s = String(v == null ? '' : v);
      // Neutralise spreadsheet formula injection. Excel and Sheets execute any
      // cell beginning with = + - @ or a control character, so an exported
      // thesis note is an attack surface the moment the file is opened. The
      // leading apostrophe is stripped again by the numeric parser on import.
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return ['symbol,shares,cost,target,note']
      .concat(pos.map((p) => CSV_FIELDS.map((f) => q(p[f])).join(',')))
      .join('\n');
  }

  function download(name, text, mime) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime || 'text/plain' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ==========================================================================
  // 8. UI
  // ==========================================================================

  const PALETTE = {
    light: {
      surface: '#fcfcfb', plane: '#f9f9f7', ink: '#0b0b0b', ink2: '#52514e',
      muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7', border: 'rgba(11,11,11,0.10)',
      s1: '#2a78d6', s2: '#eb6834', s3: '#1baf7a',
      good: '#0ca30c', warn: '#fab219', crit: '#d03b3b',
      divNeg: '#2a78d6', divPos: '#d03b3b', divMid: '#f0efec'
    },
    dark: {
      surface: '#1a1a19', plane: '#0d0d0d', ink: '#ffffff', ink2: '#c3c2b7',
      muted: '#898781', grid: '#2c2c2a', axis: '#383835', border: 'rgba(255,255,255,0.10)',
      s1: '#3987e5', s2: '#d95926', s3: '#199e70',
      good: '#0ca30c', warn: '#fab219', crit: '#d03b3b',
      divNeg: '#3987e5', divPos: '#d03b3b', divMid: '#383835'
    }
  };

  /**
   * Follow the *host page*, not the operating system.
   *
   * This is an overlay. A user whose OS is dark but who reads stockanalysis in
   * light mode got a dark panel slapped over a white page — jarring, and wrong.
   * Explicit signals win; otherwise measure the page's actual background
   * luminance, which works whatever convention the site happens to use. The OS
   * preference is only the last resort.
   */
  function isDark() {
    try {
      const de = document.documentElement;
      const attr = (de.getAttribute && (de.getAttribute('data-theme') || de.getAttribute('data-color-mode'))) || null;
      if (attr === 'dark') return true;
      if (attr === 'light') return false;
      if (de.classList && de.classList.contains('dark')) return true;
      if (de.classList && de.classList.contains('light')) return false;
      if (typeof getComputedStyle === 'function') {
        for (const el of [document.body, de]) {
          if (!el) continue;
          const m = String(getComputedStyle(el).backgroundColor || '')
            .match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
          if (m && (m[4] === undefined || Number(m[4]) > 0.5)) {
            const [r, g, b] = [1, 2, 3].map((i) => Number(m[i]));
            return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128;
          }
        }
      }
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch (e) {
      return false;   // a wrong-but-legible light theme beats throwing mid-render
    }
  }
  const P = () => (isDark() ? PALETTE.dark : PALETTE.light);

  const pct = (v, d = 1) => (v === null || v === undefined || !isFinite(v)) ? '—' : (v * 100).toFixed(d) + '%';
  const num = (v, d = 2) => (v === null || v === undefined || !isFinite(v)) ? '—' : v.toFixed(d);
  const money = (v, cur) => (v === null || !isFinite(v)) ? '—' :
    new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(v);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function css() {
    const p = P();
    return `
    #prl-btn{position:fixed;right:18px;bottom:18px;z-index:2147483000;
      font:600 13px/1 system-ui,-apple-system,"Segoe UI",sans-serif;
      background:${p.s1};color:#fff;border:0;border-radius:999px;padding:11px 16px;
      box-shadow:0 2px 10px rgba(0,0,0,.22);cursor:pointer}
    #prl-btn:hover{filter:brightness(1.08)}
    #prl-root{position:fixed;inset:0;z-index:2147483100;background:${p.plane};
      color:${p.ink};font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;
      overflow:auto;display:none}
    #prl-root.on{display:block}
    #prl-root *{box-sizing:border-box}
    .prl-wrap{max-width:1200px;margin:0 auto;padding:20px 22px 60px}
    .prl-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px}
    .prl-top h1{font-size:17px;font-weight:650;margin:0}
    .prl-sp{flex:1}
    .prl-tabs{display:flex;gap:4px;border-bottom:1px solid ${p.border};margin-bottom:18px}
    .prl-tab{background:none;border:0;padding:9px 14px;cursor:pointer;color:${p.ink2};
      font:600 13px system-ui;border-bottom:2px solid transparent}
    .prl-tab.on{color:${p.ink};border-bottom-color:${p.s1}}
    .prl-card{background:${p.surface};border:1px solid ${p.border};border-radius:10px;
      padding:16px 18px;margin-bottom:16px}
    .prl-card h2{font-size:13px;font-weight:650;margin:0 0 3px;letter-spacing:.01em}
    .prl-card p.sub{margin:0 0 14px;color:${p.muted};font-size:12px}
    .prl-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
    .prl-tile{background:${p.surface};border:1px solid ${p.border};border-radius:10px;padding:13px 15px}
    .prl-tile .lab{font-size:11px;color:${p.muted};text-transform:uppercase;letter-spacing:.05em}
    .prl-tile .val{font-size:24px;font-weight:600;margin-top:5px}
    .prl-tile .hint{font-size:11px;color:${p.muted};margin-top:3px}
    table.prl{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
    table.prl th{text-align:right;font-weight:600;color:${p.muted};font-size:11px;
      text-transform:uppercase;letter-spacing:.04em;padding:6px 8px;border-bottom:1px solid ${p.border}}
    table.prl th:first-child,table.prl td:first-child{text-align:left}
    table.prl td{padding:7px 8px;border-bottom:1px solid ${p.grid};text-align:right}
    table.prl tr:last-child td{border-bottom:0}
    .prl-in{background:${p.plane};color:${p.ink};border:1px solid ${p.axis};border-radius:6px;
      padding:5px 8px;font:13px system-ui;width:100%;font-variant-numeric:tabular-nums}
    .prl-bt{background:${p.surface};color:${p.ink};border:1px solid ${p.axis};border-radius:7px;
      padding:6px 12px;font:600 12px system-ui;cursor:pointer}
    .prl-bt:hover{border-color:${p.s1}}
    .prl-bt.pri{background:${p.s1};border-color:${p.s1};color:#fff}
    .prl-bt.dgr{color:${p.crit};border-color:${p.crit}}
    .prl-note{border-left:3px solid ${p.warn};background:${p.surface};padding:9px 13px;
      border-radius:0 7px 7px 0;font-size:12px;color:${p.ink2};margin-bottom:10px}
    .prl-note.bad{border-left-color:${p.crit}}
    .prl-na{color:${p.muted};font-style:italic;font-size:12px}
    .prl-lg{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:${p.ink2};margin-top:10px}
    .prl-lg i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
    .prl-sc{overflow-x:auto}
    textarea.prl-in{font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;resize:vertical}
    label.prl-mut{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
    label.prl-mut .prl-in{margin-top:4px;text-transform:none;font-size:13px}
    .prl-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    .prl-mut{color:${p.muted};font-size:12px}
    `;
  }

  // ---- SVG primitives ------------------------------------------------------

  /** Horizontal magnitude bars. One hue: this compares sizes, not identities. */
  function barsSVG(items, { width = 620, max = null, fmt = (v) => pct(v), color = null } = {}) {
    const p = P(), c = color || p.s1;
    const rowH = 26, padL = 168, padR = 62;
    const h = items.length * rowH + 6;
    const m = max || Math.max(...items.map((d) => Math.abs(d.v)), 1e-9);
    const inner = width - padL - padR;
    let s = `<svg viewBox="0 0 ${width} ${h}" width="100%" height="${h}" role="img">`;
    items.forEach((d, i) => {
      const y = i * rowH + 3;
      const bw = Math.max(2, (Math.abs(d.v) / m) * inner);
      s += `<text x="${padL - 10}" y="${y + 14}" text-anchor="end" font-size="12" fill="${p.ink2}">${esc(d.k)}</text>`;
      // 4px rounded data-end, anchored to the baseline
      s += `<rect x="${padL}" y="${y + 4}" width="${bw}" height="13" rx="4" fill="${c}"/>`;
      s += `<text x="${padL + bw + 8}" y="${y + 14}" font-size="12" fill="${p.ink2}" font-variant-numeric="tabular-nums">${fmt(d.v)}</text>`;
    });
    return s + '</svg>';
  }

  /** Correlation heatmap. Diverging: blue (negative) ↔ gray (zero) ↔ red (positive). */
  function heatmapSVG(C, labels, order) {
    const p = P();
    const n = order.length;
    const cell = n > 22 ? 15 : n > 14 ? 21 : 27;
    const pad = 96;
    const size = pad + n * cell + 12;
    const mix = (a, b, t) => {
      const h = (x) => [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16));
      const A = h(a), B = h(b);
      return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
    };
    const col = (r) => r >= 0 ? mix(p.divMid, p.divPos, Math.min(1, r)) : mix(p.divMid, p.divNeg, Math.min(1, -r));

    // Natural size, left-aligned. A percentage width made a five-name matrix
    // float in the middle of a very wide empty card; .prl-sc scrolls when the
    // matrix is genuinely wider than the panel.
    let s = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" style="display:block;max-width:100%;height:auto" role="img">`;
    order.forEach((oi, i) => {
      s += `<text x="${pad - 7}" y="${pad + i * cell + cell / 2 + 4}" text-anchor="end" font-size="10" fill="${p.ink2}">${esc(labels[oi])}</text>`;
      s += `<text transform="translate(${pad + i * cell + cell / 2},${pad - 7}) rotate(-45)" font-size="10" fill="${p.ink2}">${esc(labels[oi])}</text>`;
    });
    order.forEach((oi, i) => order.forEach((oj, j) => {
      const r = C[oi][oj];
      // 2px surface gap between fills keeps adjacent cells legible
      s += `<rect x="${pad + j * cell + 1}" y="${pad + i * cell + 1}" width="${cell - 2}" height="${cell - 2}" rx="2" fill="${col(r)}">`;
      s += `<title>${esc(labels[oi])} vs ${esc(labels[oj])}: ${r.toFixed(2)}</title></rect>`;
      if (cell >= 21 && i !== j) {
        s += `<text x="${pad + j * cell + cell / 2}" y="${pad + i * cell + cell / 2 + 3.5}" text-anchor="middle" font-size="9" fill="${Math.abs(r) > 0.62 ? '#fff' : p.ink2}">${r.toFixed(2).replace('0.', '.')}</text>`;
      }
    }));
    return s + '</svg>';
  }

  /** Cumulative portfolio line with drawdown shading. */
  function lineSVG(rets, dates, ddFrom, ddAt) {
    const p = P(), W = 620, H = 180, padL = 46, padB = 22, padT = 10;
    if (!rets.length) return '';
    const cum = []; let v = 1;
    for (const r of rets) { v *= (1 + r); cum.push(v); }
    const lo = Math.min(...cum), hi = Math.max(...cum);
    const x = (i) => padL + (i / Math.max(1, cum.length - 1)) * (W - padL - 12);
    const y = (val) => padT + (1 - (val - lo) / Math.max(hi - lo, 1e-9)) * (H - padT - padB);
    let d = '';
    cum.forEach((val, i) => { d += (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(val).toFixed(1); });
    let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img">`;
    for (let g = 0; g <= 3; g++) {
      const val = lo + (hi - lo) * g / 3;
      s += `<line x1="${padL}" y1="${y(val)}" x2="${W - 12}" y2="${y(val)}" stroke="${p.grid}" stroke-width="1"/>`;
      s += `<text x="${padL - 7}" y="${y(val) + 3.5}" text-anchor="end" font-size="10" fill="${p.muted}">${((val - 1) * 100).toFixed(0)}%</text>`;
    }
    if (ddAt > ddFrom) {
      s += `<rect x="${x(ddFrom)}" y="${padT}" width="${Math.max(1, x(ddAt) - x(ddFrom))}" height="${H - padT - padB}" fill="${p.crit}" opacity="0.10"/>`;
    }
    s += `<path d="${d}" fill="none" stroke="${p.s1}" stroke-width="2" stroke-linejoin="round"/>`;
    if (dates.length) {
      s += `<text x="${padL}" y="${H - 6}" font-size="10" fill="${p.muted}">${esc(dates[0])}</text>`;
      s += `<text x="${W - 12}" y="${H - 6}" text-anchor="end" font-size="10" fill="${p.muted}">${esc(dates[dates.length - 1])}</text>`;
    }
    return s + '</svg>';
  }

  // ---- views ---------------------------------------------------------------

  let STATE = { tab: 'positions', result: null, busy: false, scenario: null };

  function render() {
    const root = document.getElementById('prl-root');
    if (!root) return;
    const s = settings();
    const tabs = ['positions', 'risk', 'scenarios', 'data'];
    root.innerHTML = `
      <div class="prl-wrap">
        <div class="prl-top">
          <h1>Portfolio Risk Lens</h1>
          <span class="prl-mut">v${VERSION}</span>
          <div class="prl-sp"></div>
          <label class="prl-mut">Base
            <select id="prl-base" class="prl-in" style="width:auto;display:inline-block;margin-left:5px">
              ${['USD', 'EUR', 'DKK', 'SEK', 'NOK', 'GBP', 'CHF', 'JPY'].map((c) => `<option ${c === s.base ? 'selected' : ''}>${c}</option>`).join('')}
            </select></label>
          <button class="prl-bt" id="prl-refresh">${STATE.busy ? 'Working…' : 'Refresh'}</button>
          <button class="prl-bt" id="prl-close">Close</button>
        </div>
        <div class="prl-tabs">
          ${tabs.map((t) => `<button class="prl-tab ${STATE.tab === t ? 'on' : ''}" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
        </div>
        <div id="prl-body">${bodyHTML()}</div>
      </div>`;

    root.querySelectorAll('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => { STATE.tab = b.dataset.tab; render(); }));
    root.querySelector('#prl-close').addEventListener('click', () => toggle(false));
    root.querySelector('#prl-refresh').addEventListener('click', () => run(true));
    root.querySelector('#prl-base').addEventListener('change', (e) => {
      saveSettings({ base: e.target.value }); run(false);
    });
    wireBody();
  }

  function bodyHTML() {
    const r = STATE.result;
    if (STATE.busy && !r) return `<div class="prl-card"><p class="sub">Loading… ${esc(STATE.msg || '')}</p></div>`;
    if (!r || r.empty) {
      return `<div class="prl-card">
        <h2>No positions yet</h2>
        <p class="sub">Add holdings below, or press the button on any stockanalysis.com company page to add the ticker you are viewing.</p>
        ${editorHTML()}</div>`;
    }
    switch (STATE.tab) {
      case 'risk': return riskHTML(r);
      case 'scenarios': return scenariosHTML(r);
      case 'data': return dataHTML(r);
      default: return positionsHTML(r);
    }
  }

  function warnBlock(r) {
    let h = '';
    (r.failures || []).forEach((f) => {
      h += `<div class="prl-note bad">Could not load <b>${esc(f.sym)}</b> — ${esc(f.why)}. It is excluded from every figure below.</div>`;
    });
    (r.warnings || []).forEach((w) => { h += `<div class="prl-note">${esc(w)}</div>`; });
    if (!r.enough) {
      h += `<div class="prl-note">Only ${r.obs} ${r.freq} observations — below the ${MIN_OBS[r.freq]} needed. Risk statistics are withheld rather than estimated from noise.</div>`;
    }
    return h;
  }

  function positionsHTML(r) {
    const rows = r.positions.map((p, i) => {
      const drift = p.target ? (p.weight - Number(p.target) / 100) : null;
      return `<tr>
        <td><b>${esc(p.sym)}</b>${p.meta && p.meta.name ? `<div class="prl-mut">${esc(p.meta.name)}</div>` : ''}</td>
        <td>${esc(p.currency)}</td>
        <td>${esc(p.meta && p.meta.sector || '—')}</td>
        <td>${money(p.value, r.base)}</td>
        <td>${pct(p.weight)}</td>
        <td>${p.target ? pct(Number(p.target) / 100) : '<span class="prl-na">—</span>'}</td>
        <td style="color:${drift === null ? '' : (Math.abs(drift) > 0.03 ? P().crit : P().ink2)}">${drift === null ? '<span class="prl-na">—</span>' : (drift > 0 ? '+' : '') + pct(drift)}</td>
        <td style="text-align:left;max-width:220px" class="prl-mut">${esc(p.note || '')}</td>
      </tr>`;
    }).join('');

    const top3 = r.positions.map((p) => p.weight).sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);

    return `${warnBlock(r)}
      <div class="prl-tiles" style="margin-bottom:16px">
        <div class="prl-tile"><div class="lab">Portfolio value</div><div class="val">${money(r.total, r.base)}</div><div class="hint">${r.positions.length} positions</div></div>
        <div class="prl-tile"><div class="lab">Top 3 concentration</div><div class="val">${pct(top3, 0)}</div><div class="hint">of total value</div></div>
        <div class="prl-tile"><div class="lab">Currencies</div><div class="val">${r.exposures.currency.length}</div><div class="hint">${esc(r.exposures.currency.slice(0, 3).map((c) => c.k).join(', '))}</div></div>
        <div class="prl-tile"><div class="lab">Return sampling</div><div class="val">${r.freq}</div><div class="hint">${r.obs} observations</div></div>
      </div>
      <div class="prl-card">
        <h2>Holdings</h2>
        <p class="sub">Values converted to ${esc(r.base)} at daily FX. Drift is actual weight minus target.</p>
        <div class="prl-sc"><table class="prl">
          <thead><tr><th>Position</th><th>Ccy</th><th>Sector</th><th>Value</th><th>Weight</th><th>Target</th><th>Drift</th><th style="text-align:left">Thesis</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
      </div>
      <div class="prl-card"><h2>Edit positions</h2><p class="sub">Yahoo symbols — e.g. <code>AAPL</code>, <code>NOVO-B.CO</code>, <code>7203.T</code>, <code>005930.KS</code>, <code>IWDA.AS</code>.</p>${editorHTML()}</div>`;
  }

  function editorHTML() {
    const pos = positions();
    const rows = pos.map((p, i) => `<tr data-i="${i}">
      <td><input class="prl-in pf" data-f="sym" value="${esc(p.sym)}" style="width:120px"></td>
      <td><input class="prl-in pf" data-f="shares" value="${esc(p.shares)}" style="width:100px"></td>
      <td><input class="prl-in pf" data-f="cost" value="${esc(p.cost || '')}" style="width:100px"></td>
      <td><input class="prl-in pf" data-f="target" value="${esc(p.target || '')}" style="width:80px"></td>
      <td><input class="prl-in pf" data-f="note" value="${esc(p.note || '')}"></td>
      <td><button class="prl-bt dgr prl-del">Remove</button></td></tr>`).join('');
    return `<div class="prl-sc"><table class="prl">
      <thead><tr><th style="text-align:left">Symbol</th><th style="text-align:left">Shares</th><th style="text-align:left">Cost/share</th><th style="text-align:left">Target %</th><th style="text-align:left">Thesis</th><th></th></tr></thead>
      <tbody id="prl-edit">${rows}</tbody></table></div>
      <div class="prl-row" style="margin-top:12px">
        <button class="prl-bt" id="prl-add">Add row</button>
        <button class="prl-bt pri" id="prl-save">Save &amp; recompute</button>
        <span style="flex:1"></span>
        <button class="prl-bt" id="prl-csvin">Import CSV</button>
        <button class="prl-bt" id="prl-csvout">Export CSV</button>
      </div>
      <div id="prl-csvbox" style="display:none;margin-top:12px">
        <p class="sub">Paste rows below, or drop a file. Columns are detected from the header — <code>symbol, shares, cost, target, note</code> in any order. Comma, semicolon and tab delimiters all work, including semicolon files that use commas as decimal separators.</p>
        <textarea id="prl-csvtext" class="prl-in" rows="7" placeholder="symbol,shares,cost,target,note
AAPL,40,150,22,Services margin
NOVO-B.CO,120,620,18,GLP-1 capacity"></textarea>
        <div class="prl-row" style="margin-top:10px">
          <input type="file" id="prl-csvfile" accept=".csv,.txt,text/csv" style="font:12px system-ui">
          <button class="prl-bt pri" id="prl-csvgo">Import</button>
          <button class="prl-bt" id="prl-csvcancel">Cancel</button>
          <span class="prl-mut" id="prl-csvmsg"></span>
        </div>
      </div>`;
  }

  function riskHTML(r) {
    if (!r.risk) {
      const why = r.positions.length < 2
        ? 'Correlation, risk contribution and portfolio volatility all describe how holdings interact, so they need <b>at least two positions</b>. Add another holding.'
        : `Only ${r.obs} ${r.freq} observations — fewer than the ${MIN_OBS[r.freq]} required. Widen the lookback, or wait for more history on the newest holding.`;
      return warnBlock(r) + `<div class="prl-card"><h2>Risk</h2><p class="sub">${why}</p></div>`;
    }
    const k = r.risk;
    const labels = r.positions.map((p) => p.sym);
    const contrib = r.positions.map((p, i) => ({ k: p.sym, v: k.contrib[i] }))
      .sort((a, b) => b.v - a.v);
    const fxShare = k.volAnn > 0 ? (1 - k.volLocalAnn / k.volAnn) : 0;

    return `${warnBlock(r)}
      <div class="prl-tiles" style="margin-bottom:16px">
        <div class="prl-tile"><div class="lab">Portfolio volatility</div><div class="val">${pct(k.volAnn, 1)}</div><div class="hint">annualised, ${r.freq}</div></div>
        <div class="prl-tile"><div class="lab">Max drawdown</div><div class="val" style="color:${P().crit}">${pct(k.dd.mdd, 1)}</div><div class="hint">at current weights</div></div>
        <div class="prl-tile"><div class="lab">Beta</div><div class="val">${k.beta === null ? '—' : num(k.beta)}</div><div class="hint">vs ${esc(settings().benchmark)}</div></div>
        <div class="prl-tile"><div class="lab">Shrinkage δ</div><div class="val">${num(k.delta)}</div><div class="hint">Ledoit-Wolf intensity</div></div>
      </div>

      <div class="prl-card">
        <h2>Risk contribution</h2>
        <p class="sub">Share of total portfolio volatility each position is responsible for. This is rarely the same as its weight — that gap is the point.</p>
        ${barsSVG(contrib, { fmt: (v) => pct(v, 1) })}
        <div class="prl-lg"><span><i style="background:${P().s1}"></i>% of portfolio volatility</span></div>
      </div>

      <div class="prl-card">
        <h2>Correlation</h2>
        <p class="sub">Clustered so co-moving names sit together. Blocks of red are positions that are one bet wearing several names. Sampled ${r.freq}${r.freq === 'weekly' ? ' — daily closes across Tokyo, Seoul and New York are not simultaneous and would understate these numbers' : ''}.</p>
        <div class="prl-sc">${heatmapSVG(k.C, labels, k.order)}</div>
        <div class="prl-lg">
          <span><i style="background:${P().divNeg}"></i>−1 inverse</span>
          <span><i style="background:${P().divMid}"></i>0 unrelated</span>
          <span><i style="background:${P().divPos}"></i>+1 identical</span>
        </div>
      </div>

      <div class="prl-card">
        <h2>Cumulative performance at current weights</h2>
        <p class="sub">What today's book would have done historically. Shaded band is the deepest drawdown.</p>
        ${lineSVG(k.rp, k.dates, k.dd.from, k.dd.at)}
      </div>

      ${lookthroughHTML(r)}

      <div class="prl-card">
        <h2>Exposure</h2>
        <p class="sub">Funds are decomposed into their underlying sector mix rather than counted as one position.</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:22px">
          <div><h2 style="font-size:12px;margin-bottom:8px">Sector</h2>${barsSVG(r.exposures.sector.slice(0, 11), { width: 520 })}</div>
          <div><h2 style="font-size:12px;margin-bottom:8px">Currency</h2>${barsSVG(r.exposures.currency, { width: 520, color: P().s3 })}
            <p class="sub" style="margin-top:8px">FX explains about <b>${pct(Math.max(0, fxShare), 0)}</b> of portfolio volatility — the difference between returns measured in ${esc(r.base)} and in each asset's home currency.</p>
          </div>
          <div><h2 style="font-size:12px;margin-bottom:8px">Country</h2>${barsSVG(r.exposures.country.slice(0, 11), { width: 520, color: P().s2 })}</div>
        </div>
      </div>`;
  }

  function scenariosHTML(r) {
    if (!r.risk) return warnBlock(r) + `<div class="prl-card"><h2>Scenarios</h2><p class="sub prl-na">Needs risk statistics first.</p></div>`;
    const k = r.risk;
    const sc = STATE.scenario || r.positions.map((p) => p.weight * 100);
    const S = settings();

    /*
     * Equal-risk (inverse-volatility) weights.
     *
     * The previous formula asked "what weight makes this position's standalone
     * volatility equal X% of portfolio volatility", which with a 2% budget and
     * five holdings suggested weights of 1-2% each — a book that is 92% cash.
     * The question people actually want answered is "what would each position
     * weigh if every one contributed the same risk", which is w ∝ 1/σ,
     * normalised. It is the standard risk-parity approximation and it always
     * produces a fully-invested book.
     */
    const inv = k.assetVol.map((v) => (v > 0 ? 1 / v : 0));
    const invSum = inv.reduce((a, b) => a + b, 0);
    const sized = r.positions.map((p, i) => ({
      sym: p.sym, vol: k.assetVol[i], cur: p.weight,
      sug: invSum > 0 ? inv[i] / invSum : null,
      contrib: k.contrib[i],
      over: k.contrib[i] > S.maxRiskPct / 100
    }));

    const rows = r.positions.map((p, i) => `<tr>
      <td><b>${esc(p.sym)}</b></td>
      <td>${pct(p.weight)}</td>
      <td><input class="prl-in sc" data-i="${i}" value="${(sc[i]).toFixed(1)}" style="width:80px"></td>
      <td>${pct(k.contrib[i], 1)}</td>
      <td>${pct(k.assetVol[i], 1)}</td>
    </tr>`).join('');

    return `${warnBlock(r)}
      <div class="prl-card">
        <h2>What-if weights</h2>
        <p class="sub">Edit any weight and recompute. Everything below reflects the edited book, not the live one.</p>
        <div class="prl-sc"><table class="prl">
          <thead><tr><th>Position</th><th>Actual</th><th>Scenario %</th><th>Risk contrib</th><th>Own vol</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
        <div class="prl-row" style="margin-top:12px">
          <button class="prl-bt pri" id="prl-scrun">Recompute scenario</button>
          <button class="prl-bt" id="prl-screset">Reset to actual</button>
          <span class="prl-mut" id="prl-scout"></span>
        </div>
      </div>

      <div class="prl-card">
        <h2>Historical stress</h2>
        <p class="sub">Today's weights replayed through past windows. Only windows fully covered by your data are shown.</p>
        ${stressHTML(r)}
      </div>

      <div class="prl-card">
        <h2>Equal-risk sizing</h2>
        <p class="sub">What each position would weigh if every holding contributed the same share of portfolio risk — the inverse-volatility benchmark. A reference point for sizing conviction against risk, not an instruction. Positions whose actual risk contribution exceeds ${S.maxRiskPct}% are flagged.</p>
        <div class="prl-sc"><table class="prl">
          <thead><tr><th>Position</th><th>Own volatility</th><th>Risk contribution</th><th>Current weight</th><th>Equal-risk weight</th><th>Gap</th></tr></thead>
          <tbody>${sized.map((s) => `<tr><td><b>${esc(s.sym)}</b></td><td>${pct(s.vol, 1)}</td>
            <td style="color:${s.over ? P().crit : ''}">${pct(s.contrib, 1)}${s.over ? ' ⚑' : ''}</td>
            <td>${pct(s.cur)}</td>
            <td>${s.sug === null ? '—' : pct(s.sug)}</td>
            <td style="color:${s.sug !== null && Math.abs(s.cur - s.sug) > 0.08 ? P().crit : ''}">${s.sug === null ? '—' : (s.cur > s.sug ? '+' : '') + pct(s.cur - s.sug)}</td></tr>`).join('')}</tbody>
        </table></div>
      </div>`;
  }

  /** True security-level exposure once funds are seen through. */
  function lookthroughHTML(r) {
    const lt = (r.exposures.lookthrough || []).filter((e) => e.total > 0.0005 && !/^~rest:/.test(e.key));
    const ov = r.exposures.overlaps || [];
    if (!lt.length) return '';

    const top = lt.slice(0, 14);
    const rest = r.exposures.unitemised || 0;

    const overlapNote = ov.length
      ? `<div class="prl-note">${ov.map((e) => `You hold <b>${esc(e.name)}</b> at ${pct(e.direct)} directly, plus ${pct(e.indirect)} inside ${esc(e.via.join(', '))} — a true exposure of <b>${pct(e.total)}</b>, ${(e.total / Math.max(e.direct, 1e-9)).toFixed(1)}× what the holdings list shows.`).join('<br>')}</div>`
      : `<p class="sub">No holding overlaps with your funds' published top holdings.</p>`;

    return `<div class="prl-card">
      <h2>Look-through exposure</h2>
      <p class="sub">Real exposure to each underlying company, combining what you hold directly with what your funds hold on your behalf.</p>
      ${overlapNote}
      <div class="prl-sc"><table class="prl">
        <thead><tr><th>Company</th><th>Direct</th><th>Via funds</th><th>True exposure</th></tr></thead>
        <tbody>${top.map((e) => `<tr>
          <td><b>${esc(e.name)}</b>${e.via.length ? `<div class="prl-mut">via ${esc(e.via.join(', '))}</div>` : ''}</td>
          <td>${e.direct > 0 ? pct(e.direct) : '<span class="prl-na">—</span>'}</td>
          <td>${e.indirect > 0 ? pct(e.indirect) : '<span class="prl-na">—</span>'}</td>
          <td style="font-weight:600${e.direct > 0 && e.indirect > 0 ? ';color:' + P().crit : ''}">${pct(e.total)}</td>
        </tr>`).join('')}</tbody></table></div>
      ${rest > 0.005 ? `<p class="sub" style="margin-top:10px">${pct(rest, 0)} of the portfolio sits in fund holdings beyond the published top-10 and is not itemised here. Those positions are counted in sector and currency exposure, just not name by name.</p>` : ''}
    </div>`;
  }

  const STRESS = [
    { name: 'COVID crash', from: '2020-02-19', to: '2020-03-23' },
    { name: '2022 rate shock', from: '2022-01-03', to: '2022-10-14' },
    { name: '2023 banking wobble', from: '2023-03-01', to: '2023-03-24' },
    { name: 'Aug 2024 yen unwind', from: '2024-07-31', to: '2024-08-07' }
  ];

  function stressHTML(r) {
    const k = r.risk;
    const out = STRESS.map((w) => {
      const idx = k.dates.map((d, i) => ({ d, i })).filter((x) => x.d >= w.from && x.d <= w.to).map((x) => x.i);
      if (idx.length < 3 || k.dates[0] > w.from) return { ...w, ok: false };
      let v = 1; for (const i of idx) v *= (1 + k.rp[i]);
      return { ...w, ok: true, ret: v - 1, n: idx.length };
    });
    const usable = out.filter((o) => o.ok);
    if (!usable.length) return `<p class="sub prl-na">No stress window is fully covered by your price history yet.</p>`;
    return `<div class="prl-sc"><table class="prl">
      <thead><tr><th>Window</th><th>Period</th><th>Portfolio return</th></tr></thead>
      <tbody>${out.map((o) => `<tr><td><b>${esc(o.name)}</b></td><td class="prl-mut">${esc(o.from)} → ${esc(o.to)}</td>
        <td style="color:${o.ok && o.ret < 0 ? P().crit : ''}">${o.ok ? pct(o.ret, 1) : '<span class="prl-na">outside history</span>'}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function dataHTML(r) {
    const st = Cache.stats();
    const s = settings();
    const sources = r && r.positions ? [...new Set(r.positions.map((p) => p.source || 'cache'))] : [];
    return `<div class="prl-card">
      <h2>Settings</h2>
      <p class="sub">Changes take effect on the next recompute.</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;max-width:840px">
        <label class="prl-mut">Benchmark
          <input class="prl-in st" data-k="benchmark" value="${esc(s.benchmark)}"></label>
        <label class="prl-mut">History (years)
          <input class="prl-in st" data-k="years" value="${esc(s.years)}"></label>
        <label class="prl-mut">Return sampling
          <select class="prl-in st" data-k="freq">
            ${['auto', 'weekly', 'daily'].map((f) => `<option ${f === s.freq ? 'selected' : ''}>${f}</option>`).join('')}
          </select></label>
        <label class="prl-mut">Max risk share per position (%)
          <input class="prl-in st" data-k="maxRiskPct" value="${esc(s.maxRiskPct)}"></label>
        <label class="prl-mut">Price cache TTL (hours)
          <input class="prl-in st" data-k="barsTtlHours" value="${esc(s.barsTtlHours)}"></label>
      </div>
      <div class="prl-row" style="margin-top:14px">
        <button class="prl-bt pri" id="prl-setsave">Save settings</button>
        <span class="prl-mut" id="prl-setmsg"></span>
      </div>
      <p class="sub" style="margin-top:12px">Sampling <b>auto</b> picks weekly whenever the portfolio spans trading regions, because daily closes in Tokyo, Seoul and New York are not simultaneous and would understate cross-region correlation. Override only if you know why you want to.</p>
    </div>

    <div class="prl-card">
      <h2>Data &amp; diagnostics</h2>
      <p class="sub">Everything is stored in your browser by the userscript manager. Nothing is uploaded anywhere.</p>
      <table class="prl" style="max-width:520px">
        <tbody>
          <tr><td style="text-align:left">Cached price series</td><td>${st.bars}</td></tr>
          <tr><td style="text-align:left">Cached profiles</td><td>${st.meta}</td></tr>
          <tr><td style="text-align:left">Local storage used</td><td>${st.kb} KB</td></tr>
          <tr><td style="text-align:left">Return sampling</td><td>${r && r.freq ? r.freq : '—'}</td></tr>
          <tr><td style="text-align:left">Price sources in use</td><td>${esc(sources.join(', ') || '—')}</td></tr>
        </tbody></table>
      <div class="prl-row" style="margin-top:14px">
        <button class="prl-bt" id="prl-selftest">Run self-test</button>
        <button class="prl-bt" id="prl-export">Export everything</button>
        <button class="prl-bt dgr" id="prl-clear">Clear price cache</button>
      </div>
      <pre id="prl-diag" style="white-space:pre-wrap;font-size:12px;color:${P().ink2};margin-top:14px"></pre>
    </div>`;
  }

  // ---- event wiring --------------------------------------------------------

  function wireBody() {
    const root = document.getElementById('prl-root');
    const $ = (s) => root.querySelector(s);

    if ($('#prl-add')) $('#prl-add').addEventListener('click', () => {
      savePositions(positions().concat([{ sym: '', shares: '', cost: '', target: '', note: '' }]));
      render();
    });
    if ($('#prl-save')) $('#prl-save').addEventListener('click', () => {
      const rows = Array.from(root.querySelectorAll('#prl-edit tr'));
      const next = rows.map((tr) => {
        const o = {};
        tr.querySelectorAll('.pf').forEach((inp) => { o[inp.dataset.f] = inp.value.trim(); });
        o.sym = (o.sym || '').toUpperCase();
        return o;
      }).filter((o) => o.sym);
      savePositions(next);
      run(false);
    });
    root.querySelectorAll('.prl-del').forEach((b) => b.addEventListener('click', (e) => {
      const i = Number(e.target.closest('tr').dataset.i);
      savePositions(positions().filter((_, k) => k !== i));
      render();
    }));

    if ($('#prl-scrun')) $('#prl-scrun').addEventListener('click', () => {
      const r = STATE.result; if (!r || !r.risk) return;
      const w = Array.from(root.querySelectorAll('.sc')).map((i) => Number(i.value) || 0);
      const tot = w.reduce((a, b) => a + b, 0);
      if (tot <= 0) return;
      const wn = w.map((x) => x / tot);
      const k = r.risk;
      const Sw = matVec(k.Sigma, wn);
      const vol = Math.sqrt(Math.max(dot(wn, Sw), 1e-18)) * Math.sqrt(r.periodsPerYear);
      const top3 = wn.slice().sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
      const dd = maxDrawdown(k.rp.map((_, t) => dot(wn, returnsRow(k, t))));
      const d = vol - k.volAnn;
      $('#prl-scout').innerHTML = `vol <b>${pct(vol, 1)}</b> (${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)}pp) · top-3 <b>${pct(top3, 0)}</b> · max DD <b>${pct(dd.mdd, 1)}</b>` +
        (Math.abs(tot - 100) > 0.5 ? ` <span class="prl-na">— weights summed to ${tot.toFixed(1)}%, normalised</span>` : '');
      STATE.scenario = w;
    });
    if ($('#prl-screset')) $('#prl-screset').addEventListener('click', () => { STATE.scenario = null; render(); });

    // --- CSV ---------------------------------------------------------------
    const box = $('#prl-csvbox');
    if ($('#prl-csvin')) $('#prl-csvin').addEventListener('click', () => {
      box.style.display = box.style.display === 'none' ? 'block' : 'none';
    });
    if ($('#prl-csvcancel')) $('#prl-csvcancel').addEventListener('click', () => { box.style.display = 'none'; });
    if ($('#prl-csvout')) $('#prl-csvout').addEventListener('click', () => {
      download('portfolio-risk-lens-positions.csv', positionsToCSV(positions()), 'text/csv');
    });
    if ($('#prl-csvfile')) $('#prl-csvfile').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const fr = new FileReader();
      fr.onload = () => { $('#prl-csvtext').value = fr.result; };
      fr.readAsText(f);
    });
    if ($('#prl-csvgo')) $('#prl-csvgo').addEventListener('click', () => {
      const parsed = parseCSV($('#prl-csvtext').value);
      const msg = $('#prl-csvmsg');
      if (!parsed.rows.length) {
        msg.innerHTML = `<span style="color:${P().crit}">Nothing importable found${parsed.skipped && parsed.skipped.length ? ` — ${parsed.skipped.length} line(s) had no usable symbol` : ''}.</span>`;
        return;
      }
      // Merge on symbol rather than replacing, so an import tops up a portfolio
      // instead of silently destroying rows the file happens not to mention.
      const cur = positions();
      const byS = new Map(cur.map((p) => [p.sym, p]));
      for (const row of parsed.rows) byS.set(row.sym, Object.assign({}, byS.get(row.sym) || {}, row));
      savePositions(Array.from(byS.values()));
      const skipped = (parsed.skipped || []).length;
      msg.textContent = `Imported ${parsed.rows.length} (${parsed.delim === ';' ? 'semicolon' : parsed.delim === '\t' ? 'tab' : 'comma'}-delimited` +
        `${parsed.decimalComma ? ', decimal comma' : ''})${skipped ? `, skipped ${skipped}` : ''}.`;
      setTimeout(() => run(false), 400);
    });

    // --- settings ----------------------------------------------------------
    if ($('#prl-setsave')) $('#prl-setsave').addEventListener('click', () => {
      const patch = {};
      root.querySelectorAll('.st').forEach((i) => {
        const k = i.dataset.k;
        const v = i.value.trim();
        patch[k] = ['years', 'maxRiskPct', 'barsTtlHours'].includes(k) ? (Number(v) || DEFAULTS[k]) : v;
      });
      patch.years = clamp(Math.round(patch.years), 1, 25);
      saveSettings(patch);
      $('#prl-setmsg').textContent = 'Saved. Recomputing…';
      setTimeout(() => run(true), 300);
    });

    if ($('#prl-selftest')) $('#prl-selftest').addEventListener('click', selfTest);
    if ($('#prl-export')) $('#prl-export').addEventListener('click', exportAll);
    if ($('#prl-clear')) $('#prl-clear').addEventListener('click', () => {
      Cache.clearPrices(); $('#prl-diag').textContent = 'Price cache cleared.'; run(true);
    });
  }

  // Per-asset return row for period t, used to re-simulate the scenario book.
  function returnsRow(k, t) { return k.R[t]; }

  async function selfTest() {
    const el = document.getElementById('prl-diag');
    const log = (s) => { el.textContent += s + '\n'; };
    el.textContent = `Portfolio Risk Lens ${VERSION} — self-test\n`;
    const checks = [
      ['Yahoo daily bars (AAPL)', async () => { const b = await Yahoo.bars('AAPL', 1); return `${b.rows.length} bars, ${b.currency}`; }],
      ['Yahoo international (7203.T)', async () => { const b = await Yahoo.bars('7203.T', 1); return `${b.rows.length} bars, ${b.currency}`; }],
      ['Yahoo FX (USDDKK=X)', async () => { const b = await Yahoo.bars('USDDKK=X', 1); return `${b.rows.length} points, last ${b.rows[b.rows.length - 1][1].toFixed(4)}`; }],
      ['Yahoo crumb handshake', async () => { const c = await Yahoo.crumb(); return 'ok (' + c.length + ' chars)'; }],
      ['Yahoo profile (AAPL)', async () => { const m = await Yahoo.meta('AAPL'); return `${m.sector || '?'} / ${m.country || '?'}`; }],
      ['ETF look-through (IWDA.AS)', async () => { const m = await Yahoo.meta('IWDA.AS'); return `${m.holdings.length} holdings, ${m.sectorWeights.length} sectors`; }]
    ];
    for (const [name, fn] of checks) {
      try { log(`  PASS  ${name} — ${await fn()}`); }
      catch (e) { log(`  FAIL  ${name} — ${e.message || e}`); }
    }
    const st = Cache.stats();
    log(`\ncache: ${st.bars} series, ${st.meta} profiles, ${st.kb} KB`);
    log('Paste this output into a GitHub issue if something is wrong.');
  }

  function exportAll() {
    const dump = { version: VERSION, exported: new Date().toISOString(), settings: settings(), positions: positions(), cache: {} };
    for (const k of Store.keys()) if (k.indexOf('bars:') === 0 || k.indexOf('meta:') === 0) dump.cache[k] = Store.get(k, null);
    download('portfolio-risk-lens-' + new Date().toISOString().slice(0, 10) + '.json',
      JSON.stringify(dump, null, 1), 'application/json');
  }

  // ---- orchestration -------------------------------------------------------

  async function run(force) {
    STATE.busy = true; render();
    try {
      // Deliberately NOT Cache.clearPrices() here. Refresh used to wipe every
      // cached series before trying to refetch, so a refresh while offline —
      // or while rate-limited, which a refresh is precisely the burst most
      // likely to cause — destroyed the data the cache exists to preserve.
      // `force` now bypasses the TTL instead; Cache.bars keeps the old rows as
      // a fallback and flags them stale if the refetch fails.
      STATE.result = await analyse((m) => {
        STATE.msg = m;
        const b = document.getElementById('prl-body');
        if (b && !STATE.result) b.innerHTML = `<div class="prl-card"><p class="sub">Loading… ${esc(m)}</p></div>`;
      }, force);
    } catch (e) {
      console.error('[PRL]', e);
      STATE.result = { empty: true, failures: [{ sym: '—', why: String(e.message || e) }] };
    } finally {
      STATE.busy = false; STATE.msg = ''; render();
    }
  }

  function toggle(on) {
    const root = document.getElementById('prl-root');
    if (!root) return;
    const show = on === undefined ? !root.classList.contains('on') : on;
    root.classList.toggle('on', show);
    document.documentElement.style.overflow = show ? 'hidden' : '';
    if (show && !STATE.result) run(false);
    else if (show) render();
  }

  // ---- ticker detection on stockanalysis pages -----------------------------

  /** Map the stockanalysis URL you are looking at to a Yahoo symbol. */
  function currentTicker() {
    const m = location.pathname.match(/^\/(stocks|etf)\/([^/]+)\//);
    if (m) return m[2].toUpperCase();
    const q = location.pathname.match(/^\/quote\/([^/]+)\/([^/]+)\//);
    if (q) {
      const suf = EXCHANGE_SUFFIX[q[1].toLowerCase()];
      if (suf) return q[2].toUpperCase() + suf;
    }
    return null;
  }

  function mountButton() {
    if (document.getElementById('prl-btn')) return;
    const b = document.createElement('button');
    b.id = 'prl-btn';
    const t = currentTicker();
    b.textContent = t ? `Risk Lens · ${t}` : 'Risk Lens';
    b.title = t ? `Open Portfolio Risk Lens (${t} detected)` : 'Open Portfolio Risk Lens';
    b.addEventListener('click', () => {
      const t2 = currentTicker();
      if (t2 && !positions().some((p) => p.sym === t2)) {
        if (confirm(`Add ${t2} to your portfolio?`)) {
          savePositions(positions().concat([{ sym: t2, shares: '', cost: '', target: '', note: '' }]));
          STATE.tab = 'positions'; STATE.result = null;
        }
      }
      toggle(true);
    });
    document.body.appendChild(b);
  }

  function boot() {
    GM_addStyle(css());
    const root = document.createElement('div');
    root.id = 'prl-root';
    document.body.appendChild(root);
    mountButton();
    // The site is a SPA: re-mount the button after client-side navigations.
    let last = location.href;
    setInterval(() => {
      if (location.href !== last) {
        last = location.href;
        const b = document.getElementById('prl-btn');
        if (b) b.remove();
        mountButton();
      }
    }, 900);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') toggle(false);
    });
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
