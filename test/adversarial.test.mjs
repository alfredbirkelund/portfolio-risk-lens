/**
 * Adversarial suite.
 *
 * Everything here is deterministic: a fake Yahoo responder serves synthetic
 * series, so we can drive cases live markets never produce — a constant price,
 * two perfectly identical assets, a two-week history, forty positions, a note
 * field containing a <script> tag. Real data cannot test these; it is too
 * well-behaved.
 *
 *   node test/adversarial.test.mjs
 */
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../portfolio-risk-lens.user.js', import.meta.url), 'utf8');

let fails = 0;
const check = (n, c, d = '') => { if (!c) fails++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };
const section = (s) => console.log(`\n── ${s} ──`);

// ---------------------------------------------------------------- fake world
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** Per-symbol synthetic behaviour. */
const WORLD = {};
const DAY = 86400;
const TODAY = Math.floor(Date.UTC(2026, 7, 6) / 1000);

function series(sym) {
  const cfg = WORLD[sym] || {};
  const n = cfg.n === undefined ? 1300 : cfg.n;
  const rnd = mulberry32(cfg.seed === undefined ? 42 : cfg.seed);
  const ts = [], px = [];
  let p = cfg.start || 100;
  for (let i = n - 1; i >= 0; i--) {
    const t = TODAY - i * DAY;
    const d = new Date(t * 1000).getUTCDay();
    if (d === 0 || d === 6) continue;                 // weekdays only
    if (!cfg.constant) {
      const shock = cfg.vol === undefined ? 0.012 : cfg.vol;
      p *= 1 + (rnd() - 0.5) * 2 * shock + (cfg.drift || 0);
    }
    ts.push(t); px.push(cfg.constant ? (cfg.start || 100) : p);
  }
  return { ts, px };
}

function fakeResponder(url) {
  if (url.includes('fc.yahoo.com')) return { status: 200, responseText: '' };
  if (url.includes('/v1/test/getcrumb')) return { status: 200, responseText: 'testcrumb' };

  let m = url.match(/\/v8\/finance\/chart\/([^?]+)/);
  if (m) {
    const sym = decodeURIComponent(m[1]);
    const cfg = WORLD[sym] || {};
    if (cfg.fail) return { status: 404, responseText: '{}' };
    const { ts, px } = series(sym);
    return {
      status: 200,
      responseText: JSON.stringify({
        chart: { result: [{ meta: { currency: cfg.currency || 'USD' }, timestamp: ts,
          indicators: { quote: [{ close: px }], adjclose: [{ adjclose: px }] } }] }
      })
    };
  }
  m = url.match(/\/v10\/finance\/quoteSummary\/([^?]+)/);
  if (m) {
    const sym = decodeURIComponent(m[1]);
    const cfg = WORLD[sym] || {};
    if (cfg.metaFail) return { status: 500, responseText: '{}' };
    return {
      status: 200,
      responseText: JSON.stringify({
        quoteSummary: { result: [{
          assetProfile: { sector: cfg.sector || 'Technology', country: cfg.country || 'United States' },
          quoteType: { quoteType: cfg.type || 'EQUITY', longName: cfg.name || sym },
          topHoldings: cfg.holdings ? {
            holdings: cfg.holdings.map((h) => ({ symbol: h[0], holdingName: h[0], holdingPercent: { raw: h[1] } })),
            sectorWeightings: [{ technology: { raw: 0.4 } }, { healthcare: { raw: 0.6 } }]
          } : undefined
        }] }
      })
    };
  }
  return { status: 404, responseText: '{}' };
}

function makeApi() {
  const mem = new Map();
  const el = () => ({
    id: '', className: '', innerHTML: '', textContent: '', style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    getAttribute: () => null, setAttribute() {},
    appendChild() {}, remove() {}, addEventListener() {}, click() {},
    querySelector: () => null, querySelectorAll: () => []
  });
  const ctx = {
    GM_getValue: (k, d) => (mem.has(k) ? mem.get(k) : d),
    GM_setValue: (k, v) => mem.set(k, v),
    GM_deleteValue: (k) => mem.delete(k),
    GM_listValues: () => [...mem.keys()],
    GM_addStyle: () => {},
    GM_xmlhttpRequest: ({ url, onload }) => { setTimeout(() => onload(fakeResponder(url)), 0); },
    document: { body: el(), documentElement: { classList: { contains: () => false }, style: {}, getAttribute: () => null },
      createElement: el, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    window: { matchMedia: () => ({ matches: false }) },
    getComputedStyle: () => ({ backgroundColor: 'rgb(252,252,251)' }),
    location: { pathname: '/', href: '' },
    setInterval: () => 0,
    console: { warn() {}, error() {}, log() {} }
  };
  const body = SRC.slice(SRC.indexOf('// 1. CONFIG'), SRC.indexOf('// ---- event wiring'));
  return new Function(...Object.keys(ctx), body + `
    return { analyse, settings, saveSettings, savePositions, positions, parseCSV, positionsToCSV,
             positionsHTML, riskHTML, scenariosHTML, dataHTML, sampleCov, ledoitWolf, corrFromCov,
             maxDrawdown, weekKey, toWeekly, alignSeries, returnsMatrix, trimToYears, matVec, dot,
             clusterOrder, buildExposures, isDark, esc, _mem: null };`
  )(...Object.values(ctx));
}

const API = makeApi();

// ========================================================== A. MATH CORRECTNESS
section('Maths against independent recomputation');

{
  // sample covariance vs a naive double loop
  const R = [[0.01, -0.02], [0.03, 0.01], [-0.01, 0.02], [0.02, -0.01], [0.00, 0.03]];
  const S = API.sampleCov(R);
  const mean = (j) => R.reduce((s, r) => s + r[j], 0) / R.length;
  const naive = (i, j) => R.reduce((s, r) => s + (r[i] - mean(i)) * (r[j] - mean(j)), 0) / R.length;
  check('sample covariance matches naive computation',
    Math.abs(S[0][0] - naive(0, 0)) < 1e-15 && Math.abs(S[0][1] - naive(0, 1)) < 1e-15);
  check('covariance is symmetric', Math.abs(S[0][1] - S[1][0]) < 1e-18);
}

{
  // Euler decomposition against a numerical derivative of portfolio vol
  const rnd = mulberry32(7);
  const N = 4, T = 600;
  const R = Array.from({ length: T }, () => Array.from({ length: N }, () => (rnd() - 0.5) * 0.04));
  const { Sigma } = API.ledoitWolf(R);
  const w = [0.4, 0.3, 0.2, 0.1];
  const vol = (x) => Math.sqrt(API.dot(x, API.matVec(Sigma, x)));
  const v0 = vol(w);
  const contrib = w.map((wi, i) => (wi * API.matVec(Sigma, w)[i]) / (v0 * v0));
  // d(vol)/d(w_i) * w_i / vol  should equal the analytic contribution
  const numeric = w.map((wi, i) => {
    const h = 1e-7, up = w.slice(); up[i] += h;
    return ((vol(up) - v0) / h) * wi / v0;
  });
  check('risk contributions match a numerical derivative of portfolio volatility',
    contrib.every((c, i) => Math.abs(c - numeric[i]) < 1e-5),
    `max diff ${Math.max(...contrib.map((c, i) => Math.abs(c - numeric[i]))).toExponential(1)}`);
}

{
  /*
   * Shrinkage must fall as observations accumulate — but only when the target
   * actually misspecifies the data. Independent noise IS constant-correlation
   * (r̄ = 0), so the target is exact, gamma collapses and delta = 1 is the
   * correct answer. Two correlated clusters give the target something it
   * genuinely cannot represent, which is the case worth testing.
   */
  const build = (T, seed) => {
    const r = mulberry32(seed), out = [];
    for (let t = 0; t < T; t++) {
      const fA = (r() - 0.5) * 0.03, fB = (r() - 0.5) * 0.03, row = [];
      for (let i = 0; i < 6; i++) row.push((i < 3 ? fA : fB) * 0.9 + (r() - 0.5) * 0.01);
      out.push(row);
    }
    return out;
  };
  const deltas = [30, 150, 1500].map((T) => API.ledoitWolf(build(T, 5)).delta);
  check('shrinkage decreases monotonically as observations grow',
    deltas[0] > deltas[1] && deltas[1] > deltas[2],
    `T=30 ${deltas[0].toFixed(4)} > T=150 ${deltas[1].toFixed(4)} > T=1500 ${deltas[2].toFixed(4)}`);
  check('shrinkage stays within [0,1]', deltas.every((d) => d >= 0 && d <= 1));

  // Independent noise: the target is exact, so full shrinkage is right.
  const r2 = mulberry32(1);
  const iid = Array.from({ length: 3000 }, () => Array.from({ length: 5 }, () => (r2() - 0.5) * 0.04));
  check('shrinks fully when the target is exactly right', API.ledoitWolf(iid).delta > 0.9,
    `delta ${API.ledoitWolf(iid).delta.toFixed(3)} on uncorrelated noise`);
}

{
  // Path: 1.10, 0.55, 0.66, 0.594, 0.7722. Peak 1.10, trough 0.55 -> -50%.
  const mdd = API.maxDrawdown([0.1, -0.5, 0.2, -0.1, 0.3]);
  check('max drawdown matches hand calculation', Math.abs(mdd.mdd - (0.55 / 1.1 - 1)) < 1e-12,
    `${(mdd.mdd * 100).toFixed(2)}%`);
  check('  drawdown is measured from the running peak, not the start',
    mdd.from === 0 && mdd.at === 1, `peak idx ${mdd.from}, trough idx ${mdd.at}`);
  check('no drawdown on a monotonically rising series', API.maxDrawdown([0.01, 0.02, 0.03]).mdd === 0);
}

{
  // ISO week keys across a year boundary: 2025-12-29 (Mon) .. 2026-01-04 (Sun)
  // are one ISO week and must share a key; 2026-01-05 must not.
  const wk = API.weekKey;
  check('ISO week grouping survives the year boundary',
    wk('2025-12-29') === wk('2026-01-04') && wk('2026-01-05') !== wk('2026-01-04'),
    `${wk('2025-12-29')} / ${wk('2026-01-04')} / ${wk('2026-01-05')}`);
  check('a Sunday belongs to the week that started on Monday',
    wk('2026-03-01') === wk('2026-02-23'));
}

{
  const rows = [['2016-01-04', 1], ['2020-01-06', 2], ['2026-08-01', 3]];
  check('trimToYears keeps only the trailing window',
    API.trimToYears(rows, 10).length === 2 && API.trimToYears(rows, 30).length === 3);
  check('trimToYears never empties a series', API.trimToYears(rows, 0.001).length >= 1);
}

// ========================================== B. DEGENERATE PORTFOLIOS (pipeline)
section('Degenerate portfolios');

async function run(positions, settings = {}) {
  const api = makeApi();
  api.saveSettings(Object.assign({ base: 'USD', benchmark: 'BENCH', years: 10 }, settings));
  api.savePositions(positions);
  const r = await api.analyse();
  const html = r.empty ? '' : [api.positionsHTML(r), api.riskHTML(r), api.scenariosHTML(r), api.dataHTML(r)].join('');
  return { r, html, api };
}

const clean = (h) => !/NaN|undefined|Infinity|\[object/.test(h);

{
  WORLD.FLAT = { constant: true };
  WORLD.NORM = { seed: 3 };
  WORLD.BENCH = { seed: 9 };
  const { r, html } = await run([{ sym: 'FLAT', shares: '10' }, { sym: 'NORM', shares: '10' }]);
  check('constant-price asset does not produce NaN', clean(html), 'no NaN/undefined in markup');
  check('  correlations stay finite',
    !r.risk || r.risk.C.every((row) => row.every((v) => isFinite(v))));
  check('  risk contributions still sum to 1',
    !r.risk || Math.abs(r.risk.contrib.reduce((a, b) => a + b, 0) - 1) < 1e-9);
}

{
  WORLD.TWIN1 = { seed: 5 }; WORLD.TWIN2 = { seed: 5 };   // identical series
  const { r, html } = await run([{ sym: 'TWIN1', shares: '10' }, { sym: 'TWIN2', shares: '10' }]);
  check('perfectly identical assets (singular matrix) do not break', clean(html));
  check('  correlation of identical assets is ~1',
    !r.risk || Math.abs(r.risk.C[0][1] - 1) < 1e-6, r.risk ? r.risk.C[0][1].toFixed(6) : 'n/a');
  check('  volatility remains finite', !r.risk || isFinite(r.risk.volAnn));
}

{
  const { r, html } = await run([{ sym: 'NORM', shares: '10' }]);
  check('single position renders without crashing', clean(html));
  check('  risk block withheld for a one-name book', !r.risk);
  check('  message explains it needs more than one holding',
    /at least two|more than one|one holding|single position/i.test(html),
    'wording check');
}

{
  WORLD.SHORT = { seed: 11, n: 20 };                       // ~14 trading days
  const { r, html } = await run([{ sym: 'SHORT', shares: '10' }, { sym: 'NORM', shares: '10' }]);
  check('very short history is refused, not estimated', !r.risk);
  check('  insufficient-history notice shown', /insufficient|withheld|observations/i.test(html));
  check('  markup still clean', clean(html));
}

{
  const { r, html } = await run([
    { sym: 'NORM', shares: '10' }, { sym: 'BAD', shares: 'abc' }, { sym: 'ZERO', shares: '0' },
    { sym: 'NEG', shares: '-5' }, { sym: 'BENCH', shares: '10' }
  ]);
  check('non-numeric, zero and negative share counts are excluded',
    r.positions.every((p) => Number(p.shares) > 0), r.positions.map((p) => p.sym).join(','));
  check('  exclusion is surfaced, not silent',
    /ignored|excluded|invalid|skipped/i.test(html), 'looking for a visible notice');
}

{
  WORLD.GONE = { fail: true };
  const { r, html } = await run([{ sym: 'NORM', shares: '10' }, { sym: 'GONE', shares: '10' }, { sym: 'BENCH', shares: '5' }]);
  check('a symbol that cannot be fetched is reported', r.failures.length === 1, r.failures.map((f) => f.sym).join(','));
  check('  the rest of the portfolio still computes', r.positions.length === 2 && !!r.risk);
  check('  failure named in the markup', /GONE/.test(html));
}

{
  const { r, html } = await run([{ sym: 'NORM', shares: '10' }, { sym: 'NORM', shares: '5' }, { sym: 'BENCH', shares: '5' }]);
  check('duplicate symbols do not corrupt the book', clean(html));
  check('  duplicates flagged to the user', /duplicate/i.test(html),
    `weights: ${r.positions.map((p) => (p.weight * 100).toFixed(1) + '%').join(', ')}`);
}

{
  /*
   * Refresh used to clear the price cache before refetching, so refreshing
   * while offline — or while rate-limited, which a refresh is the burst most
   * likely to trigger — destroyed exactly the data the cache exists to
   * preserve. A forced refresh that fails must fall back to stale prices.
   */
  WORLD.KEEP = { seed: 31 };
  const api = makeApi();
  api.saveSettings({ base: 'USD', benchmark: 'BENCH', years: 10 });
  api.savePositions([{ sym: 'KEEP', shares: '10' }, { sym: 'BENCH', shares: '10' }]);

  const first = await api.analyse();
  check('baseline load succeeds', !first.empty && first.positions.length === 2);

  WORLD.KEEP.fail = true; WORLD.BENCH.fail = true;         // network goes away
  const second = await api.analyse(() => {}, true);          // forced refresh
  WORLD.KEEP.fail = false; WORLD.BENCH.fail = false;

  check('forced refresh while offline keeps the portfolio',
    !second.empty && second.positions.length === 2,
    second.empty ? 'PORTFOLIO LOST' : `${second.positions.length} positions retained`);
  check('  retained prices are marked stale',
    second.positions.every((p) => p.stale === true));
  check('  staleness is surfaced to the user',
    second.warnings.some((w) => /cached prices/i.test(w)));
}

// ================================================================ C. ESCAPING
section('Escaping and injection');

{
  const XSS = '<img src=x onerror=alert(1)>';
  const { html } = await run([
    { sym: 'NORM', shares: '10', note: XSS }, { sym: 'BENCH', shares: '10', note: '"><script>alert(2)</script>' }
  ]);
  check('script tag in a note is escaped', !/<script>alert/.test(html));
  check('img-onerror in a note is escaped', !/<img src=x/.test(html));
  check('  escaped form is present (so it was rendered, not dropped)', /&lt;img/.test(html));
  check('  attribute break-out neutralised', !/"><script/.test(html));
}

{
  /*
   * "CONSTRUCTOR" and "TOSTRING" are legitimate-looking ticker strings, so
   * rejecting them would be wrong. The hazard is not the name — it is looking
   * them up in a plain object, where an inherited property answers as if it
   * were real data. The lookup tables are null-prototype; this proves it.
   */
  const bad = API.parseCSV('symbol,shares\n__proto__,5\nconstructor,5\nNORM,5');
  check('leading-underscore junk symbols rejected',
    !bad.rows.some((r) => r.sym === '__PROTO__'), bad.rows.map((r) => r.sym).join(','));
  check('  object prototype is untouched', ({}).polluted === undefined && [].polluted === undefined);

  WORLD.CONSTRUCTOR = { seed: 21 };
  WORLD.TOSTRING = { seed: 22 };
  const { r, html } = await run([
    { sym: 'CONSTRUCTOR', shares: '10' }, { sym: 'TOSTRING', shares: '10' },
    { sym: 'NORM', shares: '10' }, { sym: 'BENCH', shares: '5' }
  ]);
  check('prototype-shaped ticker names are handled as ordinary data',
    r.positions.length === 4 && !!r.risk && clean(html),
    r.positions.map((p) => p.sym).join(','));
  check('  no phantom position invented from an inherited property',
    r.positions.every((p) => typeof p.value === 'number' && isFinite(p.value)));
}

{
  // A note beginning with = + - or @ executes when the exported CSV is opened
  // in Excel or Sheets. Export must defuse it.
  const rows = [{ sym: 'NORM', shares: '5', cost: '', target: '', note: '=cmd|\' /C calc\'!A1' },
                { sym: 'ACME', shares: '5', cost: '', target: '', note: '@SUM(1+1)' },
                { sym: 'PLUS', shares: '5', cost: '', target: '', note: '+1+1' }];
  const out = API.positionsToCSV(rows);
  const cells = out.split('\n').slice(1).map((l) => l.replace(/^[^,]*,[^,]*,[^,]*,[^,]*,/, ''));
  check('spreadsheet formula injection defused on export',
    cells.every((c) => !/^"?[=+@]/.test(c)), cells.map((c) => c.slice(0, 6)).join(' | '));
  check('  re-importing recovers the note without the guard breaking the symbol',
    API.parseCSV(out).rows.length === 3 && API.parseCSV(out).rows[0].sym === 'NORM');
}

// ================================================================== D. SCALE
section('Scale');

{
  for (let i = 0; i < 40; i++) WORLD['S' + i] = { seed: 100 + i };
  const pos = Array.from({ length: 40 }, (_, i) => ({ sym: 'S' + i, shares: '10', note: 'holding ' + i }));
  const t0 = Date.now();
  const { r, html } = await run(pos.concat([{ sym: 'BENCH', shares: '1' }]));
  const ms = Date.now() - t0;
  check('40-position portfolio computes', !!r.risk && r.positions.length === 41, `${r.positions.length} positions`);
  check('  markup clean at scale', clean(html));
  check('  completes in reasonable time', ms < 30000, `${ms} ms`);
  check('  correlation matrix is the right size', !r.risk || r.risk.C.length === 41);
  check('  cluster order is a permutation of all names',
    !r.risk || new Set(r.risk.order).size === 41);
}

console.log(fails ? `\n${fails} CHECK(S) FAILED\n` : '\nALL CHECKS PASSED\n');
process.exit(fails ? 1 : 0);
