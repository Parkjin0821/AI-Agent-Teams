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
    '  {"type":"tests_pass"}  (the engine itself runs the project tests in a sandbox during verification:',
    '   npm test if package.json has a test script, otherwise node --test, otherwise python -m unittest)',
    '  {"type":"file_unchanged","paths":["attachments/…"]}  (files 대장 attached are unchanged: the engine compares each',
    '   file with the fingerprint it recorded when the file was attached)',
    'Do not claim done without doing the work. Put anything a person must judge in "note".',
    'You may add "requests":[{"team":"dev|design|research","task":"specific follow-up within this project","criteria":["verifiable criterion"],"risk":"low|normal|high","complexity":"simple|normal|complex","effects":[]}] to propose collaboration. Requests are proposals, not permissions. Never expand the user scope.',
    'You may add "remember":[{"scope":"all"|"<team id>","text":"..."}] (at most 3) for lasting preferences or rules 대장 stated; they apply only after 대장 approves them.',
    'A check must prove the criterion itself (the requested file or content). A status note you wrote that says',
    'the work is done is not proof: if nothing in the workspace can prove a criterion, use "check": null.',
    'The engine ignores a check that is about something else: the searched text (or the file, for file_exists) must',
    'share a word with the criterion, and file_unchanged only proves a criterion about attached originals staying the same.',
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

// ctx.verifying: this is the verification round; ctx.test: { label, passed } if the engine ran the tests.
export function verifyReport(report, criteria, cwd, ctx = {}) {
  const byIndex = new Map();
  for (const item of report?.criteria ?? []) {
    if (Number.isInteger(item?.index) && item.index >= 1 && item.index <= criteria.length) byIndex.set(item.index, item);
  }
  const evidence = [], claims = [];
  criteria.forEach((criterion, i) => {
    const item = byIndex.get(i + 1);
    const note = typeof item?.note === 'string' ? item.note.slice(0, 500) : '';
    let result = item?.check ? runCheck(item.check, cwd, ctx) : { status: 'none' };
    // A passing check that is about something else (e.g. "IMG-5390 is in result.md" for "nothing was guessed") proves nothing.
    if (result.status === 'pass' && item?.done === true && !relatesTo(item.check, criterion)) {
      result = { status: 'unrelated', reason: `${result.proof.replace(/^엔진 확인 · /, '')} — 이 조건과 관련 없는 검사라 근거로 치지 않음` };
    }
    // A check only counts for a criterion the tool itself reports as done.
    if (result.status === 'pass' && item?.done === true) evidence.push({ criterion, proof: result.proof });
    claims.push({ criterion, claimed: item?.done === true, check: result.status, note, detail: result.proof ?? result.reason ?? '' });
  });
  return { evidence, claims };
}

// A check relates to a criterion when the criterion names what the check looks at: a word of the searched text,
// the file for file_exists, or attached originals for file_unchanged. tests_pass is the engine's own test run.
const GENERIC_WORDS = new Set(['파일', '내용', '있다', '없다', '있음', '없음', '작업', '폴더', '항목', '결과', '확인', '적혀', '포함', '표시']);
const words = text => (String(text).toLowerCase().match(/[가-힣]+|[a-z0-9]+(?:[.,_-][a-z0-9]+)*/g) ?? [])
  .filter(w => w.length >= 2 && !GENERIC_WORDS.has(w));
const mentions = (criterion, word) => criterion.includes(word) || (/^[가-힣]{3,}$/.test(word) && criterion.includes(word.slice(0, -1)));
const UNCHANGED_WORDS = /원본|첨부|바뀌|바꾸|변경|수정하지|그대로|훼손|지문|unchanged|original|attach/;
function relatesTo(check, criterion) {
  const c = String(criterion).toLowerCase();
  if (check.type === 'tests_pass') return true;
  if (check.type === 'file_unchanged') return UNCHANGED_WORDS.test(c);
  if (check.type === 'file_exists') return words(String(check.path).replace(/\\/g, '/')).some(w => mentions(c, w));
  if (check.type === 'file_contains') return words(check.text).some(w => mentions(c, w));
  return false;
}

function runCheck(check, cwd, ctx = {}) {
  if (check?.type === 'tests_pass') {
    if (!ctx.test) return ctx.verifying ? { status: 'fail', reason: '실행된 테스트 없음 (테스트 파일이 없거나 샌드박스를 쓸 수 없음)' }
      : { status: 'later', reason: '테스트는 검증 단계에서 엔진이 실행' };
    return ctx.test.passed ? { status: 'pass', proof: `엔진 확인 · 샌드박스에서 ${ctx.test.label} 통과` }
      : { status: 'fail', reason: `${ctx.test.label} 실패` };
  }
  if (check?.type === 'file_unchanged') return checkUnchanged(check, cwd, ctx.originals ?? {});
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

// originals: { "attachments/x": { sha, from } } — fingerprints the engine itself recorded (at upload, or in the
// checkpoint taken before the first run that saw the file). Only files with such a record can be checked.
function checkUnchanged(check, cwd, originals) {
  const list = Array.isArray(check.paths) ? check.paths : check.path ? [check.path] : [];
  if (!list.length || list.length > 20) return { status: 'invalid', reason: '확인할 파일 목록이 없음' };
  const done = [];
  for (const p of list) {
    const target = insideWorkspace(p, cwd);
    if (!target) return { status: 'invalid', reason: '작업 폴더 밖이거나 잘못된 경로' };
    const rel = path.relative(cwd, target).replace(/\\/g, '/');
    const orig = originals[rel];
    if (!orig) return { status: 'invalid', reason: `${rel}의 원래 지문 기록이 없음 (대장이 첨부한 파일만 확인 가능)` };
    if (!existsSync(target) || !statSync(target).isFile()) return { status: 'fail', reason: `${rel} 없어짐` };
    if (statSync(target).size > MAX_READ) return { status: 'invalid', reason: `${rel}이(가) 너무 커서 비교하지 않음` };
    const now = createHash('sha256').update(readFileSync(target)).digest('hex');
    if (now !== orig.sha) return { status: 'fail', reason: `${rel} 내용이 ${orig.from}과 다름 (바뀜)` };
    done.push(`${rel} (${orig.from})`);
  }
  return { status: 'pass', proof: `엔진 확인 · 지문이 원래 기록과 같음 · ${done.join(', ')}` };
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
