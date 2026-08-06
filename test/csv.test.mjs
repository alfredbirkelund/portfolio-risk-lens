/**
 * CSV import tests. Import is the first thing a new user touches, and the
 * failure mode that matters is silent corruption — a European export using
 * semicolons and decimal commas parsed as if it were a US comma file turns
 * "1.234,5 shares" into nonsense without raising anything.
 *
 *   node test/csv.test.mjs
 */
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../portfolio-risk-lens.user.js', import.meta.url), 'utf8');
const body = SRC.slice(SRC.indexOf('// 7b. CSV IMPORT'), SRC.indexOf('// 8. UI'));
const { parseCSV, positionsToCSV } = new Function('document', body + '\n return { parseCSV, positionsToCSV };')({});

let fails = 0;
const check = (n, c, d = '') => { if (!c) fails++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };
const eq = (n, got, want) => check(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);

console.log('Portfolio Risk Lens — CSV import\n');

// --- plain comma, with header ----------------------------------------------
let r = parseCSV(`symbol,shares,cost,target,note
AAPL,40,150,22,Services margin
NOVO-B.CO,120,620,18,GLP-1 capacity`);
check('comma file parses', r.rows.length === 2, `${r.rows.length} rows`);
eq('  first row', r.rows[0], { sym: 'AAPL', shares: '40', cost: '150', target: '22', note: 'Services margin' });
check('  keeps exchange suffix', r.rows[1].sym === 'NOVO-B.CO', r.rows[1].sym);

// --- European: semicolon delimiter + decimal comma --------------------------
r = parseCSV(`Ticker;Antal;Kurs;Vaegt
NOVO-B.CO;120,5;619,40;18,0
7203.T;300;2.600,50;12,0`);
check('semicolon delimiter detected', r.delim === ';');
check('decimal comma detected', r.decimalComma === true);
check('  fractional shares survive', r.rows[0].shares === '120.5', r.rows[0].shares);
check('  decimal comma converted', r.rows[0].cost === '619.40', r.rows[0].cost);
check('  thousands separator stripped', r.rows[1].cost === '2600.50', r.rows[1].cost);
check('  Danish header aliases matched', r.rows[0].target === '18.0', r.rows[0].target);

// --- US thousands separators inside quotes ----------------------------------
r = parseCSV(`symbol,shares,cost
BRK-B,"1,250","412.30"`);
check('quoted thousands separator handled', r.rows[0].shares === '1250', r.rows[0].shares);
check('  quoted decimal preserved', r.rows[0].cost === '412.30', r.rows[0].cost);

// --- tab delimited ----------------------------------------------------------
r = parseCSV('symbol\tshares\tcost\nMSFT\t10\t380');
check('tab delimiter detected', r.delim === '\t' && r.rows.length === 1);

// --- headerless -------------------------------------------------------------
r = parseCSV('AAPL,40,150\nMSFT,10,380');
check('headerless file assumes field order', r.rows.length === 2 && r.rows[0].sym === 'AAPL' && r.rows[0].shares === '40');

// --- header in any order ----------------------------------------------------
r = parseCSV(`note,ticker,quantity
Core sleeve,IWDA.AS,150`);
eq('columns matched by name not position',
  [r.rows[0].sym, r.rows[0].shares, r.rows[0].note], ['IWDA.AS', '150', 'Core sleeve']);

// --- junk rejection ---------------------------------------------------------
r = parseCSV(`symbol,shares
AAPL,40
,99
Total portfolio value,12345
MSFT,10`);
check('junk rows skipped, valid rows kept', r.rows.length === 2, `${r.rows.length} rows kept, ${r.skipped.length} skipped`);
check('  skipped rows reported', r.skipped.length === 2);

// --- quoted commas in notes -------------------------------------------------
r = parseCSV(`symbol,shares,cost,target,note
AAPL,40,150,22,"Buybacks, services mix, China risk"`);
check('quoted commas inside a field', r.rows[0].note === 'Buybacks, services mix, China risk', r.rows[0].note);

// --- empty / garbage --------------------------------------------------------
check('empty input handled', parseCSV('').rows.length === 0);
check('garbage input handled', parseCSV('!!!\n???').rows.length === 0);

// --- round trip -------------------------------------------------------------
const pos = [
  { sym: 'AAPL', shares: '40', cost: '150', target: '22', note: 'Buybacks, services' },
  { sym: '005930.KS', shares: '90', cost: '68000', target: '12', note: 'HBM "cycle"' }
];
const round = parseCSV(positionsToCSV(pos)).rows;
eq('export -> import round trip', round, pos);

console.log(fails ? `\n${fails} CHECK(S) FAILED\n` : '\nALL CHECKS PASSED\n');
process.exit(fails ? 1 : 0);
