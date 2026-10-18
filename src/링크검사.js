import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// 링크 검사 (10차 1번): whether the links in the team's pages really lead to a file in the work folder, and whether
// the files the team made have 한글 names. 9차 measurement: "새로 만든 파일 이름이 한글이고 링크·경로가 같은 이름을
// 쓴다" stalled the webpage project, because no engine check could prove it and the verifier could not either.
// A link is parsed, its query and fragment dropped, %-decoded, made relative to the page, normalised, kept inside
// the work folder, and then looked up name by name: 한글 written in either Unicode form (NFC/NFD) is the same name,
// but a different letter case is not (it opens on Windows and breaks on a web server).
const PAGE = /\.(html?|md|markdown|css)$/i;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.hq-screens', 'attachments', 'sources']);
const MAX_FILES = 300, MAX_BYTES = 2_000_000;
const nfc = s => String(s).normalize('NFC');

// Local links in one page: [{ raw, line }]. External addresses and in-page anchors are left out later.
export function extractLinks(text, file) {
  const src = String(text ?? '');
  const out = [];
  const add = (raw, index) => { if (raw != null) out.push({ raw: raw.trim(), line: src.slice(0, index).split('\n').length }); };
  if (/\.css$/i.test(file)) {
    for (const m of src.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi)) add(m[1] ?? m[2] ?? m[3], m.index);
    return out;
  }
  if (/\.html?$/i.test(file)) {
    const html = src.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '));
    for (const m of html.matchAll(/\s(href|src|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi)) add(m[2] ?? m[3] ?? m[4], m.index);
    for (const m of html.matchAll(/\ssrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      for (const part of (m[1] ?? m[2]).split(',')) add(part.trim().split(/\s+/)[0], m.index);
    }
    for (const m of html.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi)) add(m[1] ?? m[2] ?? m[3], m.index);
    return out;
  }
  // Markdown: [text](target "title"), ![alt](target), [text](<target with spaces>), and HTML written inside it.
  for (const m of src.matchAll(/!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+["'][^"'\n]*["'])?\s*\)/g)) add(m[1] ?? m[2], m.index);
  for (const m of src.matchAll(/\s(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) add(m[2] ?? m[3], m.index);
  return out;
}

// Finds rel ("a/b.html", already decoded and normalised) under root name by name.
// { found, kind: 'file'|'dir', actual } or { found: false, reason }
function lookup(root, rel) {
  let dir = root, actual = [];
  const parts = rel.split('/').filter(Boolean);
  for (const [i, seg] of parts.entries()) {
    let names;
    try { names = readdirSync(dir); } catch { return { found: false, reason: `${actual.join('/') || '작업 폴더'} 를 읽을 수 없음` }; }
    const exact = names.find(n => nfc(n) === nfc(seg));
    if (!exact) {
      const loose = names.find(n => nfc(n).toLowerCase() === nfc(seg).toLowerCase());
      return { found: false, reason: loose ? `대소문자가 다름 (실제 이름: ${[...actual, loose].join('/')})` : `${[...actual, seg].join('/')} 없음` };
    }
    actual.push(exact);
    dir = path.join(dir, exact);
    let st;
    try { st = statSync(dir); } catch { return { found: false, reason: `${actual.join('/')} 를 읽을 수 없음` }; }
    if (i < parts.length - 1 && !st.isDirectory()) return { found: false, reason: `${actual.join('/')} 는 폴더가 아님` };
    if (i === parts.length - 1) return { found: true, kind: st.isDirectory() ? 'dir' : 'file', actual: actual.join('/') };
  }
  return { found: true, kind: 'dir', actual: '' };
}

// One link from page fromRel: { status: 'skip'|'ok'|'broken', reason?, target? }
export function resolveLink(raw, fromRel, cwd) {
  let s = String(raw ?? '').trim();
  if (!s || s.startsWith('#') || /\{\{|\$\{|<%/.test(s)) return { status: 'skip' };
  if (/^[a-zA-Z]:[\\/]/.test(s) || /^file:/i.test(s) || /^\\\\/.test(s)) return { status: 'broken', reason: '이 컴퓨터의 절대 경로라 다른 곳에서는 열리지 않음' };
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(s)) return { status: 'skip' }; // https:, mailto:, tel:, data:, //cdn…
  s = s.replace(/[?#].*$/, '');
  if (!s) return { status: 'skip' };
  let decoded;
  try { decoded = decodeURIComponent(s); } catch { return { status: 'broken', reason: '잘못된 %인코딩' }; }
  decoded = decoded.replace(/\\/g, '/');
  const base = decoded.startsWith('/') ? '' : path.posix.dirname(fromRel.replace(/\\/g, '/'));
  const joined = path.posix.normalize(path.posix.join(base === '.' ? '' : base, decoded.replace(/^\/+/, '')));
  if (joined === '..' || joined.startsWith('../') || path.posix.isAbsolute(joined)) return { status: 'broken', reason: '작업 폴더 밖을 가리킴' };
  const trimmed = joined.replace(/\/+$/, '');
  const rel = trimmed === '.' || trimmed === '' ? '' : trimmed;
  const hit = lookup(cwd, rel);
  if (!hit.found) return { status: 'broken', reason: hit.reason };
  if (hit.kind === 'dir') {
    const index = lookup(cwd, rel ? `${rel}/index.html` : 'index.html');
    return index.found && index.kind === 'file' ? { status: 'ok', target: index.actual } : { status: 'broken', reason: `${rel || '작업 폴더'} 는 폴더이고 index.html 이 없음` };
  }
  return { status: 'ok', target: hit.actual };
}

// Every page in the work folder, or only the ones given. { pages, links, broken: [{ file, line, link, reason }] }
export function checkLinks(cwd, { files = null, skip = () => false } = {}) {
  const pages = (files ?? workspaceFiles(cwd)).filter(f => PAGE.test(f) && !skip(f));
  const broken = [];
  let links = 0;
  for (const file of pages) {
    let text;
    try { if (statSync(path.join(cwd, file)).size > MAX_BYTES) continue; text = readFileSync(path.join(cwd, file), 'utf8'); } catch { continue; }
    for (const l of extractLinks(text, file)) {
      const r = resolveLink(l.raw, file, cwd);
      if (r.status === 'skip') continue;
      links++;
      if (r.status === 'broken') broken.push({ file, line: l.line, link: l.raw, reason: r.reason });
    }
  }
  return { pages: pages.length, links, broken };
}

// Names tools require keep their fixed spelling beside 한글 names.
export const FIXED_NAMES = new Set(['index.html', 'index.htm', 'index.tsx', 'index.js', 'package.json', 'package-lock.json', 'readme.md',
  'skill.md', 'tsconfig.json', 'favicon.ico', 'robots.txt', '.gitignore', 'license', 'license.md']);
// Files the team made whose names have no 한글 (attachments, saved originals, the engine's own files and fixed tool
// names are left out). { files, offenders }
export function koreanNameIssues(cwd, { skip = () => false } = {}) {
  const files = workspaceFiles(cwd).filter(f => !skip(f) && !/^reports\//.test(f));
  const offenders = files.filter(f => {
    const base = path.posix.basename(f);
    if (FIXED_NAMES.has(base.toLowerCase())) return false;
    const stem = base.replace(/(\.[A-Za-z0-9]{1,8})+$/, '');
    return !/[가-힣]/.test(nfc(stem));
  });
  return { files: files.length, offenders };
}

function workspaceFiles(cwd) {
  const found = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= MAX_FILES) return;
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name) || e.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile()) found.push(r);
    }
  };
  walk(cwd, '');
  return found;
}
