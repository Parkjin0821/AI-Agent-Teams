import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// 작업 묶음 (docs/codex-격리-복원.md 2차 설계): the files a Codex step may see go into the WSL distro as one tar
// stream, and what it leaves behind comes back the same way. No Windows folder is shared with the distro.
// Going in, only the project's own plain files go (no .git, node_modules, secret-looking files or agent config).
// Coming back, reading the stream IS the guard: only plain files and folders inside the job, never links, devices,
// paths that climb out, or files that would steer the next agent (.claude, AGENTS.md, …). One bad entry rejects all.

export const EXCLUDED_DIRS = new Set(['.git', 'node_modules']);
export const AGENT_CONFIG = /^(\.claude|\.codex|\.agents|\.mcp\.json|CLAUDE(?:\.local)?\.md|AGENTS(?:\.override)?\.md)$/i;
export const SECRET_FILE = /^\.env(\..*)?$|\.(pem|key|p12|pfx|keystore)$|^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$|^\.npmrc$|^\.netrc$/i;
export const LIMITS = { maxFiles: 20_000, maxBytes: 200 * 1024 * 1024, maxFileBytes: 50 * 1024 * 1024 };

export class BundleRejected extends Error {
  constructor(message) { super(message); this.name = 'BundleRejected'; }
}
const reject = (message) => { throw new BundleRejected(message); };

// ── writing (engine → distro) ───────────────────────────────────────────────────────────────────────────────────
const BLOCK = 512;
const octal = (value, width) => `${value.toString(8).padStart(width - 1, '0')}\0`;
export function tarHeader({ name, size, type, mode = 0o644, mtime = 0 }) {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(mtime, 12), 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}
const pad = (size) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
// A pax record carries the real (UTF-8, any length) path; the ustar name field only gets a short ASCII stand-in.
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
  return Buffer.from(`${length}${body}`, 'utf8');
}
function entry(parts, rel, type, data, mtime) {
  const plain = /^[\x21-\x7e]+$/.test(rel) && rel.length <= 100;
  if (!plain) {
    const pax = paxRecord('path', rel);
    parts.push(tarHeader({ name: 'PaxHeader', size: pax.length, type: 'x', mode: 0o644, mtime }), pax, pad(pax.length));
  }
  const name = plain ? rel : `hq-entry${type === '5' ? '/' : ''}`;
  parts.push(tarHeader({ name, size: data.length, type, mode: type === '5' ? 0o755 : 0o644, mtime }));
  if (data.length) parts.push(data, pad(data.length));
}

// → { tar: Buffer, files: [relative paths], skipped: [{ path, why }] }
export function packFolder(root, { limits = LIMITS } = {}) {
  const parts = [], files = [], skipped = [];
  let total = 0;
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name), relPath = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) reject(`작업 폴더에 링크가 있다: ${relPath}`);
      if (AGENT_CONFIG.test(name)) { skipped.push({ path: relPath, why: '에이전트 설정' }); continue; }
      if (stat.isDirectory()) {
        if (EXCLUDED_DIRS.has(name)) { skipped.push({ path: relPath, why: '제외 폴더' }); continue; }
        entry(parts, relPath, '5', Buffer.alloc(0), Math.floor(stat.mtimeMs / 1000));
        walk(full, relPath);
      } else if (stat.isFile()) {
        if (SECRET_FILE.test(name)) { skipped.push({ path: relPath, why: '비밀정보로 보이는 파일' }); continue; }
        if (stat.size > limits.maxFileBytes) reject(`파일이 너무 크다: ${relPath}`);
        if (files.length >= limits.maxFiles) reject('파일이 너무 많다');
        if ((total += stat.size) > limits.maxBytes) reject('작업 폴더가 너무 크다');
        entry(parts, relPath, '0', readFileSync(full), Math.floor(stat.mtimeMs / 1000));
        files.push(relPath);
      } else {
        skipped.push({ path: relPath, why: '일반 파일이 아님' });
      }
    }
  };
  walk(path.resolve(root), '');
  parts.push(Buffer.alloc(BLOCK * 2));
  return { tar: Buffer.concat(parts), files, skipped };
}

// ── reading (distro → engine) ───────────────────────────────────────────────────────────────────────────────────
const field = (h, start, length) => { const raw = h.subarray(start, start + length); const end = raw.indexOf(0); return (end < 0 ? raw : raw.subarray(0, end)).toString('utf8'); };
const number = (h, start, length) => {
  const text = field(h, start, length).trim();
  if (!/^[0-7]*$/.test(text)) reject('묶음 머리글의 숫자가 이상하다');
  return text ? parseInt(text, 8) : 0;
};
function parsePax(data) {
  const out = {};
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const length = parseInt(data.subarray(at, space).toString('ascii'), 10);
    if (space < 0 || !Number.isInteger(length) || length <= 0) reject('pax 기록이 이상하다');
    const record = data.subarray(space + 1, at + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    out[record.slice(0, eq)] = record.slice(eq + 1);
    at += length;
  }
  return out;
}
// A path is accepted only as plain relative segments; anything that could point elsewhere on either OS is refused.
export function checkReturnedPath(raw) {
  const rel = String(raw).replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (!rel || rel === '.') return null;
  if (rel.includes('\0') || rel.includes('\\') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.includes(':')) reject(`허용되지 않는 경로: ${rel}`);
  const segments = rel.split('/');
  for (const s of segments) {
    if (!s || s === '.' || s === '..') reject(`허용되지 않는 경로: ${rel}`);
    if (EXCLUDED_DIRS.has(s) || AGENT_CONFIG.test(s)) reject(`돌려받을 수 없는 파일: ${rel}`);
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s) || /[<>"|?*]|[. ]$/.test(s)) reject(`Windows에서 쓸 수 없는 이름: ${rel}`);
  }
  return segments.join('/');
}

// → { files: [{ path, data }], dirs: [path] }; throws BundleRejected on the first entry that is not allowed.
export function unpackReturn(tar, { limits = LIMITS } = {}) {
  const files = [], dirs = [];
  let at = 0, total = 0, pax = {}, longName = null, ended = false;
  while (at + BLOCK <= tar.length) {
    const h = tar.subarray(at, at + BLOCK);
    if (h.every(b => b === 0)) { ended = true; break; }
    const stored = number(h, 148, 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    if (sum !== stored) reject('묶음 머리글 검사합이 맞지 않는다');
    const type = String.fromCharCode(h[156] || 0x30);
    let size = number(h, 124, 12);
    if (pax.size !== undefined) size = Number(pax.size);
    const dataStart = at + BLOCK, dataEnd = dataStart + size;
    if (!Number.isSafeInteger(size) || size < 0 || dataEnd > tar.length) reject('묶음이 잘렸다');
    const data = tar.subarray(dataStart, dataEnd);
    at = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') { pax = parsePax(data); continue; }
    if (type === 'g') continue;
    if (type === 'L') { longName = field(data, 0, data.length); continue; }
    const prefix = field(h, 345, 155);
    const name = pax.path ?? longName ?? (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
    pax = {}; longName = null;
    if (type === '1' || type === '2') reject(`링크는 돌려받지 않는다: ${name}`);
    if (type !== '0' && type !== '5') reject(`일반 파일이 아니다(종류 ${type}): ${name}`);
    const rel = checkReturnedPath(name);
    if (rel === null) continue;
    if (type === '5') { dirs.push(rel); continue; }
    if (size > limits.maxFileBytes) reject(`파일이 너무 크다: ${rel}`);
    if (files.length >= limits.maxFiles) reject('파일이 너무 많다');
    if ((total += size) > limits.maxBytes) reject('돌려받는 묶음이 너무 크다');
    files.push({ path: rel, data: Buffer.from(data) });
  }
  if (!ended) reject('묶음이 잘렸다 (끝 표시 없음)');
  return { files, dirs };
}

// Writes an accepted return into a fresh folder (a staging copy; applying it to the project is a later step).
export function extractReturn({ files, dirs }, target) {
  const root = path.resolve(target);
  const inside = rel => { const full = path.resolve(root, ...rel.split('/')); if (!full.startsWith(root + path.sep)) reject(`작업 폴더 밖 경로: ${rel}`); return full; };
  for (const d of dirs) mkdirSync(inside(d), { recursive: true });
  for (const f of files) { const full = inside(f.path); mkdirSync(path.dirname(full), { recursive: true }); writeFileSync(full, f.data); }
}
