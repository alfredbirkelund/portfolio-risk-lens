/**
 * Engine test. Slices the MATH + ENGINE sections out of the shipped userscript
 * (so we test the real code, not a copy) and runs them against live Yahoo data
 * for a deliberately awkward portfolio: US + Japan + Korea + Denmark + a UCITS
 * ETF, five currencies, three regions, non-overlapping trading sessions.
 *
 *   node test/engine.test.mjs
 */
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../portfolio-risk-lens.user.js', import.meta.url), 'utf8');
const slice = SRC.slice(SRC.indexOf('// 6. MATH'), SRC.indexOf('// 8. UI'));
const M = new Function(slice + `
  return { alignSeries, toWeekly, weekKey, returnsMatrix, sampleCov, ledoitWolf,
           corrFromCov, clusterOrder, maxDrawdown, variance, covariance,
           matVec, dot, regionOf, isoDay };`)();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

async function bars(symbol, years = 3) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${years}y&interval=1d`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`${symbol}: HTTP ${r.status}`);
  const j = await r.json();
  const res = j.chart.result[0];
  const adj = res.indicators.adjclose?.[0]?.adjclose || res.indicators.quote[0].close;
  const rows = [];
  res.timestamp.forEach((t, i) => {
    const c = adj[i];
    if (c != null && isFinite(c)) rows.push([M.isoDay(t * 1000), c]);
  });
  return { currency: res.meta.currency, rows };
}

let failures = 0;
const check = (name, cond, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const SYMS = ['AAPL', '7203.T', '005930.KS', 'NOVO-B.CO', 'IWDA.AS'];
const BASE = 'DKK';

console.log('Portfolio Risk Lens — engine test\n');
console.log(`portfolio: ${SYMS.join(', ')}   base: ${BASE}\n`);

const raw = {};
for (const s of SYMS) {
  raw[s] = await bars(s);
  console.log(`  fetched ${s.padEnd(11)} ${String(raw[s].rows.length).padStart(4)} bars  ${raw[s].currency}`);
}

// --- FX -> base -------------------------------------------------------------
const currencies = [...new Set(SYMS.map((s) => raw[s].currency))];
const fx = {};
for (const c of currencies) {
  if (c === 'USD') continue;
  const b = await bars('USD' + c + '=X');
  fx[c] = new Map(b.rows);
}
if (BASE !== 'USD' && !fx[BASE]) fx[BASE] = new Map((await bars('USD' + BASE + '=X')).rows);
console.log(`  fetched FX for  ${currencies.filter((c) => c !== 'USD').join(', ')}\n`);

const toBase = (rows, cur) => {
  if (cur === BASE) return rows;
  let lf = null, lt = null;
  const out = [];
  for (const [d, p] of rows) {
    if (cur !== 'USD') { const v = fx[cur]?.get(d); if (v) lf = v; }
    if (BASE !== 'USD') { const v = fx[BASE]?.get(d); if (v) lt = v; }
    const usdPerLocal = cur === 'USD' ? 1 : (lf ? 1 / lf : null);
    const basePerUsd = BASE === 'USD' ? 1 : lt;
    if (usdPerLocal == null || basePerUsd == null) continue;
    out.push([d, p * usdPerLocal * basePerUsd]);
  }
  return out;
};

// --- alignment --------------------------------------------------------------
const series = SYMS.map((s) => ({ rows: toBase(raw[s].rows, raw[s].currency) }));
const aligned = M.alignSeries(series);
check('alignment produces a common grid', aligned.dates.length > 400, `${aligned.dates.length} dates`);
check('all columns equal length', new Set(aligned.cols.map((c) => c.length)).size === 1);
check('no nulls after alignment', aligned.cols.every((c) => c.every((v) => v != null && isFinite(v))));

// --- region detection & weekly sampling ------------------------------------
const regions = new Set(SYMS.map((s) => M.regionOf(raw[s].currency)));
check('multi-region portfolio detected', regions.size > 1, [...regions].join('+'));

const wk = M.toWeekly(aligned.dates, aligned.cols);
check('weekly resample ~1/5 of daily', wk.dates.length > aligned.dates.length / 7 && wk.dates.length < aligned.dates.length / 3,
  `${aligned.dates.length} daily -> ${wk.dates.length} weekly`);
check('weekly dates strictly increasing', wk.dates.every((d, i) => i === 0 || d > wk.dates[i - 1]));
check('one observation per ISO week', new Set(wk.dates.map(M.weekKey)).size === wk.dates.length);

// --- covariance / shrinkage -------------------------------------------------
const R = M.returnsMatrix(wk.cols);
const { Sigma, delta, sample } = M.ledoitWolf(R);
const N = SYMS.length;

check('shrinkage intensity in [0,1]', delta >= 0 && delta <= 1, `delta = ${delta.toFixed(3)}`);
check('Sigma symmetric', Sigma.every((r, i) => r.every((v, j) => Math.abs(v - Sigma[j][i]) < 1e-15)));
check('Sigma positive diagonal', Sigma.every((r, i) => r[i] > 0));

// shrinkage must pull off-diagonal correlations toward the common mean
const Cs = M.corrFromCov(sample), Cl = M.corrFromCov(Sigma);
let offS = [], offL = [];
for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) { offS.push(Cs[i][j]); offL.push(Cl[i][j]); }
const spread = (a) => Math.max(...a) - Math.min(...a);
check('shrinkage compresses correlation spread', spread(offL) <= spread(offS) + 1e-12,
  `${spread(offS).toFixed(3)} -> ${spread(offL).toFixed(3)}`);

const C = Cl;
check('correlations within [-1,1]', C.every((r) => r.every((v) => v >= -1.0000001 && v <= 1.0000001)));
check('unit diagonal', C.every((r, i) => Math.abs(r[i] - 1) < 1e-9));

// positive semi-definite: all leading principal minors non-negative via Cholesky
function isPSD(A) {
  const n = A.length, L = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = A[i][j];
    for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
    if (i === j) { if (s < -1e-12) return false; L[i][j] = Math.sqrt(Math.max(s, 0)); }
    else L[i][j] = L[j][j] > 0 ? s / L[j][j] : 0;
  }
  return true;
}
check('Sigma positive semi-definite', isPSD(Sigma));

// --- risk contribution ------------------------------------------------------
const w = [0.30, 0.15, 0.15, 0.20, 0.20];
const Sw = M.matVec(Sigma, w);
const varP = M.dot(w, Sw);
const volAnn = Math.sqrt(varP) * Math.sqrt(52);
const contrib = w.map((wi, i) => (wi * Sw[i]) / varP);
const sum = contrib.reduce((a, b) => a + b, 0);

check('risk contributions sum to 1 (Euler)', Math.abs(sum - 1) < 1e-9, `sum = ${sum.toFixed(12)}`);
check('portfolio vol plausible (5-45%)', volAnn > 0.05 && volAnn < 0.45, `${(volAnn * 100).toFixed(1)}% annualised`);

// vol must sit below the weighted average of individual vols (diversification)
const assetVol = Sigma.map((r, i) => Math.sqrt(r[i]) * Math.sqrt(52));
const wavg = w.reduce((s, wi, i) => s + wi * assetVol[i], 0);
check('diversification reduces vol vs weighted-average', volAnn < wavg,
  `${(volAnn * 100).toFixed(1)}% < ${(wavg * 100).toFixed(1)}%`);

// --- drawdown ---------------------------------------------------------------
const rp = R.map((row) => M.dot(w, row));
const dd = M.maxDrawdown(rp);
check('max drawdown negative and > -90%', dd.mdd < 0 && dd.mdd > -0.9, `${(dd.mdd * 100).toFixed(1)}%`);
check('drawdown indices ordered', dd.at >= dd.from);

// --- clustering -------------------------------------------------------------
const order = M.clusterOrder(C);
check('cluster order is a permutation', new Set(order).size === N && order.length === N, `[${order.join(',')}]`);

// --- daily vs weekly bias ---------------------------------------------------
// The whole reason for weekly sampling: daily closes across Tokyo/Seoul/NY are
// not simultaneous, so daily correlation understates true co-movement.
const Rd = M.returnsMatrix(aligned.cols);
const Cd = M.corrFromCov(M.ledoitWolf(Rd).Sigma);
const iUS = 0, iJP = 1, iKR = 2;
console.log(`\n  cross-region correlation, daily vs weekly:`);
for (const [a, b, lab] of [[iUS, iJP, 'AAPL~7203.T'], [iUS, iKR, 'AAPL~005930.KS'], [iJP, iKR, '7203.T~005930.KS']]) {
  console.log(`    ${lab.padEnd(20)} daily ${Cd[a][b].toFixed(3)}   weekly ${C[a][b].toFixed(3)}`);
}

console.log(`\n  portfolio vol ${(volAnn * 100).toFixed(1)}%   max DD ${(dd.mdd * 100).toFixed(1)}%   shrinkage ${delta.toFixed(3)}`);
console.log('  risk contribution:');
SYMS.forEach((s, i) => console.log(`    ${s.padEnd(12)} weight ${(w[i] * 100).toFixed(1)}%   risk ${(contrib[i] * 100).toFixed(1)}%   own vol ${(assetVol[i] * 100).toFixed(1)}%`));

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : '\nALL CHECKS PASSED\n');
process.exit(failures ? 1 : 0);
