import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildXlsx, colName, compareReadback, crc32, makeSpreadsheet, specFromCsv, unzip, xmlEscape, zip } from '../src/엑셀.js';
import { verifyReport } from '../src/완료근거.js';

const ws = () => mkdtempSync(path.join(tmpdir(), 'hq-xlsx-'));
const SPEC = { sheets: [
  { name: '월별 예산', columns: [{ header: '항목', type: 'text' }, { header: '날짜', type: 'date' }, { header: '금액', type: 'money', width: 14 },
    { header: '비율', type: 'percent' }, { header: '비고', type: 'text' }],
  rows: [['재료비 <A&B>', '2024-01-01', 1250000, 0.125, '=SUM(1,2)'], ['인건비', '2024. 1. 2.', '2,400,000', '15.3%', '"따옴표"\u0001'], ['예비비', '', '(미정)', null, '']],
  totals: { label: '합계', sum: ['금액'] } },
  { name: '요약', columns: [{ header: '구분' }, { header: '건수', type: 'number' }], rows: [{ 구분: '완료', 건수: 2.5 }] }] };
// What kordoc writes for SPEC (its real output format: "## sheet" and a pipe table per sheet, Markdown characters escaped).
const SPEC_MD = '## 월별 예산\n\n| 항목 | 날짜 | 금액 | 비율 | 비고 |\n| --- | --- | --- | --- | --- |\n| 재료비 \\<A&B> | 2024-01-01 | 1250000 | 0.125 | =SUM(1,2) |\n'
  + '| 인건비 | 2024-01-02 | 2400000 | 0.153 | "따옴표" |\n| 예비비 |  | (미정) |  |  |\n| 합계 |  | 3650000 |  |  |\n\n\n## 요약\n\n| 구분 | 건수 |\n| --- | --- |\n| 완료 | 2.5 |\n';

test('ZIP: CRC-32 is the standard one, and every part comes back out of the container intact', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926);
  const entries = [{ name: 'a.txt', data: Buffer.from('가나다'.repeat(200)) }, { name: '폴더/b.xml', data: Buffer.from('<x/>') }, { name: 'empty', data: Buffer.alloc(0) }];
  const z = zip(entries);
  assert.equal(z.readUInt32LE(0), 0x04034b50);
  const back = unzip(z);
  assert.deepEqual([...back.keys()], ['a.txt', '폴더/b.xml', 'empty']);
  for (const e of entries) assert.ok(back.get(e.name).equals(e.data));
  assert.deepEqual(zip(entries), z, 'same input, same bytes');
  // a damaged byte inside a stored part is caught
  const bad = Buffer.from(zip([{ name: 'x', data: Buffer.alloc(64, 7) }]));
  bad[33] ^= 0xff;
  assert.throws(() => unzip(bad), /CRC|invalid|incorrect|unexpected/i);
  assert.throws(() => unzip(Buffer.from('not a zip at all, sorry')), /not a zip/);
});

test('xlsx parts: escaped text, number formats, bold frozen header, widths and a SUM total with its cached value', () => {
  const { buffer, summary } = buildXlsx(SPEC);
  const parts = unzip(buffer);
  for (const p of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) assert.ok(parts.has(p), p);
  const text = p => parts.get(p).toString('utf8');
  const sst = text('xl/sharedStrings.xml'), s1 = text('xl/worksheets/sheet1.xml'), styles = text('xl/styles.xml');
  assert.match(text('xl/workbook.xml'), /<sheet name="월별 예산" sheetId="1" r:id="rId1"\/><sheet name="요약" sheetId="2"/);
  assert.ok(sst.includes('<t>재료비 &lt;A&amp;B&gt;</t>') && sst.includes('<t>&quot;따옴표&quot;</t>'), 'XML special characters escaped, control characters dropped');
  assert.ok(!/\u0001/.test(sst));
  // "=SUM(1,2)" typed by a team is text, never a formula
  assert.equal((s1.match(/<f>/g) ?? []).length, 1);
  assert.match(s1, /<c r="E2" t="s"><v>\d+<\/v><\/c>/);
  assert.match(s1, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
  assert.match(s1, /<c r="A1" t="s" s="1">/, 'header row bold (style 1)');
  assert.match(s1, /<col min="3" max="3" width="14" customWidth="1"\/>/);
  assert.match(s1, /<c r="B2" s="5"><v>45292<\/v><\/c>/, '2024-01-01 is day 45292, yyyy-mm-dd');
  assert.match(s1, /<c r="B3" s="5"><v>45293<\/v><\/c>/, 'Korean date "2024. 1. 2." read too');
  assert.match(s1, /<c r="C3" s="2"><v>2400000<\/v><\/c>/, '"2,400,000" is a number, #,##0');
  assert.match(s1, /<c r="D3" s="4"><v>0.153<\/v><\/c>/, '"15.3%" is 0.153 shown as 0.0%');
  assert.match(s1, /<c r="C4" t="s"><v>\d+<\/v><\/c>/, '"(미정)" in a money column stays text');
  assert.match(s1, /<c r="A5" t="s" s="7">.*<c r="C5" s="8"><f>SUM\(C2:C4\)<\/f><v>3650000<\/v><\/c>/);
  assert.match(styles, /formatCode="0\.0%"/);
  assert.match(styles, /formatCode="yyyy-mm-dd"/);
  assert.match(text('xl/worksheets/sheet2.xml'), /<c r="B2" s="3"><v>2.5<\/v><\/c>/, 'a column with decimals uses #,##0.00');
  assert.deepEqual(summary[0], { name: '월별 예산', rows: 3, columns: ['항목', '날짜', '금액', '비율', '비고'], totals: { label: '합계', values: { 금액: 3650000 } },
    warnings: ['3행 “금액” 값 “(미정)”을(를) 글자로 둠'] });
  assert.equal(colName(0), 'A'); assert.equal(colName(25), 'Z'); assert.equal(colName(26), 'AA'); assert.equal(colName(49), 'AX');
  assert.equal(xmlEscape(`a<b>&"'`), 'a&lt;b&gt;&amp;&quot;&apos;');
});

test('specs out of bounds are refused with a reason', () => {
  const one = (sheet) => () => buildXlsx({ sheets: [{ name: '표', columns: [{ header: '이름' }, { header: '금액', type: 'money' }], rows: [], ...sheet }] });
  assert.throws(() => buildXlsx({}), /sheets/);
  assert.throws(one({ name: 'a'.repeat(32) }), /1~31자/);
  for (const bad of ['예산[1]', 'a:b', 'a/b', 'a\\b', 'a?b', 'a*b']) assert.throws(one({ name: bad }), /1~31자/, bad);
  assert.throws(() => buildXlsx({ sheets: [{ name: 'a', columns: [{ header: 'x' }] }, { name: 'A', columns: [{ header: 'x' }] }] }), /중복/);
  assert.throws(() => buildXlsx({ sheets: Array.from({ length: 11 }, (_, i) => ({ name: `s${i}`, columns: [{ header: 'x' }] })) }), /10개까지/);
  assert.throws(one({ columns: Array.from({ length: 51 }, (_, i) => ({ header: `c${i}` })) }), /50개까지/);
  assert.throws(one({ rows: Array.from({ length: 20_001 }, () => ['a', 1]) }), /20000개까지/);
  assert.throws(one({ columns: [{ header: '이름', type: 'formula' }] }), /형식은/);
  assert.throws(one({ totals: { sum: ['이름'] } }), /number 나 money/);
  assert.throws(one({ totals: { sum: ['없는 열'] } }), /열 제목에 없음/);
  assert.throws(one({ rows: [['a', 1, 'extra']] }), /열보다 많음/);
  assert.throws(one({ rows: [[{ nested: 1 }, 1]] }), /글자나 숫자/);
  assert.equal(buildXlsx({ sheets: [{ name: '표', columns: [{ header: '이름' }], rows: Array.from({ length: 20_000 }, (_, i) => [`r${i}`]) }] }).summary[0].rows, 20_000, 'the limit itself is fine');
});

test('a CSV becomes one sheet; numeric columns are numbers', () => {
  const spec = specFromCsv('\uFEFF품목,금액,메모\r\n사과,"1,200","빨강, 큼"\n배,800,"줄\n바꿈 ""인용"""\n', '가격표');
  assert.deepEqual(spec.sheets[0].columns, [{ header: '품목', type: 'text' }, { header: '금액', type: 'number' }, { header: '메모', type: 'text' }]);
  assert.deepEqual(spec.sheets[0].rows, [['사과', '1,200', '빨강, 큼'], ['배', '800', '줄\n바꿈 "인용"']]);
  assert.equal(spec.sheets[0].name, '가격표');
  assert.equal(buildXlsx(spec).summary[0].rows, 2);
});

test('the read-back comparison catches a different sheet count, header, row count or total', () => {
  const { summary } = buildXlsx(SPEC);
  assert.deepEqual(compareReadback(summary, SPEC_MD), { match: true, problems: [], sheets: 2 });
  assert.match(compareReadback(summary, SPEC_MD.replace('| 합계 |  | 3650000 |', '| 합계 |  | 3650001 |')).problems[0], /합계 “금액” 3650000/);
  assert.match(compareReadback(summary, SPEC_MD.replace('| 예비비 |  | (미정) |  |  |\n', '')).problems[0], /행 3 → 다시 읽은 것 2/);
  assert.match(compareReadback(summary, SPEC_MD.replace('| 구분 | 건수 |', '| 구분 | 수 |')).problems[0], /열 제목이 다름/);
  assert.match(compareReadback(summary, SPEC_MD.split('## 요약')[0]).problems[0], /시트 수 2 → 다시 읽은 것 1/);
});

// A stand-in for DocConverter.convert (kordoc in the sandbox): writes what kordoc writes for SPEC.
const fakeConverter = (md = SPEC_MD) => ({ available: true, calls: [], async convert(cwd, rel) { this.calls.push(rel); writeFileSync(path.join(cwd, `${rel}.md`), md); return { ok: true, path: `${rel}.md` }; } });

test('the engine makes the file only where it may, never over a file it did not make, and records the read-back', async () => {
  const cwd = ws();
  writeFileSync(path.join(cwd, '집계.json'), JSON.stringify(SPEC));
  const conv = fakeConverter();
  for (const [args, re] of [[{ from: '../x.json' }, /작업 폴더 안/], [{ from: 'attachments/a.json' }, /attachments/], [{ from: '.hidden/a.json' }, /작업 폴더 안/],
    [{ from: '집계.md' }, /\.json 또는 \.csv/], [{ from: '집계.json', to: 'sources/a.xlsx' }, /\.xlsx 파일/], [{ from: '집계.json', to: '집계.xls' }, /\.xlsx 파일/],
    [{ from: '없음.json' }, /원본 없음.json 없음/]]) assert.match((await makeSpreadsheet(cwd, args, new Set(), conv)).error, re, JSON.stringify(args));
  writeFileSync(path.join(cwd, '남의것.xlsx'), 'not ours');
  assert.match((await makeSpreadsheet(cwd, { from: '집계.json', to: '남의것.xlsx' }, new Set(), conv)).error, /이미 있음/);
  writeFileSync(path.join(cwd, '비밀.json'), JSON.stringify({ sheets: [{ name: 'a', columns: [{ header: 'k' }], rows: [['ghp_' + 'a'.repeat(36)]] }] }));
  assert.match((await makeSpreadsheet(cwd, { from: '비밀.json' }, new Set(), conv)).error, /비밀정보/);
  writeFileSync(path.join(cwd, '깨진.json'), '{"sheets": [');
  assert.match((await makeSpreadsheet(cwd, { from: '깨진.json' }, new Set(), conv)).error, /표를 만들지 못함/);

  const r = await makeSpreadsheet(cwd, { from: '집계.json' }, new Set(), conv);
  assert.equal(r.ok, true);
  assert.deepEqual([r.path, r.rows, r.sheets.length, r.readback.match, r.readback.path, r.previews], ['집계.xlsx', 4, 2, true, '집계.xlsx.md', ['집계.xlsx.html']]);
  assert.deepEqual(conv.calls, ['집계.xlsx']);
  assert.ok(unzip(readFileSync(path.join(cwd, '집계.xlsx'))).has('xl/workbook.xml'));
  const html = readFileSync(path.join(cwd, '집계.xlsx.html'), 'utf8');
  assert.ok(html.includes('재료비 &lt;A&amp;B&gt;') && html.includes('3,650,000') && html.includes('15.3%') && !html.includes('<script'));
  assert.equal((await makeSpreadsheet(cwd, { from: '집계.json' }, new Set(['집계.xlsx']), conv)).ok, true, 'a file the engine made may be made again');
  // without kordoc the file is still made, with no read-back
  const none = await makeSpreadsheet(cwd, { from: '집계.json', to: '다른.xlsx' }, new Set(), null);
  assert.deepEqual([none.ok, none.readback], [true, null]);
});

test('spreadsheet_made proves an engine-made, unchanged file whose read-back matched (and holds the text)', async () => {
  const cwd = ws();
  writeFileSync(path.join(cwd, '집계.json'), JSON.stringify(SPEC));
  const made = await makeSpreadsheet(cwd, { from: '집계.json' }, new Set(), fakeConverter());
  const ctx = { spreadsheets: { [made.path]: made } };
  const criteria = ['예산 집계표 집계.xlsx 를 엔진이 만들었다'];
  const check = (c, ctxOver = ctx) => verifyReport({ criteria: [{ index: 1, done: true, check: c }] }, criteria, cwd, ctxOver).claims[0];
  const pass = check({ type: 'spreadsheet_made', path: '집계.xlsx', text: '1,250,000' });
  assert.equal(pass.check, 'pass', pass.detail);
  assert.match(pass.detail, /집계\.xlsx \(집계\.json에서 엔진이 만듦\) · 시트 2개·행 4개 · 다시 읽은 표가 시트·행·열 제목·합계와 같음 \(합계 금액 3,650,000\) · 표에 “1,250,000” 있음/);
  assert.equal(check({ type: 'spreadsheet_made', path: '집계.xlsx', text: '재료비 <A&B>' }).check, 'pass', 'escaped Markdown characters are read as written');
  assert.match(check({ type: 'spreadsheet_made', path: '집계.xlsx', text: '없는 항목' }).detail, /없음/);
  assert.match(check({ type: 'spreadsheet_made', path: '집계.xlsx' }, { spreadsheets: {} }).detail, /엔진이 만든 엑셀이 아님/);
  assert.match(check({ type: 'spreadsheet_made', path: '집계.xlsx' }, { spreadsheets: { '집계.xlsx': { ...made, readback: null } } }).detail, /다시 읽지 못함 \(kordoc 없음\)/);
  assert.match(check({ type: 'spreadsheet_made', path: '집계.xlsx' }, { spreadsheets: { '집계.xlsx': { ...made, readback: { ...made.readback, match: false, problems: ['월별 예산: 행 3 → 다시 읽은 것 2'] } } } }).detail, /만든 것과 다름 · 월별 예산: 행 3/);
  // the verifier guessed "not done" but only the engine can know: its own record decides
  assert.equal(verifyReport({ criteria: [{ index: 1, done: false, check: { type: 'spreadsheet_made', path: '집계.xlsx' } }] }, criteria, cwd, ctx).evidence.length, 1);
  // in verification with no check at all, the engine runs its own for "the engine made the Excel file"
  assert.equal(verifyReport({ criteria: [] }, ['엑셀 파일을 엔진이 만들었다'], cwd, { ...ctx, verifying: true }).claims[0].check, 'pass');
  writeFileSync(path.join(cwd, '집계.xlsx'), 'edited by hand');
  assert.match(check({ type: 'spreadsheet_made', path: '집계.xlsx' }).detail, /엔진이 만든 뒤 바뀜/);
});

// The real reader: kordoc (when installed in tools/kordoc) opens the engine's file and finds the same table.
const KORDOC = path.resolve('tools/kordoc/node_modules/kordoc/dist/cli.js');
test('kordoc reads the engine\'s xlsx back as the same sheets, headers, rows and totals', { skip: !existsSync(KORDOC) && 'kordoc not installed' }, () => {
  const cwd = ws();
  mkdirSync(path.join(cwd, 'out'));
  const { buffer, summary } = buildXlsx(SPEC);
  writeFileSync(path.join(cwd, 'out', '집계.xlsx'), buffer);
  execFileSync(process.execPath, [KORDOC, 'out/집계.xlsx', '-o', 'out/집계.xlsx.md', '--no-images', '--silent'], { cwd, timeout: 60_000 });
  const md = readFileSync(path.join(cwd, 'out', '집계.xlsx.md'), 'utf8');
  assert.deepEqual(compareReadback(summary, md), { match: true, problems: [], sheets: 2 });
  assert.match(md, /재료비 \\?<A&B>/);
});
