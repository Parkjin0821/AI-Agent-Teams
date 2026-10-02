import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { hasSecret } from './보안감시.js';

// 엑셀 만들기 (2026-10-02, method A): a work team writes the table as a JSON spec (or a CSV) and the engine itself writes
// the .xlsx with Node built-ins only — an xlsx is a ZIP of XML parts, so the ZIP container (local headers, central
// directory, CRC-32) is written here with zlib's raw deflate. No package, no model call. The engine then reads the file
// back with kordoc (the same sandboxed tool that reads attachments) and compares sheets, rows, headers and totals, so
// spreadsheet_made proves a file that opens and holds what the spec said. Charts are not made (phase 2).
export const XLSX_LIMITS = Object.freeze({ sheets: 10, rows: 20_000, columns: 50, cellChars: 32_767, sourceBytes: 5_000_000 });
export const COLUMN_TYPES = ['text', 'number', 'date', 'money', 'percent'];

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
      return { header, type, width, korean: type === 'date' && c?.format === 'korean' };
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
      return cols.map((c, ci) => {
        const v = list[ci];
        if (v === null || v === undefined || v === '') return null;
        if (typeof v === 'object') throw new Error(`${name}: ${ri + 1}행 “${c.header}” 칸은 글자나 숫자여야 함`);
        if (c.type === 'text') return { s: String(v) };
        const n = PARSE[c.type](v);
        if (n === null) { if (warnings.length < 5) warnings.push(`${ri + 1}행 “${c.header}” 값 “${String(v).slice(0, 20)}”을(를) 글자로 둠`); return { s: String(v) }; }
        return { n };
      });
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
    return { name, cols, cells, totals, warnings };
  });
}
const round = n => Math.round(n * 1e9) / 1e9;

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
  const parts = [];
  sheets.forEach((sheet, si) => {
    const xml = [];
    const cell = (ref, v, style) => v.n !== undefined ? `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${v.n}</v></c>`
      : `<c r="${ref}" t="s"${style ? ` s="${style}"` : ''}><v>${sst(v.s)}</v></c>`;
    xml.push(`<row r="1">${sheet.cols.map((c, i) => cell(`${colName(i)}1`, { s: c.header }, 1)).join('')}</row>`);
    sheet.cells.forEach((row, ri) => {
      const r = ri + 2;
      const inner = row.map((v, i) => v ? cell(`${colName(i)}${r}`, v, v.n !== undefined ? styleOf(sheet, i) : (v.s.includes('\n') ? 11 : 0)) : '').join('');
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
      + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>', 'utf8') });
  });
  const space = s => /^\s|\s$|\n/.test(s) ? ' xml:space="preserve"' : '';
  const files = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
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
    ...(s.totals ? { totals: { label: s.totals.label, values: s.totals.values } } : {}), ...(s.warnings.length ? { warnings: s.warnings } : {}) }));
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

// A readable HTML table of what the engine wrote, for the dashboard's preview frame (no scripts, all text escaped).
export function previewHtml(title, sheets) {
  const fmt = (sheet, i, v) => {
    if (!v) return '';
    if (v.s !== undefined) return xmlEscape(v.s).replace(/\n/g, '<br>');
    const c = sheet.cols[i];
    if (c.type === 'percent') return `${(v.n * 100).toFixed(1)}%`;
    if (c.type === 'date') { const d = new Date(Date.UTC(1899, 11, 30) + v.n * 86_400_000); const p = n => String(n).padStart(2, '0');
      return c.korean ? `${d.getUTCFullYear()}. ${d.getUTCMonth() + 1}. ${d.getUTCDate()}.` : `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`; }
    return v.n.toLocaleString('ko-KR', { maximumFractionDigits: decimals(sheet, i) ? 2 : 0, minimumFractionDigits: decimals(sheet, i) ? 2 : 0 });
  };
  const body = sheets.map(s => `<h2>${xmlEscape(s.name)}</h2><table><thead><tr>${s.cols.map(c => `<th>${xmlEscape(c.header)}</th>`).join('')}</tr></thead><tbody>`
    + s.cells.slice(0, 500).map(r => `<tr>${r.map((v, i) => `<td class="${v?.n !== undefined ? 'n' : ''}">${fmt(s, i, v)}</td>`).join('')}</tr>`).join('')
    + (s.cells.length > 500 ? `<tr><td colspan="${s.cols.length}">… ${s.cells.length - 500}행 더 (엑셀 파일에 모두 있음)</td></tr>` : '')
    + (s.totals ? `<tr class="t">${s.cols.map((c, i) => `<td class="${s.totals.columns.includes(i) ? 'n' : ''}">${s.totals.columns.includes(i)
      ? fmt(s, i, { n: s.totals.values[c.header] }) : i === s.totals.labelAt ? xmlEscape(s.totals.label) : ''}</td>`).join('')}</tr>` : '')
    + '</tbody></table>').join('');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${xmlEscape(title)}</title><style>`
    + 'body{margin:0;padding:20px;font:13px/1.45 system-ui,"Malgun Gothic",sans-serif;color:#222;background:#fff}h2{font-size:15px;margin:18px 0 8px}'
    + 'table{border-collapse:collapse;max-width:100%}th,td{border:1px solid #ccc;padding:4px 8px;vertical-align:top}th{background:#E7E6E6;position:sticky;top:0}'
    + 'td.n{text-align:right;font-variant-numeric:tabular-nums}tr.t td{font-weight:700;border-top:2px solid #888}'
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
  // the engine's own check first: every part comes back out of the ZIP with its CRC
  try { unzip(readFileSync(full(out))); } catch (error) { return { ok: false, error: `만든 파일이 깨짐: ${error.message}` }; }
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
  return { ok: true, kind: 'xlsx', from: src, path: out, sha: sha(out), bytes: built.buffer.length,
    sheets: built.summary, rows: built.summary.reduce((n, s) => n + s.rows, 0), readback, previews: [`${out}.html`] };
}

// The engine's record of the spreadsheets it made for a goal (newest wins), from its run records.
export function spreadsheetRecords(records = []) {
  const map = {};
  for (const r of records) for (const x of r.spreadsheets ?? []) map[x.path] = x;
  return map;
}
