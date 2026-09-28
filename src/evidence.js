import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

// The tool may claim a criterion is done, but only a check this engine runs itself counts as evidence.
// Allowed checks are deliberately tiny and read-only, and confined to the project workspace.
export const REPORT_MARK = 'AGENT_HQ_REPORT';
const MAX_READ = 2_000_000;

export function reportInstructions(criteria) {
  return [
    'Completion criteria:',
    ...criteria.map((c, i) => `${i + 1}. ${c}`),
    '',
    'Do only what these criteria need, then stop. When you finish, end your reply with the line',
    `${REPORT_MARK}`,
    'followed by one JSON object: {"criteria":[{"index":1,"done":true,"check":{...}|null,"note":"..."}]}',
    'For each criterion give a check that proves it using files in the current directory, or null if no file can prove it:',
    '  {"type":"file_exists","path":"relative/path"}',
    '  {"type":"file_contains","path":"relative/path","text":"exact text that must appear"}',
    'Do not claim done without doing the work. Put anything a person must judge in "note".',
    'A check must prove the criterion itself (the requested file or content). A status note you wrote that says',
    'the work is done is not proof: if nothing in the workspace can prove a criterion, use "check": null.',
  ].join('\n');
}

export function parseReport(answer) {
  if (typeof answer !== 'string') return null;
  const at = answer.lastIndexOf(REPORT_MARK);
  if (at < 0) return null;
  const rest = answer.slice(at + REPORT_MARK.length);
  const start = rest.indexOf('{'), end = rest.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const report = JSON.parse(rest.slice(start, end + 1));
    return Array.isArray(report?.criteria) ? report : null;
  } catch { return null; }
}

export function verifyReport(report, criteria, cwd) {
  const byIndex = new Map();
  for (const item of report?.criteria ?? []) {
    if (Number.isInteger(item?.index) && item.index >= 1 && item.index <= criteria.length) byIndex.set(item.index, item);
  }
  const evidence = [], claims = [];
  criteria.forEach((criterion, i) => {
    const item = byIndex.get(i + 1);
    const note = typeof item?.note === 'string' ? item.note.slice(0, 500) : '';
    const result = item?.check ? runCheck(item.check, cwd) : { status: 'none' };
    // A check only counts for a criterion the tool itself reports as done.
    if (result.status === 'pass' && item?.done === true) evidence.push({ criterion, proof: result.proof });
    claims.push({ criterion, claimed: item?.done === true, check: result.status, note, detail: result.proof ?? result.reason ?? '' });
  });
  return { evidence, claims };
}

function runCheck(check, cwd) {
  const target = insideWorkspace(check.path, cwd);
  if (!target) return { status: 'invalid', reason: '작업 폴더 밖이거나 잘못된 경로' };
  const rel = path.relative(cwd, target).replace(/\\/g, '/');
  if (check.type === 'file_exists') {
    return existsSync(target) && statSync(target).isFile()
      ? { status: 'pass', proof: `엔진 확인 · 파일 ${rel} 있음` } : { status: 'fail', reason: `파일 ${rel} 없음` };
  }
  if (check.type === 'file_contains') {
    if (typeof check.text !== 'string' || !check.text) return { status: 'invalid', reason: '확인할 문구가 없음' };
    if (!existsSync(target) || !statSync(target).isFile()) return { status: 'fail', reason: `파일 ${rel} 없음` };
    if (statSync(target).size > MAX_READ) return { status: 'invalid', reason: '파일이 너무 큼' };
    const shown = check.text.length > 60 ? `${check.text.slice(0, 60)}…` : check.text;
    return readFileSync(target, 'utf8').includes(check.text)
      ? { status: 'pass', proof: `엔진 확인 · ${rel}에 “${shown}” 포함` } : { status: 'fail', reason: `${rel}에 “${shown}” 없음` };
  }
  return { status: 'invalid', reason: '지원하지 않는 확인 방식' };
}

function insideWorkspace(p, cwd) {
  if (typeof p !== 'string' || !p || path.isAbsolute(p) || /^[a-zA-Z]:/.test(p)) return null;
  const root = realpathSync(cwd);
  const target = path.resolve(root, p);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  // Follow links only if they stay inside the workspace.
  let real = target;
  try { real = realpathSync(target); } catch {
    try { real = path.join(realpathSync(path.dirname(target)), path.basename(target)); } catch { return target; }
  }
  return real === root || real.startsWith(root + path.sep) ? target : null;
}

// Relative file names in the workspace (for telling a team what is there), skipping .git and node_modules.
export function listWorkspaceFiles(cwd, max = 50) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= max) return;
      if (['.git', 'node_modules'].includes(entry.name) || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) found.push(path.relative(cwd, full).replace(/\\/g, '/'));
    }
  };
  walk(cwd);
  return found;
}

// A content fingerprint of the workspace, used to tell real progress from repeated no-op rounds.
export function workspaceFingerprint(cwd, { maxFiles = 2000 } = {}) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= maxFiles) return;
      if (['.git', 'node_modules'].includes(entry.name) || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(cwd);
  if (!files.length) return null;
  const hash = createHash('sha256');
  for (const file of files) {
    const { size } = statSync(file);
    hash.update(`${path.relative(cwd, file)}\0${size}\0`);
    hash.update(size <= MAX_READ ? createHash('sha256').update(readFileSync(file)).digest('hex') : String(statSync(file).mtimeMs));
  }
  return hash.digest('hex');
}
