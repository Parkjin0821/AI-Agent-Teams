import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { hasSecret } from './보안감시.js';

// 엑셀 만들기 (2026-10-02, method A): a work team writes the table as a JSON spec (or a CSV) and the engine itself writes
// the .xlsx with Node built-ins only — an xlsx is a ZIP of XML parts, so the ZIP container (local headers, central
// directory, CRC-32) is written here with zlib's raw deflate. No package, no model call. The engine then reads the file
// back with kordoc (the same sandboxed tool that reads attachments) and compares sheets, rows, headers and totals, so
// spreadsheet_made proves a file that opens and holds what the spec said. Phase 2 (2026-10-02): a sheet may ask for
// native Excel charts (column, bar, line, pie) drawn from its own columns; they are DrawingML parts that point at the
// sheet's cells, so the chart follows the numbers when someone edits them in Excel.
export const XLSX_LIMITS = Object.freeze({ sheets: 10, rows: 20_000, columns: 50, cellChars: 32_767, sourceBytes: 5_000_000,
  chartsPerSheet: 3, chartSeries: 6, chartRows: 1_000 });
export const COLUMN_TYPES = ['text', 'number', 'date', 'money', 'percent'];
export const CHART_TYPES = ['column', 'bar', 'line', 'pie'];
export const CHART_NAMES = { column: '세로 막대', bar: '가로 막대', line: '꺾은선', pie: '원형' };

// ── ZIP ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// entries: [{ name, data: Buffer }] → one ZIP file (deflate, UTF-8 names, fixed 1980-01-01 time so the same table gives
// the same bytes).
export function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8'), body = deflateRawSync(data), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42); // extra, comment, disk, attributes: 0
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// The reverse, by the central directory, checking every CRC: Map name → Buffer. Throws on a damaged file.
export function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10), out = new Map();
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32), at = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (buf.readUInt32LE(at) !== 0x04034b50) throw new Error(`bad local header: ${name}`);
    const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    const raw = buf.subarray(start, start + size);
    const data = method === 8 ? inflateRawSync(raw) : method === 0 ? Buffer.from(raw) : null;
    if (!data) throw new Error(`unsupported compression: ${name}`);
    if (crc32(data) !== crc) throw new Error(`CRC mismatch: ${name}`);
    out.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ── XML ──
// Characters XML 1.0 cannot hold at all are dropped; the five special ones are escaped.
export const xmlEscape = v => String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
export const colName = i => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

// ── values ──
const number = v => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/,/g, '').replace(/\s*(원|₩|KRW)$/i, '').replace(/^₩\s*/, '');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
};
const percent = v => {
  if (typeof v === 'string' && /%\s*$/.test(v)) { const n = number(v.replace(/%\s*$/, '')); return n === null ? null : n / 100; }
  return number(v);
};
// "2026-10-02", "2026.10.2", "2026. 10. 2." → Excel's day number (days since 1899-12-30).
const dateSerial = v => {
  const m = typeof v === 'string' ? /^\s*(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})\s*\.?\s*$/.exec(v) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return Math.round((t - Date.UTC(1899, 11, 30)) / 86_400_000);
};
const PARSE = { number, money: number, percent, date: dateSerial };

// Styles (cellXfs index): 0 plain, 1 header (bold, grey fill), 2 #,##0, 3 #,##0.00, 4 0.0%, 5 yyyy-mm-dd,
// 6 yyyy. m. d. (Korean), 7 bold label, 8 bold #,##0, 9 bold #,##0.00, 10 bold 0.0%, 11 wrapped text.
const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<numFmts count="3"><numFmt numFmtId="164" formatCode="0.0%"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/>'
  + '<numFmt numFmtId="166" formatCode="yyyy&quot;. &quot;m&quot;. &quot;d&quot;.&quot;"/></numFmts>'
  + '<fonts count="2"><font><sz val="11"/><name val="맑은 고딕"/><family val="2"/></font><font><b/><sz val="11"/><name val="맑은 고딕"/><family val="2"/></font></fonts>'
  + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFE7E6E6"/><bgColor indexed="64"/></patternFill></fill></fills>'
  + '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>'
  + '<border><left/><right/><top/><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="12"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>'
  + '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  + '<xf numFmtId="3" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>'
  + '<xf numFmtId="4" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>'
  + '<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>'
  + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

const BAD_SHEET_NAME = /[[\]:*?/\\]/;
const textWidth = s => [...String(s)].reduce((n, ch) => n + (/[ᄀ-ￜ]/.test(ch) ? 2 : 1), 0);

// spec → the checked, normalised table (throws a Korean-readable reason on anything out of bounds).
export function normalizeSpec(spec) {
  const sheets = spec?.sheets;
  if (!Array.isArray(sheets) || !sheets.length) throw new Error('sheets 가 비어 있음');
  if (sheets.length > XLSX_LIMITS.sheets) throw new Error(`시트는 ${XLSX_LIMITS.sheets}개까지`);
  const names = new Set();
  return sheets.map((sheet, si) => {
    const name = String(sheet?.name ?? `시트${si + 1}`).trim();
    if (!name || name.length > 31 || BAD_SHEET_NAME.test(name) || /^'|'$/.test(name)) throw new Error(`시트 이름 “${name.slice(0, 40)}”: 1~31자, [ ] : * ? / \\ 없이`);
    if (names.has(name.toLowerCase()) || name.toLowerCase() === 'history') throw new Error(`시트 이름 “${name}” 중복 또는 예약어`);
    names.add(name.toLowerCase());
    const columns = sheet.columns;
    if (!Array.isArray(columns) || !columns.length) throw new Error(`${name}: columns 가 비어 있음`);
    if (columns.length > XLSX_LIMITS.columns) throw new Error(`${name}: 열은 ${XLSX_LIMITS.columns}개까지`);
    const cols = columns.map((c, ci) => {
      const header = String(c?.header ?? '').trim();
      if (!header) throw new Error(`${name}: ${ci + 1}번째 열 제목이 없음`);
      const type = c?.type ?? 'text';
      if (!COLUMN_TYPES.includes(type)) throw new Error(`${name}: 열 “${header}” 형식은 ${COLUMN_TYPES.join('·')} 중 하나`);
      const width = c?.width === undefined ? null : Number(c.width);
      if (width !== null && !(width >= 1 && width <= 100)) throw new Error(`${name}: 열 “${header}” 너비는 1~100`);
      let formula = null;
      if (c?.formula !== undefined) {
        if (!['number', 'money', 'percent'].includes(type)) throw new Error(`${name}: 계산 열 “${header}”은(는) number·money·percent 여야 함`);
        formula = parseFormula(c.formula, columns.slice(0, ci).map(x => String(x?.header ?? '').trim()), `${name}: 계산 열 “${header}”`);
      }
      return { header, type, width, korean: type === 'date' && c?.format === 'korean', formula };
    });
    if (new Set(cols.map(c => c.header)).size !== cols.length) throw new Error(`${name}: 열 제목이 겹침`);
    const rows = sheet.rows ?? [];
    if (!Array.isArray(rows)) throw new Error(`${name}: rows 는 목록이어야 함`);
    if (rows.length > XLSX_LIMITS.rows) throw new Error(`${name}: 행은 ${XLSX_LIMITS.rows}개까지`);
    const warnings = [];
    const cells = rows.map((row, ri) => {
      // a row may be a list in column order or an object keyed by header
      const list = Array.isArray(row) ? row : row && typeof row === 'object' ? cols.map(c => row[c.header]) : null;
      if (!list) throw new Error(`${name}: ${ri + 1}번째 행이 목록·객체가 아님`);
      if (list.length > cols.length) throw new Error(`${name}: ${ri + 1}번째 행의 칸이 열보다 많음`);
      const out = cols.map((c, ci) => {
        if (c.formula) return null; // filled below, from the cells to its left
        const v = list[ci];
        if (v === null || v === undefined || v === '') return null;
        if (typeof v === 'object') throw new Error(`${name}: ${ri + 1}행 “${c.header}” 칸은 글자나 숫자여야 함`);
        if (c.type === 'text') return { s: String(v) };
        const n = PARSE[c.type](v);
        if (n === null) { if (warnings.length < 5) warnings.push(`${ri + 1}행 “${c.header}” 값 “${String(v).slice(0, 20)}”을(를) 글자로 둠`); return { s: String(v) }; }
        return { n };
      });
      // a computed column holds the formula; its cached value is left out when a cell it reads is not a number or it
      // divides by zero (Excel then shows its own result, e.g. #DIV/0!)
      cols.forEach((c, ci) => {
        if (!c.formula) return;
        const n = evalFormula(c.formula.ast, out);
        out[ci] = Number.isFinite(n) ? { f: true, n: round(n) } : { f: true };
      });
      return out;
    });
    for (const row of cells) for (const cell of row) if (cell?.s !== undefined && cell.s.length > XLSX_LIMITS.cellChars) throw new Error(`${name}: 칸 하나는 ${XLSX_LIMITS.cellChars}자까지`);
    let totals = null;
    if (sheet.totals) {
      const sum = Array.isArray(sheet.totals.sum) ? sheet.totals.sum.map(String) : [];
      if (!sum.length) throw new Error(`${name}: totals.sum 에 합할 열 제목이 없음`);
      const idx = sum.map(h => {
        const i = cols.findIndex(c => c.header === h);
        if (i < 0) throw new Error(`${name}: 합계 열 “${h}”이(가) 열 제목에 없음`);
        if (!['number', 'money'].includes(cols[i].type)) throw new Error(`${name}: 합계 열 “${h}”은(는) number 나 money 여야 함`);
        return i;
      });
      const labelAt = cols.findIndex((c, i) => !idx.includes(i));
      totals = { label: String(sheet.totals.label ?? '합계').slice(0, 40), labelAt, columns: idx,
        values: Object.fromEntries(idx.map(i => [cols[i].header, round(cells.reduce((s, r) => s + (r[i]?.n ?? 0), 0))])) };
    }
    const charts = normalizeCharts(sheet.charts, name, cols, cells);
    return { name, cols, cells, totals, warnings, charts };
  });
}
const round = n => Math.round(n * 1e9) / 1e9;

// 계산 열 (2026-10-02, 엑셀 차트 시험: "이익은 매출-비용 수식" could only be a typed number): "{매출(원)}-{비용(원)}"
// — column headers to its left in braces, numbers, + - * / and brackets, nothing else, so a team can never write a
// function, another sheet or a link. Parsed once; each row gets the same formula on its own cells.
export function parseFormula(text, left, label) {
  const src = String(text ?? '').trim();
  if (!src || src.length > 200) throw new Error(`${label}: formula 는 1~200자`);
  const tokens = [];
  for (let i = 0; i < src.length;) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '{') {
      const end = src.indexOf('}', i);
      if (end < 0) throw new Error(`${label}: { 가 닫히지 않음`);
      const header = src.slice(i + 1, end).trim(), col = left.indexOf(header);
      if (col < 0) throw new Error(`${label}: {${header.slice(0, 30)}}은(는) 이 열보다 왼쪽의 열 제목이 아님`);
      tokens.push({ ref: col }); i = end + 1; continue;
    }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (num) { tokens.push({ num: Number(num[0]) }); i += num[0].length; continue; }
    if ('+-*/()'.includes(ch)) { tokens.push({ op: ch }); i++; continue; }
    throw new Error(`${label}: “${ch}”은(는) 쓸 수 없음 ({열 제목}, 숫자, + - * / 괄호만)`);
  }
  let p = 0;
  const peek = () => tokens[p], take = () => tokens[p++];
  const expr = () => { let a = term(); while (peek()?.op === '+' || peek()?.op === '-') a = { op: take().op, a, b: term() }; return a; };
  const term = () => { let a = factor(); while (peek()?.op === '*' || peek()?.op === '/') a = { op: take().op, a, b: factor() }; return a; };
  const factor = () => {
    const t = take();
    if (!t) throw new Error(`${label}: 식이 덜 끝남`);
    if (t.ref !== undefined || t.num !== undefined) return t;
    if (t.op === '-') return { op: 'neg', a: factor() };
    if (t.op === '(') { const a = expr(); if (take()?.op !== ')') throw new Error(`${label}: 괄호가 맞지 않음`); return { op: '()', a }; }
    throw new Error(`${label}: “${t.op}” 자리가 잘못됨`);
  };
  const ast = expr();
  if (p !== tokens.length) throw new Error(`${label}: 식 끝에 남은 글자가 있음`);
  if (!tokens.some(t => t.ref !== undefined)) throw new Error(`${label}: 다른 열을 하나 이상 써야 함`);
  return { text: src, ast };
}
export function evalFormula(node, row) {
  if (node.ref !== undefined) return row[node.ref]?.n ?? NaN;
  if (node.num !== undefined) return node.num;
  const a = evalFormula(node.a, row);
  if (node.op === 'neg') return -a;
  if (node.op === '()') return a;
  const b = evalFormula(node.b, row);
  return node.op === '+' ? a + b : node.op === '-' ? a - b : node.op === '*' ? a * b : b === 0 ? NaN : a / b;
}
// The same formula as Excel writes it for one row: {매출(원)} in row 3 → B3.
export function excelFormula(node, r) {
  if (node.ref !== undefined) return `${colName(node.ref)}${r}`;
  if (node.num !== undefined) return String(node.num);
  if (node.op === 'neg') return `-${excelFormula(node.a, r)}`;
  if (node.op === '()') return `(${excelFormula(node.a, r)})`;
  return `${excelFormula(node.a, r)}${node.op}${excelFormula(node.b, r)}`;
}

// charts: [{ type: column|bar|line|pie, title, category: "항목", values: ["예산", "실적"] }] — the category is any
// column, the values are number, money or percent columns; the chart covers the data rows (not the totals row).
function normalizeCharts(charts, name, cols, cells) {
  if (charts === undefined || charts === null) return [];
  if (!Array.isArray(charts)) throw new Error(`${name}: charts 는 목록이어야 함`);
  if (charts.length > XLSX_LIMITS.chartsPerSheet) throw new Error(`${name}: 차트는 시트마다 ${XLSX_LIMITS.chartsPerSheet}개까지`);
  return charts.map((ch, k) => {
    const label = `${name}: ${k + 1}번째 차트`;
    const type = ch?.type ?? 'column';
    if (!CHART_TYPES.includes(type)) throw new Error(`${label} 형식은 ${CHART_TYPES.join('·')} 중 하나`);
    const category = cols.findIndex(c => c.header === String(ch?.category ?? ''));
    if (category < 0) throw new Error(`${label}의 category “${String(ch?.category ?? '').slice(0, 30)}”이(가) 열 제목에 없음`);
    const headers = Array.isArray(ch?.values) ? ch.values.map(String) : [];
    if (!headers.length) throw new Error(`${label}의 values 에 값 열 제목이 없음`);
    if (headers.length > XLSX_LIMITS.chartSeries) throw new Error(`${label}의 값 열은 ${XLSX_LIMITS.chartSeries}개까지`);
    if (type === 'pie' && headers.length !== 1) throw new Error(`${label}: 원형 차트는 값 열 하나만`);
    const values = headers.map(h => {
      const i = cols.findIndex(c => c.header === h);
      if (i < 0) throw new Error(`${label}의 값 열 “${h.slice(0, 30)}”이(가) 열 제목에 없음`);
      if (!['number', 'money', 'percent'].includes(cols[i].type)) throw new Error(`${label}의 값 열 “${h}”은(는) number·money·percent 여야 함`);
      if (i === category) throw new Error(`${label}: category 열을 값으로 쓸 수 없음`);
      return i;
    });
    if (new Set(values).size !== values.length) throw new Error(`${label}: 값 열이 겹침`);
    if (!cells.length) throw new Error(`${label}: 그릴 행이 없음`);
    if (cells.length > XLSX_LIMITS.chartRows) throw new Error(`${label}: 차트는 ${XLSX_LIMITS.chartRows}행까지`);
    if (!values.some(i => cells.some(r => r[i]?.n !== undefined))) throw new Error(`${label}: 값 열에 숫자가 없음`);
    const title = String(ch?.title ?? '').trim().slice(0, 80) || headers.join('·');
    return { type, title, category, values };
  });
}

// ── charts (DrawingML) ──
const PALETTE = ['4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47'];
const FONT = '<a:latin typeface="맑은 고딕"/><a:ea typeface="맑은 고딕"/>';
const quoteSheet = name => `'${name.replace(/'/g, "''")}'`;
const range = (sheet, i, first, last = first) => `${quoteSheet(sheet.name)}!$${colName(i)}$${first}${last === first ? '' : `:$${colName(i)}$${last}`}`;
const formatCode = c => c.type === 'percent' ? '0.0%' : c.type === 'date' ? (c.korean ? 'yyyy. m. d.' : 'yyyy-mm-dd') : '#,##0';
const rich = (text, size, bold) => `<c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size}" b="${bold ? 1 : 0}">${FONT}</a:defRPr></a:pPr>`
  + `<a:r><a:rPr lang="ko-KR" sz="${size}" b="${bold ? 1 : 0}">${FONT}</a:rPr><a:t>${xmlEscape(text)}</a:t></a:r></a:p></c:rich>`;

// One chart part. The cached values are the sheet's own, so a reader that does not recalculate still draws it.
export function chartXml(sheet, chart) {
  const last = sheet.cells.length + 1, cat = sheet.cols[chart.category];
  const numericCat = cat.type !== 'text' && sheet.cells.every(r => !r[chart.category] || r[chart.category].n !== undefined);
  const catPts = sheet.cells.map((r, k) => { const v = r[chart.category]; return v ? `<c:pt idx="${k}"><c:v>${numericCat ? v.n : xmlEscape(v.s ?? String(v.n))}</c:v></c:pt>` : ''; }).join('');
  const catRef = numericCat
    ? `<c:numRef><c:f>${xmlEscape(range(sheet, chart.category, 2, last))}</c:f><c:numCache><c:formatCode>${xmlEscape(formatCode(cat))}</c:formatCode><c:ptCount val="${sheet.cells.length}"/>${catPts}</c:numCache></c:numRef>`
    : `<c:strRef><c:f>${xmlEscape(range(sheet, chart.category, 2, last))}</c:f><c:strCache><c:ptCount val="${sheet.cells.length}"/>${catPts}</c:strCache></c:strRef>`;
  const series = chart.values.map((i, k) => {
    const c = sheet.cols[i], color = PALETTE[k % PALETTE.length];
    const pts = sheet.cells.map((r, j) => r[i]?.n !== undefined ? `<c:pt idx="${j}"><c:v>${r[i].n}</c:v></c:pt>` : '').join('');
    const tx = `<c:tx><c:strRef><c:f>${xmlEscape(range(sheet, i, 1))}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${xmlEscape(c.header)}</c:v></c:pt></c:strCache></c:strRef></c:tx>`;
    const look = chart.type === 'line'
      ? `<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:round/></a:ln></c:spPr>`
        + `<c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></c:spPr></c:marker>`
      : chart.type === 'pie' ? ''
        : `<c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/>`;
    const labels = chart.type === 'pie' ? '<c:dLbls><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/>'
      + '<c:showPercent val="1"/><c:showBubbleSize val="0"/><c:showLeaderLines val="1"/></c:dLbls>' : '';
    return `<c:ser><c:idx val="${k}"/><c:order val="${k}"/>${tx}${look}${labels}<c:cat>${catRef}</c:cat>`
      + `<c:val><c:numRef><c:f>${xmlEscape(range(sheet, i, 2, last))}</c:f><c:numCache><c:formatCode>${xmlEscape(formatCode(c))}</c:formatCode>`
      + `<c:ptCount val="${sheet.cells.length}"/>${pts}</c:numCache></c:numRef></c:val>${chart.type === 'line' ? '<c:smooth val="0"/>' : ''}</c:ser>`;
  }).join('');
  const axes = '<c:axId val="500000001"/><c:axId val="500000002"/>';
  const horizontal = chart.type === 'bar';
  const plot = chart.type === 'pie' ? `<c:pieChart><c:varyColors val="1"/>${series}<c:firstSliceAng val="0"/></c:pieChart>`
    : chart.type === 'line' ? `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}<c:marker val="1"/>${axes}</c:lineChart>`
      : `<c:barChart><c:barDir val="${horizontal ? 'bar' : 'col'}"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series}<c:gapWidth val="80"/>${axes}</c:barChart>`;
  const line = '<c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="BFBFBF"/></a:solidFill></a:ln></c:spPr>';
  const axisXml = chart.type === 'pie' ? '' : '<c:catAx><c:axId val="500000001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/>'
    + `<c:axPos val="${horizontal ? 'l' : 'b'}"/><c:numFmt formatCode="${xmlEscape(numericCat ? formatCode(cat) : 'General')}" sourceLinked="1"/>`
    + `<c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>${line}<c:crossAx val="500000002"/><c:crosses val="autoZero"/>`
    + '<c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>'
    + `<c:valAx><c:axId val="500000002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? 'b' : 'l'}"/>`
    + '<c:majorGridlines><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="E5E5E5"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>'
    + `<c:numFmt formatCode="${xmlEscape(formatCode(sheet.cols[chart.values[0]]))}" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/>`
    + `<c:tickLblPos val="nextTo"/>${line}<c:crossAx val="500000001"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`;
  // one series of bars or a line needs no legend; a pie's legend names the slices
  const legend = chart.type === 'pie' || chart.values.length > 1 ? '<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>' : '';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
    + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:lang val="ko-KR"/><c:roundedCorners val="0"/>'
    + `<c:chart><c:title><c:tx>${rich(chart.title, 1200, true)}</c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`
    + `<c:plotArea><c:layout/>${plot}${axisXml}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>`
    + '<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr>'
    + `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900">${FONT}</a:defRPr></a:pPr><a:endParaRPr lang="ko-KR"/></a:p></c:txPr></c:chartSpace>`;
}

// Where a sheet's charts sit: to the right of a narrow table, below a wide one; 8 columns × 16 rows each.
export function chartAnchors(sheet) {
  const below = sheet.cols.length > 8;
  const top = below ? sheet.cells.length + (sheet.totals ? 1 : 0) + 2 : 1;
  return sheet.charts.map((_, k) => {
    const col = below ? 0 : sheet.cols.length + 1, row = top + k * 18;
    return { col, row, toCol: col + 8, toRow: row + 16 };
  });
}

function drawingXml(sheet, firstId) {
  const anchors = chartAnchors(sheet).map((a, k) => '<xdr:twoCellAnchor editAs="oneCell">'
    + `<xdr:from><xdr:col>${a.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`
    + `<xdr:to><xdr:col>${a.toCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.toRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>`
    + `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${k + 2}" name="차트 ${firstId + k}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>`
    + '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">'
    + `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId${k + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame>`
    + '<xdr:clientData/></xdr:twoCellAnchor>').join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
    + ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors}</xdr:wsDr>`;
}

// Node ships no XML parser: a well-formedness check for the parts the engine wrote (every tag well made and closed in
// order, one root, no stray < or > in text). The engine runs it on its own file before anything trusts it.
export function xmlWellFormed(xml) {
  const body = String(xml).replace(/^<\?xml[^?]*\?>\s*/, '');
  const stack = [];
  let roots = 0, at = 0;
  for (const m of body.matchAll(/<[^<>]*>/g)) {
    if (/[<>]/.test(body.slice(at, m.index))) return false;
    at = m.index + m[0].length;
    const tag = /^<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*="[^"<]*")*)\s*(\/?)>$/.exec(m[0]);
    if (!tag) return false;
    const [, close, name, , self] = tag;
    if (close) { if (self || stack.pop() !== name) return false; continue; }
    if (!stack.length) roots++;
    if (!self) stack.push(name);
  }
  return stack.length === 0 && roots === 1 && !/[<>]/.test(body.slice(at));
}

// The numeric style of a column: whole numbers #,##0, otherwise #,##0.00.
const decimals = (sheet, i) => sheet.cells.some(r => r[i]?.n !== undefined && !Number.isInteger(r[i].n));
const styleOf = (sheet, i, bold = false) => {
  const c = sheet.cols[i];
  if (c.type === 'percent') return bold ? 10 : 4;
  if (c.type === 'date') return c.korean ? 6 : 5;
  if (c.type === 'number' || c.type === 'money') return decimals(sheet, i) ? (bold ? 9 : 3) : (bold ? 8 : 2);
  return 0;
};

// spec → { buffer, summary } — summary is what the read-back is compared with.
export function buildXlsx(spec) {
  const sheets = normalizeSpec(spec);
  const strings = [], index = new Map();
  const sst = s => { if (!index.has(s)) { index.set(s, strings.length); strings.push(s); } return index.get(s); };
  const parts = [], drawings = [];
  let chartCount = 0;
  sheets.forEach((sheet, si) => {
    const xml = [];
    const cell = (ref, v, style) => v.n !== undefined ? `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${v.n}</v></c>`
      : `<c r="${ref}" t="s"${style ? ` s="${style}"` : ''}><v>${sst(v.s)}</v></c>`;
    xml.push(`<row r="1">${sheet.cols.map((c, i) => cell(`${colName(i)}1`, { s: c.header }, 1)).join('')}</row>`);
    sheet.cells.forEach((row, ri) => {
      const r = ri + 2;
      const inner = row.map((v, i) => !v ? ''
        : v.f ? `<c r="${colName(i)}${r}" s="${styleOf(sheet, i)}"><f>${xmlEscape(excelFormula(sheet.cols[i].formula.ast, r))}</f>${v.n !== undefined ? `<v>${v.n}</v>` : ''}</c>`
          : cell(`${colName(i)}${r}`, v, v.n !== undefined ? styleOf(sheet, i) : (v.s.includes('\n') ? 11 : 0))).join('');
      xml.push(`<row r="${r}">${inner}</row>`);
    });
    if (sheet.totals) {
      const r = sheet.cells.length + 2, last = sheet.cells.length + 1;
      const t = sheet.totals;
      const inner = sheet.cols.map((c, i) => {
        if (t.columns.includes(i)) {
          const col = colName(i);
          return `<c r="${col}${r}" s="${styleOf(sheet, i, true)}"><f>SUM(${col}2:${col}${Math.max(2, last)})</f><v>${t.values[c.header]}</v></c>`;
        }
        return i === t.labelAt ? cell(`${colName(i)}${r}`, { s: t.label }, 7) : '';
      }).join('');
      xml.push(`<row r="${r}">${inner}</row>`);
    }
    const widths = sheet.cols.map((c, i) => c.width ?? Math.min(60, Math.max(8, 2 + Math.max(textWidth(c.header),
      ...sheet.cells.slice(0, 500).map(r => r[i] ? (r[i].s !== undefined ? Math.min(textWidth(r[i].s.split('\n')[0]), 58) : String(r[i].n).length + 4) : 0)))));
    const lastRef = `${colName(sheet.cols.length - 1)}${sheet.cells.length + 1 + (sheet.totals ? 1 : 0)}`;
    parts.push({ name: `xl/worksheets/sheet${si + 1}.xml`, data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + `<dimension ref="A1:${lastRef}"/>`
      + `<sheetViews><sheetView workbookViewId="0"${si === 0 ? ' tabSelected="1"' : ''}><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>`
      + '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>'
      + '<sheetFormatPr defaultRowHeight="16.5"/>'
      + `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.round(w * 100) / 100}" customWidth="1"/>`).join('')}</cols>`
      + `<sheetData>${xml.join('')}</sheetData>`
      + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
      + `${sheet.charts.length ? '<drawing r:id="rId1"/>' : ''}</worksheet>`, 'utf8') });
    if (!sheet.charts.length) return;
    // sheet → drawing → its charts (numbered across the workbook)
    const first = chartCount + 1;
    chartCount += sheet.charts.length;
    drawings.push(si + 1);
    const rels = targets => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + targets.map(([type, target], k) => `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join('')
      + '</Relationships>';
    parts.push({ name: `xl/worksheets/_rels/sheet${si + 1}.xml.rels`, data: Buffer.from(rels([['drawing', `../drawings/drawing${si + 1}.xml`]]), 'utf8') });
    parts.push({ name: `xl/drawings/drawing${si + 1}.xml`, data: Buffer.from(drawingXml(sheet, first), 'utf8') });
    parts.push({ name: `xl/drawings/_rels/drawing${si + 1}.xml.rels`, data: Buffer.from(rels(sheet.charts.map((_, k) => ['chart', `../charts/chart${first + k}.xml`])), 'utf8') });
    sheet.charts.forEach((chart, k) => parts.push({ name: `xl/charts/chart${first + k}.xml`, data: Buffer.from(chartXml(sheet, chart), 'utf8') }));
  });
  const space = s => /^\s|\s$|\n/.test(s) ? ' xml:space="preserve"' : '';
  const files = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + drawings.map(n => `<Override PartName="/xl/drawings/drawing${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`).join('')
      + Array.from({ length: chartCount }, (_, i) => `<Override PartName="/xl/charts/chart${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`).join('')
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
      + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
      + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
      + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>' },
    { name: 'docProps/core.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"'
      + ' xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>AGENT HQ</dc:creator></cp:coreProperties>' },
    { name: 'docProps/app.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>AGENT HQ</Application></Properties>' },
    { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + `<bookViews><workbookView/></bookViews><sheets>${sheets.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>`
      // the cached totals are right, and Excel recomputes them anyway when it opens the file
      + '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
      + `<Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: STYLES },
    ...parts,
  ];
  // shared strings last, once every sheet has added its texts
  const total = sheets.reduce((n, s) => n + s.cols.length + s.cells.reduce((m, r) => m + r.filter(v => v?.s !== undefined).length, 0) + (s.totals ? 1 : 0), 0);
  files.push({ name: 'xl/sharedStrings.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${total}" uniqueCount="${strings.length}">`
    + strings.map(s => `<si><t${space(s)}>${xmlEscape(s)}</t></si>`).join('') + '</sst>' });
  const buffer = zip(files.map(f => ({ name: f.name, data: Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8') })));
  const summary = sheets.map(s => ({ name: s.name, rows: s.cells.length, columns: s.cols.map(c => c.header),
    ...(s.totals ? { totals: { label: s.totals.label, values: s.totals.values } } : {}), ...(s.warnings.length ? { warnings: s.warnings } : {}),
    ...(s.cols.some(c => c.formula) ? { formulas: Object.fromEntries(s.cols.filter(c => c.formula).map(c => [c.header, c.formula.text])) } : {}),
    ...(s.charts.length ? { charts: s.charts.map(c => ({ type: c.type, title: c.title, category: s.cols[c.category].header, values: c.values.map(i => s.cols[i].header) })) } : {}) }));
  return { buffer, summary, sheets };
}

// A CSV file (RFC 4180: quotes, doubled quotes, line breaks in quotes; a BOM is dropped) → one sheet, text columns
// except where every value is a number.
export function specFromCsv(text, name = '시트1') {
  const rows = [];
  let row = [], field = '', quoted = false;
  const src = String(text).replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"' && !field) quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && src[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header = [], ...body] = rows.filter(r => r.some(v => v.trim()));
  const columns = header.map((h, i) => ({ header: h.trim() || `열${i + 1}`,
    type: body.length && body.every(r => !r[i]?.trim() || number(r[i]) !== null) && body.some(r => r[i]?.trim()) ? 'number' : 'text' }));
  return { sheets: [{ name: String(name).replace(BAD_SHEET_NAME, ' ').slice(0, 31).trim() || '시트1', columns, rows: body.map(r => r.slice(0, columns.length)) }] };
}

// A cell as the sheet shows it (plain text, not escaped).
function cellText(sheet, i, v) {
  if (!v) return '';
  if (v.s !== undefined) return v.s;
  if (v.n === undefined) return '';
  const c = sheet.cols[i];
  if (c.type === 'percent') return `${(v.n * 100).toFixed(1)}%`;
  if (c.type === 'date') { const d = new Date(Date.UTC(1899, 11, 30) + v.n * 86_400_000); const p = n => String(n).padStart(2, '0');
    return c.korean ? `${d.getUTCFullYear()}. ${d.getUTCMonth() + 1}. ${d.getUTCDate()}.` : `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`; }
  return v.n.toLocaleString('ko-KR', { maximumFractionDigits: decimals(sheet, i) ? 2 : 0, minimumFractionDigits: decimals(sheet, i) ? 2 : 0 });
}

// A plain SVG drawing of a chart for the preview frame, so 대장 sees roughly what Excel will draw (first 60 rows).
export function chartSvg(sheet, chart) {
  const W = 560, H = 300, rows = sheet.cells.slice(0, 60), n = rows.length;
  const short = s => { const t = [...String(s)]; return xmlEscape(t.length > 8 ? `${t.slice(0, 7).join('')}…` : t.join('')); };
  const cat = r => cellText(sheet, chart.category, r[chart.category]);
  const head = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${xmlEscape(chart.title)}" style="font:11px system-ui,'Malgun Gothic',sans-serif;background:#fff;border:1px solid #d9d9d9">`
    + `<text x="${W / 2}" y="20" text-anchor="middle" style="font-weight:700;font-size:13px">${xmlEscape(chart.title)}</text>`;
  if (chart.type === 'pie') {
    const i = chart.values[0], vals = rows.map(r => Math.max(0, r[i]?.n ?? 0)), sum = vals.reduce((a, b) => a + b, 0) || 1;
    const cx = 150, cy = 165, R = 110;
    let a = -Math.PI / 2, out = '';
    vals.forEach((v, k) => {
      if (!v) return;
      const color = `#${PALETTE[k % PALETTE.length]}`, b = a + (v / sum) * 2 * Math.PI;
      out += v === sum ? `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${color}"/>`
        : `<path d="M${cx},${cy} L${(cx + R * Math.cos(a)).toFixed(1)},${(cy + R * Math.sin(a)).toFixed(1)} A${R},${R} 0 ${b - a > Math.PI ? 1 : 0} 1 ${(cx + R * Math.cos(b)).toFixed(1)},${(cy + R * Math.sin(b)).toFixed(1)} Z" fill="${color}" stroke="#fff"/>`;
      a = b;
    });
    const legend = rows.slice(0, 12).map((r, k) => `<rect x="300" y="${52 + k * 18}" width="10" height="10" fill="#${PALETTE[k % PALETTE.length]}"/>`
      + `<text x="316" y="${61 + k * 18}">${short(cat(r))} ${((vals[k] / sum) * 100).toFixed(1)}%</text>`).join('');
    return `${head}${out}${legend}</svg>`;
  }
  const all = chart.values.flatMap(i => rows.map(r => r[i]?.n).filter(v => v !== undefined));
  let lo = Math.min(0, ...all), hi = Math.max(0, ...all);
  if (hi === lo) hi = lo + 1;
  // round the axis out to a 1·2·2.5·5 step, as Excel does ("106.5만" ticks read badly)
  const raw = (hi - lo) / 4, mag = 10 ** Math.floor(Math.log10(raw));
  const unit = [1, 2, 2.5, 5, 10].find(m => m * mag >= raw - 1e-12) * mag;
  lo = Math.floor(lo / unit + 1e-9) * unit; hi = Math.ceil(hi / unit - 1e-9) * unit;
  const ticks = Math.round((hi - lo) / unit);
  const horizontal = chart.type === 'bar', L = horizontal ? 80 : 64, T = 34, Rgt = 16, B = chart.values.length > 1 ? 52 : 36;
  const pw = W - L - Rgt, ph = H - T - B;
  const pos = v => (v - lo) / (hi - lo); // 0..1 along the value axis
  const first = sheet.cols[chart.values[0]];
  const tick = v => first.type === 'percent' ? `${Math.round(v * 1000) / 10}%` : Math.abs(v) >= 1e8 ? `${Math.round(v / 1e7) / 10}억` : Math.abs(v) >= 1e4 ? `${Math.round(v / 1e3) / 10}만` : String(Math.round(v * 100) / 100);
  let out = '';
  for (let k = 0; k <= ticks; k++) {
    const v = lo + unit * k, p = pos(v);
    out += horizontal ? `<line x1="${L + p * pw}" y1="${T}" x2="${L + p * pw}" y2="${T + ph}" stroke="#e5e5e5"/><text x="${L + p * pw}" y="${T + ph + 14}" text-anchor="middle">${tick(v)}</text>`
      : `<line x1="${L}" y1="${T + ph - p * ph}" x2="${L + pw}" y2="${T + ph - p * ph}" stroke="#e5e5e5"/><text x="${L - 6}" y="${T + ph - p * ph + 4}" text-anchor="end">${tick(v)}</text>`;
  }
  const slot = (horizontal ? ph : pw) / Math.max(1, n), step = Math.ceil(n / (horizontal ? 14 : 10));
  rows.forEach((r, j) => {
    if (j % step) return;
    const c = slot * (j + 0.5);
    out += horizontal ? `<text x="${L - 6}" y="${T + c + 4}" text-anchor="end">${short(cat(r))}</text>` : `<text x="${L + c}" y="${T + ph + 14}" text-anchor="middle">${short(cat(r))}</text>`;
  });
  const zero = pos(0);
  chart.values.forEach((i, k) => {
    const color = `#${PALETTE[k % PALETTE.length]}`;
    if (chart.type === 'line') {
      const pts = rows.map((r, j) => r[i]?.n === undefined ? null : `${(L + slot * (j + 0.5)).toFixed(1)},${(T + ph - pos(r[i].n) * ph).toFixed(1)}`).filter(Boolean);
      out += `<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="2"/>` + pts.map(p => `<circle cx="${p.split(',')[0]}" cy="${p.split(',')[1]}" r="2.5" fill="${color}"/>`).join('');
      return;
    }
    const w = (slot * 0.8) / chart.values.length;
    rows.forEach((r, j) => {
      const v = r[i]?.n;
      if (v === undefined) return;
      const a = Math.min(zero, pos(v)), len = Math.abs(pos(v) - zero), off = slot * 0.1 + w * k + slot * j;
      out += horizontal ? `<rect x="${(L + a * pw).toFixed(1)}" y="${(T + off).toFixed(1)}" width="${(len * pw).toFixed(1)}" height="${w.toFixed(1)}" fill="${color}"/>`
        : `<rect x="${(L + off).toFixed(1)}" y="${(T + ph - (a + len) * ph).toFixed(1)}" width="${w.toFixed(1)}" height="${(len * ph).toFixed(1)}" fill="${color}"/>`;
    });
  });
  out += horizontal ? `<line x1="${L + zero * pw}" y1="${T}" x2="${L + zero * pw}" y2="${T + ph}" stroke="#999"/>` : `<line x1="${L}" y1="${T + ph - zero * ph}" x2="${L + pw}" y2="${T + ph - zero * ph}" stroke="#999"/>`;
  if (chart.values.length > 1) out += chart.values.map((i, k) => `<rect x="${L + k * 110}" y="${H - 16}" width="10" height="10" fill="#${PALETTE[k % PALETTE.length]}"/><text x="${L + k * 110 + 14}" y="${H - 7}">${short(sheet.cols[i].header)}</text>`).join('');
  return `${head}${out}</svg>`;
}

// A readable HTML table of what the engine wrote, for the dashboard's preview frame (no scripts, all text escaped).
export function previewHtml(title, sheets) {
  const fmt = (sheet, i, v) => xmlEscape(cellText(sheet, i, v)).replace(/\n/g, '<br>');
  const drawn = s => (s.charts ?? []).length ? `<div class="charts">${s.charts.map(c => chartSvg(s, c)).join('')}</div>`
    + (s.cells.length > 60 ? '<p style="color:#666">차트 미리보기는 앞 60행만 (엑셀 차트는 전체 행)</p>' : '') : '';
  const body = sheets.map(s => `<h2>${xmlEscape(s.name)}</h2>${drawn(s)}<table><thead><tr>${s.cols.map(c => `<th>${xmlEscape(c.header)}</th>`).join('')}</tr></thead><tbody>`
    + s.cells.slice(0, 500).map(r => `<tr>${r.map((v, i) => `<td class="${v?.n !== undefined ? 'n' : ''}">${fmt(s, i, v)}</td>`).join('')}</tr>`).join('')
    + (s.cells.length > 500 ? `<tr><td colspan="${s.cols.length}">… ${s.cells.length - 500}행 더 (엑셀 파일에 모두 있음)</td></tr>` : '')
    + (s.totals ? `<tr class="t">${s.cols.map((c, i) => `<td class="${s.totals.columns.includes(i) ? 'n' : ''}">${s.totals.columns.includes(i)
      ? fmt(s, i, { n: s.totals.values[c.header] }) : i === s.totals.labelAt ? xmlEscape(s.totals.label) : ''}</td>`).join('')}</tr>` : '')
    + '</tbody></table>').join('');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${xmlEscape(title)}</title><style>`
    + 'body{margin:0;padding:20px;font:13px/1.45 system-ui,"Malgun Gothic",sans-serif;color:#222;background:#fff}h2{font-size:15px;margin:18px 0 8px}'
    + 'table{border-collapse:collapse;max-width:100%}th,td{border:1px solid #ccc;padding:4px 8px;vertical-align:top}th{background:#E7E6E6;position:sticky;top:0}'
    + 'td.n{text-align:right;font-variant-numeric:tabular-nums}tr.t td{font-weight:700;border-top:2px solid #888}'
    + '.charts{display:flex;flex-wrap:wrap;gap:12px;margin:0 0 12px}.charts svg{max-width:100%;height:auto}'
    + `</style></head><body><p style="color:#666">엔진이 만든 엑셀 파일의 표 미리보기 · 시트 ${sheets.length}개</p>${body}</body></html>`;
}

// kordoc's Markdown of an xlsx → per sheet: header cells and data rows (its "## name" headings and pipe tables).
export function readbackTables(md) {
  const out = [];
  let cur = null, table = null;
  for (const raw of String(md).split(/\r?\n/)) {
    const line = raw.trim();
    const h = /^#{1,6}\s+(.+)$/.exec(line);
    if (h) { cur = { name: h[1].trim(), tables: [] }; out.push(cur); table = null; continue; }
    if (line.startsWith('|')) {
      // kordoc escapes Markdown characters ("\<A&B>") and writes line breaks as <br>
      const cells = line.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/)
        .map(c => c.trim().replace(/<br\s*\/?>/g, '\n').replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, '$1'));
      if (cells.every(c => /^:?-{3,}:?$/.test(c))) continue;
      if (!cur) { cur = { name: '', tables: [] }; out.push(cur); }
      if (!table) { table = { header: cells, rows: [] }; cur.tables.push(table); } else table.rows.push(cells);
    } else if (line) table = null;
  }
  return out.filter(s => s.tables.length);
}

// Compares the read-back with what the engine wrote: sheet count and names, header texts, row counts and totals.
export function compareReadback(summary, md) {
  const back = readbackTables(md), problems = [];
  if (back.length !== summary.length) problems.push(`시트 수 ${summary.length} → 다시 읽은 것 ${back.length}`);
  summary.forEach((s, i) => {
    const b = back.find(x => x.name === s.name) ?? back[i];
    if (!b) return;
    const t = b.tables[0];
    const header = t.header.map(c => c.replace(/\*\*/g, ''));
    if (s.columns.some((h, j) => header[j] !== h)) problems.push(`${s.name}: 열 제목이 다름 (${header.slice(0, 5).join(', ')})`);
    const rows = t.rows.length - (s.totals ? 1 : 0);
    if (rows !== s.rows) problems.push(`${s.name}: 행 ${s.rows} → 다시 읽은 것 ${rows}`);
    if (s.totals) {
      const last = t.rows.at(-1) ?? [];
      for (const [h, v] of Object.entries(s.totals.values)) {
        const cell = last[s.columns.indexOf(h)] ?? '';
        const n = Number(String(cell).replace(/[,\s원₩*]/g, ''));
        if (!Number.isFinite(n) || Math.abs(n - v) > 1e-9 * Math.max(1, Math.abs(v))) problems.push(`${s.name}: 합계 “${h}” ${v} → 다시 읽은 것 “${cell}”`);
      }
    }
  });
  return { match: problems.length === 0, problems: problems.slice(0, 10), sheets: back.length };
}

// 엑셀 만들기 in a work folder: from a team's spec (.json) or table (.csv) to an .xlsx the engine writes and reads back.
// known: xlsx paths the engine made before (only those may be replaced). converter: DocConverter (kordoc in the sandbox)
// or null when it is not installed — the file is still made, but without a read-back spreadsheet_made cannot pass.
export async function makeSpreadsheet(cwd, { from, to } = {}, known = new Set(), converter = null) {
  const rel = p => typeof p === 'string' && p && !path.isAbsolute(p) && !/^[a-zA-Z]:/.test(p) ? path.normalize(p).replace(/\\/g, '/') : null;
  const src = rel(from), out = rel(to ?? (typeof from === 'string' ? from.replace(/\.(json|csv)$/i, '.xlsx') : null));
  const bad = p => !p || p.startsWith('..') || /^(attachments|sources)\//.test(p) || p.split('/').some(s => s.startsWith('.'));
  if (bad(src) || !/\.(json|csv)$/i.test(src)) return { ok: false, error: '원본은 작업 폴더 안의 .json 또는 .csv 파일이어야 함 (attachments/·sources/ 밖)' };
  if (bad(out) || !out.toLowerCase().endsWith('.xlsx')) return { ok: false, error: '결과는 작업 폴더 안의 .xlsx 파일이어야 함 (attachments/·sources/ 밖)' };
  const full = p => path.join(cwd, p);
  if (!existsSync(full(src)) || !lstatSync(full(src)).isFile()) return { ok: false, error: `원본 ${src} 없음` };
  if (lstatSync(full(src)).size > XLSX_LIMITS.sourceBytes) return { ok: false, error: '원본이 너무 큼 (5MB 초과)' };
  if (existsSync(full(out)) && (!known.has(out) || lstatSync(full(out)).isSymbolicLink())) return { ok: false, error: `${out}이(가) 이미 있음 (엔진이 만든 엑셀만 다시 만듦)` };
  const text = readFileSync(full(src), 'utf8');
  if (hasSecret(text)) return { ok: false, error: '원본에 비밀정보 형식이 있어 만들지 않음' };
  let built;
  try {
    const spec = /\.csv$/i.test(src) ? specFromCsv(text, path.basename(src, path.extname(src))) : JSON.parse(text);
    built = buildXlsx(spec);
  } catch (error) { return { ok: false, error: `표를 만들지 못함: ${String(error.message).slice(0, 200)}` }; }
  writeFileSync(full(out), built.buffer);
  // the engine's own check first: every part comes back out of the ZIP with its CRC and is well-formed XML, and each
  // chart the spec asked for is there
  try {
    const parts = unzip(readFileSync(full(out)));
    const broken = [...parts].find(([name, data]) => /\.(xml|rels)$/.test(name) && !xmlWellFormed(data.toString('utf8')));
    if (broken) throw new Error(`${broken[0]} XML 이 올바르지 않음`);
    const charts = built.summary.reduce((n, s) => n + (s.charts?.length ?? 0), 0);
    if ([...parts.keys()].filter(n => /^xl\/charts\/chart\d+\.xml$/.test(n)).length !== charts) throw new Error('차트 수가 요청과 다름');
  } catch (error) { rmSync(full(out), { force: true }); return { ok: false, error: `만든 파일이 깨짐: ${error.message}` }; }
  writeFileSync(full(`${out}.html`), previewHtml(path.basename(out), built.sheets), 'utf8');
  const sha = p => createHash('sha256').update(readFileSync(full(p))).digest('hex');
  let readback = null;
  if (converter?.available) {
    const back = await converter.convert(cwd, out);
    if (back.ok) {
      const cmp = compareReadback(built.summary, readFileSync(full(back.path), 'utf8'));
      readback = { path: back.path, sha: sha(back.path), match: cmp.match, problems: cmp.problems };
    } else readback = { error: String(back.error ?? 'read-back failed').slice(0, 200) };
  }
  const charts = built.summary.flatMap(s => (s.charts ?? []).map(c => ({ sheet: s.name, type: c.type, title: c.title })));
  return { ok: true, kind: 'xlsx', from: src, path: out, sha: sha(out), bytes: built.buffer.length,
    sheets: built.summary, rows: built.summary.reduce((n, s) => n + s.rows, 0), ...(charts.length ? { charts } : {}), readback, previews: [`${out}.html`] };
}

// The engine's record of the spreadsheets it made for a goal (newest wins), from its run records.
export function spreadsheetRecords(records = []) {
  const map = {};
  for (const r of records) for (const x of r.spreadsheets ?? []) map[x.path] = x;
  return map;
}
