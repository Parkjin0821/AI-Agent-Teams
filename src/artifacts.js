import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { listWorkspaceFiles } from './evidence.js';

const TYPES = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.json': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  // Code is shown as plain text only (never run), so 대장 can read what a team changed before approving it.
  ...Object.fromEntries(['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.css', '.py', '.csv'].map(e => [e, 'text/plain; charset=utf-8'])) };
function resolveFile(cwd, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes(':')
    || relative.split('/').some(s => !s || s === '.' || s === '..' || s.startsWith('.')) || path.isAbsolute(relative)) throw new Error('unsafe artifact path');
  const root = realpathSync(cwd);
  let file = root;
  for (const part of relative.split('/')) {
    file = path.join(file, part);
    if (lstatSync(file).isSymbolicLink()) throw new Error('artifact links are forbidden');
  }
  if (!realpathSync(file).startsWith(`${root}${path.sep}`)) throw new Error('artifact escapes workspace');
  return file;
}
export function readArtifact(cwd, relative) {
  const type = TYPES[path.extname(relative).toLowerCase()];
  if (!type) throw new Error('unsupported preview format');
  if (/(^|\/)(?:credentials?|secrets?|\.env)(?:\.|\/|$)/i.test(relative)) throw new Error('sensitive artifact name');
  const file = resolveFile(cwd, relative), stat = lstatSync(file);
  if (!stat.isFile() || stat.size > 2000000) throw new Error('artifact must be a file under 2MB');
  return { type, bytes: readFileSync(file) };
}
export function artifactList(cwd) {
  return listWorkspaceFiles(cwd, 2000).filter(file => {
    try { readArtifact(cwd, file); return true; } catch { return false; }
  }).map(file => ({ path: file, type: TYPES[path.extname(file).toLowerCase()] }));
}
