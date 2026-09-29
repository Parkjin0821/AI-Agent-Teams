import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hasSecret } from './sentinel.js';

// 대장's attachments (files and pasted screenshots) in the project conversation. They are saved inside the
// project folder under attachments/, so the teams can open them like any other project file; the message
// that carries them lists their paths. Nothing here runs a file.
export const ATTACH_DIR = 'attachments';
export const MAX_ATTACHMENT = 10 * 1024 * 1024;
export const MAX_PER_MESSAGE = 10;
const KINDS = { '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.gif': 'image', '.pdf': 'pdf',
  '.txt': 'text', '.md': 'text', '.csv': 'text', '.json': 'text', '.log': 'text' };
export const KIND_L = { image: '이미지', pdf: 'PDF', text: '글' };
const starts = (bytes, sig, at = 0) => bytes.length >= at + sig.length && sig.every((v, i) => bytes[at + i] === v);
const ascii = s => [...s].map(c => c.charCodeAt(0));
// The content must match the extension (a renamed program is refused).
const MAGIC = {
  '.png': b => starts(b, [0x89, 0x50, 0x4e, 0x47]),
  '.jpg': b => starts(b, [0xff, 0xd8, 0xff]), '.jpeg': b => starts(b, [0xff, 0xd8, 0xff]),
  '.gif': b => starts(b, ascii('GIF8')),
  '.webp': b => starts(b, ascii('RIFF')) && starts(b, ascii('WEBP'), 8),
  '.pdf': b => starts(b, ascii('%PDF-')),
};

export function safeName(name) {
  const base = path.basename(String(name ?? '').replace(/\\/g, '/')).normalize('NFC');
  const ext = path.extname(base).toLowerCase();
  const stem = base.slice(0, base.length - ext.length).replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^[.\s_-]+/, '').trim().slice(0, 60) || '첨부';
  return stem + ext;
}

const stamp = ms => { const d = new Date(ms), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };

export function saveAttachment(cwd, name, bytes, now = Date.now()) {
  const file = safeName(name);
  const ext = path.extname(file).toLowerCase();
  const kind = KINDS[ext];
  if (!kind) throw new Error('unsupported attachment type (images, PDF and text files only)');
  if (!bytes?.length) throw new Error('attachment is empty');
  if (bytes.length > MAX_ATTACHMENT) throw new Error('attachment is larger than 10MB');
  if (MAGIC[ext] && !MAGIC[ext](bytes)) throw new Error('file content does not match its type');
  if (kind === 'text') {
    const text = bytes.toString('utf8');
    if (text.includes('\u0000') || text.includes('�')) throw new Error('text attachment must be UTF-8 text');
    if (hasSecret(text)) throw new Error('attachment looks like it contains a secret (key or token); remove it first');
  }
  const dir = path.join(cwd, ATTACH_DIR);
  mkdirSync(dir, { recursive: true });
  if (lstatSync(dir).isSymbolicLink()) throw new Error('attachments folder cannot be a link');
  let target = `${stamp(now)}-${file}`;
  for (let n = 2; existsSync(path.join(dir, target)); n++) target = `${stamp(now)}-${n}-${file}`;
  writeFileSync(path.join(dir, target), bytes, { flag: 'wx' });
  return { path: `${ATTACH_DIR}/${target}`, name: file, kind, size: bytes.length };
}

// Paths sent with a message must be attachments already saved in this project.
export function checkAttachments(cwd, list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > MAX_PER_MESSAGE) throw new Error(`attach at most ${MAX_PER_MESSAGE} files per message`);
  return list.map(item => {
    const rel = String(item?.path ?? '');
    const m = /^attachments\/([^/\\]+)$/.exec(rel);
    if (!m || m[1].startsWith('.')) throw new Error('attachment path is not in the attachments folder');
    const full = path.join(cwd, ATTACH_DIR, m[1]);
    if (!existsSync(full) || !lstatSync(full).isFile()) throw new Error('attachment not found');
    const kind = KINDS[path.extname(m[1]).toLowerCase()];
    if (!kind) throw new Error('unsupported attachment type');
    return { path: rel, name: String(item?.name ?? m[1]).slice(0, 80), kind, size: lstatSync(full).size };
  });
}

// What the teams read: where each attachment is, and that they should open it themselves.
export function attachmentNote(list) {
  if (!list?.length) return '';
  return `\n[대장 첨부 · 작업 폴더 안 파일 · 직접 열어서 확인] ${list.map(a => `${a.path} (${KIND_L[a.kind] ?? a.kind})`).join(', ')}`;
}
