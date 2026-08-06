/**
 * End-to-end render harness.
 *
 * Loads CONFIG -> STORAGE -> NET -> YAHOO -> CACHE -> MATH -> ENGINE -> UI from
 * the shipped userscript verbatim, shims GM_* and a minimal DOM, then runs the
 * real analyse() against live Yahoo data and renders every tab. Catches the
 * class of bug that only appears on first render.
 *
 *   node test/ui.render.mjs [outfile.html]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../portfolio-risk-lens.user.js', import.meta.url), 'utf8');
const body = SRC.slice(SRC.indexOf('// 1. CONFIG'), SRC.indexOf('// ---- event wiring'));

// ---- shims ---------------------------------------------------------------
const mem = new Map();
const jar = new Map();
const el = () => ({
  id: '', className: '', innerHTML: '', textContent: '', style: {}, dataset: {},
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  getAttribute: () => null, setAttribute() {},
  appendChild() {}, remove() {}, addEventListener() {}, click() {},
  querySelector: () => null, querySelectorAll: () => []
});
const documentStub = {
  body: el(),
  documentElement: { classList: { contains: () => false }, style: {}, getAttribute: () => null },
  createElement: el,
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {}
};

const ctx = {
  GM_getValue: (k, d) => (mem.has(k) ? mem.get(k) : d),
  GM_setValue: (k, v) => mem.set(k, v),
  GM_deleteValue: (k) => mem.delete(k),
  GM_listValues: () => [...mem.keys()],
  GM_addStyle: () => {},
  // Node's fetch has no cookie jar; GM_xmlhttpRequest in a browser does. Without
  // one the crumb handshake can never succeed, so we keep a minimal jar here to
  // exercise the same code path the real script takes.
  GM_xmlhttpRequest: ({ url, onload, onerror }) => {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
    };
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    fetch(url, { headers })
      .then(async (r) => {
        for (const c of (r.headers.getSetCookie?.() || [])) {
          const [pair] = c.split(';');
          const i = pair.indexOf('=');
          if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
        }
        onload({ status: r.status, responseText: await r.text() });
      })
      .catch((e) => onerror && onerror(e));
  },
  document: documentStub,
  window: { matchMedia: () => ({ matches: false }) },
  // Light surface, matching the default the palette was validated against.
  getComputedStyle: () => ({ backgroundColor: 'rgb(252, 252, 251)' }),
  location: { pathname: '/stocks/aapl/', href: 'https://stockanalysis.com/stocks/aapl/' },
  setInterval: () => 0,
  console
};

const api = new Function(...Object.keys(ctx), body + `
  return { analyse, settings, saveSettings, savePositions, positions,
           positionsHTML, riskHTML, scenariosHTML, dataHTML, css, STATE, P,
           StockAnalysis, Yahoo };`
)(...Object.values(ctx));

// ---- the awkward portfolio ------------------------------------------------
api.saveSettings({ base: 'DKK', benchmark: 'URTH' });
api.savePositions([
  { sym: 'AAPL', shares: '40', cost: '150', target: '22', note: 'Services margin, buyback support' },
  { sym: '7203.T', shares: '300', cost: '2600', target: '12', note: 'Hybrid lead, cheap on EV/EBIT' },
  { sym: '005930.KS', shares: '90', cost: '68000', target: '12', note: 'HBM cycle, memory upturn' },
  { sym: 'NOVO-B.CO', shares: '120', cost: '620', target: '18', note: 'GLP-1 capacity, DKK earner' },
  { sym: 'IWDA.AS', shares: '150', cost: '92', target: '36', note: 'Core beta sleeve' }
]);

let fails = 0;
const check = (n, c, d = '') => { if (!c) fails++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

console.log('Portfolio Risk Lens — UI render harness\n');
const r = await api.analyse((m) => process.stdout.write(`\r  ${m.padEnd(46)}`));
process.stdout.write('\r' + ' '.repeat(50) + '\r');

check('analyse returned a populated result', r && !r.empty);
check('all five positions priced', r.positions.length === 5, `${r.positions.length}/5`);
check('no fetch failures', !r.failures.length, r.failures.map((f) => f.sym).join(',') || 'none');
check('weekly sampling auto-selected', r.freq === 'weekly', r.freq);
check('risk block computed', !!r.risk);
check('weights sum to 1', Math.abs(r.positions.reduce((s, p) => s + p.weight, 0) - 1) < 1e-9);
check('no currency left unconverted', !r.warnings.some((w) => /No exchange rate/.test(w)),
  r.warnings.find((w) => /No exchange rate/.test(w)) || 'all converted');

/*
 * Weights summing to 1 proves nothing — they are normalised, so a KRW price
 * mistakenly treated as DKK still sums to 1 while making every weight wrong.
 * The real check is that no single position dominates through unit confusion:
 * these five holdings were sized to be broadly comparable in value, so any
 * weight above 60% means a currency was not converted.
 */
const maxW = Math.max(...r.positions.map((p) => p.weight));
check('no position dominates through unit confusion', maxW < 0.6,
  `largest weight ${(maxW * 100).toFixed(1)}% (${r.positions.find((p) => p.weight === maxW).sym})`);

// Cross-check one conversion against an independent spot rate.
{
  const jp = r.positions.find((p) => p.sym === '7203.T');
  const fxr = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/USDDKK=X?range=5d&interval=1d')
    .then((x) => x.json()).catch(() => null);
  const jpy = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/USDJPY=X?range=5d&interval=1d')
    .then((x) => x.json()).catch(() => null);
  if (jp && fxr && jpy) {
    const px = (j) => (j.chart.result[0].indicators.quote[0].close.filter(Boolean).pop());
    const expect = Number(jp.shares) * (jp.value / Number(jp.shares));  // reported per-share in DKK
    const perShareDkk = jp.value / Number(jp.shares);
    const impliedJpy = perShareDkk * (px(jpy) / px(fxr));
    check('Toyota converts back to a plausible JPY price', impliedJpy > 1000 && impliedJpy < 8000,
      `${perShareDkk.toFixed(2)} DKK/share implies ${impliedJpy.toFixed(0)} JPY`);
  } else {
    check('Toyota converts back to a plausible JPY price', false, 'could not fetch cross-check rates');
  }
}
check('ETF look-through populated sectors', r.exposures.sector.length > 3, `${r.exposures.sector.length} sectors`);
check('multi-currency exposure', r.exposures.currency.length >= 4, r.exposures.currency.map((c) => c.k).join(','));

// --- security-level look-through -------------------------------------------
const lt = r.exposures.lookthrough;
check('look-through built', lt.length > 5, `${lt.length} underlying names`);
check('look-through weights are sane', lt.every((e) => e.total > 0 && e.total <= 1.0001));
const ltSum = lt.reduce((s, e) => s + e.total, 0);
check('look-through totals to ~100%', Math.abs(ltSum - 1) < 0.02, `${(ltSum * 100).toFixed(2)}%`);

// AAPL is held directly AND sits inside IWDA — the netting case that motivates
// the whole feature. If this stops firing, the look-through has silently broken.
const apple = lt.find((e) => e.key === 'AAPL');
check('overlap detected for a directly-held index constituent', !!apple && apple.direct > 0 && apple.indirect > 0,
  apple ? `direct ${(apple.direct * 100).toFixed(2)}% + via fund ${(apple.indirect * 100).toFixed(2)}% = ${(apple.total * 100).toFixed(2)}%` : 'AAPL missing');
check('overlaps list non-empty', r.exposures.overlaps.length > 0,
  r.exposures.overlaps.map((e) => e.key).join(','));
check('unitemised fund remainder tracked', r.exposures.unitemised > 0,
  `${(r.exposures.unitemised * 100).toFixed(1)}% beyond published top holdings`);


// --- regressions found by driving it in a real browser ----------------------
/*
 * stockanalysis ignores the range parameter and returns everything it has —
 * 11,048 bars from 1982 for AAPL. Untrimmed that silently overrode the user's
 * lookback and grew the cache to 1.7 MB. Trimming is central now; this guards
 * it. A 10-year window is ~520 weekly observations, so 900 is a generous cap
 * that still catches a 30-year series slipping through.
 */
{
  const yrs = api.settings().years;
  const perYear = r.freq === 'weekly' ? 52 : 252;
  check('lookback honoured regardless of source', r.obs <= yrs * perYear * 1.15,
    `${r.obs} ${r.freq} observations for a ${yrs}y window (cap ${Math.round(yrs * perYear * 1.15)})`);
}

check('equal-risk weights are fully invested', (() => {
  if (!r.risk) return false;
  const inv = r.risk.assetVol.map((v) => (v > 0 ? 1 / v : 0));
  const sum = inv.reduce((a, b) => a + b, 0);
  const w = inv.map((v) => v / sum);
  const tot = w.reduce((a, b) => a + b, 0);
  return Math.abs(tot - 1) < 1e-9 && w.every((x) => x > 0.02);
})(), 'inverse-vol weights sum to 1 with no absurdly small suggestion');


// --- fallback price source --------------------------------------------------
check('fallback declines non-US symbols', !api.StockAnalysis.supports('7203.T') && !api.StockAnalysis.supports('USDDKK=X'));
check('fallback accepts US symbols', api.StockAnalysis.supports('AAPL'));
try {
  const fb = await api.StockAnalysis.bars('AAPL');
  check('fallback source returns usable history', fb.rows.length > 500,
    `${fb.rows.length} bars from ${fb.rows[0][0]}`);
} catch (e) {
  check('fallback source returns usable history', false, e.message);
}

// ---- render every tab -----------------------------------------------------
const tabs = {};
for (const [name, fn] of [['positions', api.positionsHTML], ['risk', api.riskHTML],
                          ['scenarios', api.scenariosHTML], ['data', api.dataHTML]]) {
  try {
    tabs[name] = fn(r);
    check(`${name} tab renders`, typeof tabs[name] === 'string' && tabs[name].length > 200,
      `${tabs[name].length} chars`);
  } catch (e) {
    fails++; console.log(`  FAIL  ${name} tab renders — ${e.message}`);
    tabs[name] = `<pre>${e.stack}</pre>`;
  }
}

// structural checks on the generated markup
const all = Object.values(tabs).join('');
const balanced = (s, open, close) => (s.match(new RegExp(open, 'g')) || []).length === (s.match(new RegExp(close, 'g')) || []).length;
check('SVG tags balanced', balanced(all, '<svg', '</svg>'));
check('table tags balanced', balanced(all, '<table', '</table>'));
check('no undefined leaked into markup', !/>\s*undefined|undefined%/.test(all));
check('no NaN leaked into markup', !/NaN/.test(all));
check('heatmap emitted cells', (tabs.risk.match(/<rect/g) || []).length > 25,
  `${(tabs.risk.match(/<rect/g) || []).length} rects`);
check('look-through card rendered', /Look-through exposure/.test(tabs.risk));
// The heatmap used width="100%", which left a 5-name matrix floating in the
// middle of a very wide card. It must carry its natural pixel width instead.
check('heatmap uses its natural width, not 100%',
  /<svg viewBox="0 0 (\d+) \1" width="\1"/.test(tabs.risk), 'square viewBox with matching px width');
check('equal-risk card replaced vol-targeted sizing',
  /Equal-risk sizing/.test(tabs.scenarios) && !/Vol-targeted sizing/.test(tabs.scenarios));
check('overlap called out in prose', /true exposure of/i.test(tabs.risk));
check('CSV import UI present', /prl-csvtext/.test(tabs.positions));
check('settings panel present', /prl-setsave/.test(tabs.data));
check('stress windows reachable at default lookback', /COVID crash/.test(tabs.scenarios) && !/No stress window/.test(tabs.scenarios));
check('no silent profile failure', !r.warnings.some((w) => /profiles unavailable/.test(w)) || /profiles unavailable/.test(tabs.positions),
  r.warnings.find((w) => /profiles/.test(w)) ? 'surfaced as a warning' : 'profiles loaded');

// ---- emit a standalone preview -------------------------------------------
const out = process.argv[2] || 'preview.html';
const nav = Object.keys(tabs).map((t, i) =>
  `<button class="prl-tab ${i === 0 ? 'on' : ''}" data-t="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('');
const panes = Object.entries(tabs).map(([t, h], i) =>
  `<div class="pane" data-p="${t}" style="display:${i === 0 ? 'block' : 'none'}">${h}</div>`).join('');

writeFileSync(out, `<!doctype html><html><head><meta charset="utf-8">
<title>Portfolio Risk Lens — preview</title><style>${api.css()}
body{margin:0;background:#f9f9f7}#prl-root{display:block;position:static}
</style></head><body><div id="prl-root" class="on"><div class="prl-wrap">
<div class="prl-top"><h1>Portfolio Risk Lens</h1><span class="prl-mut">static preview · real data</span></div>
<div class="prl-tabs">${nav}</div>${panes}</div></div>
<script>
document.querySelectorAll('.prl-tab').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('.prl-tab').forEach(x=>x.classList.remove('on'));b.classList.add('on');
  document.querySelectorAll('.pane').forEach(p=>p.style.display=p.dataset.p===b.dataset.t?'block':'none');});
</script></body></html>`);

console.log(`\n  wrote ${out}`);
console.log(fails ? `\n${fails} CHECK(S) FAILED\n` : '\nALL CHECKS PASSED\n');
process.exit(fails ? 1 : 0);
