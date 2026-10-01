import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { FORBIDDEN_NAMES, WRITE_TOOLS, hasSecret } from './sentinel.js';

// The tool may claim a criterion is done, but only a check this engine runs itself counts as evidence.
// Allowed checks are deliberately tiny and read-only, and confined to the project workspace.
export const REPORT_MARK = 'AGENT_HQ_REPORT';
const MAX_READ = 2_000_000;

// verifying: the verification team only looks, so it is not asked to polish. Work steps are (seen in real runs: a page
// made in 20 seconds and handed on unchecked): they review their own result once before they finish.
export function reportInstructions(criteria, { verifying = false } = {}) {
  return [
    'Completion criteria:',
    ...criteria.map((c, i) => `${i + 1}. ${c}`),
    '',
    verifying ? 'Check only what these criteria need, then stop. When you finish, end your reply with the line'
      : 'Do what the task and these criteria need, and do it well. Before you finish, open what you made once more and review'
        + ' it against the task and the criteria (for a page: the engine\'s screen captures listed above, if any); fix what'
        + ' is weak, missing or awkward, without widening the task. Then end your reply with the line',
    `${REPORT_MARK}`,
    'followed by one JSON object: {"criteria":[{"index":1,"done":true,"check":{...}|null,"note":"..."}]}',
    'For each criterion give a check that proves it using files in the current directory, or null if no file can prove it:',
    '  {"type":"file_exists","path":"relative/path"}',
    '  {"type":"file_contains","path":"relative/path","text":"exact text that must appear"}',
    '  {"type":"tests_pass"}  (the engine itself runs the project tests in a sandbox during verification:',
    '   npm test if package.json has a test script, otherwise node --test, otherwise python -m unittest)',
    '  {"type":"file_unchanged","paths":["attachments/…"]}  (files 대장 attached are unchanged: the engine compares each',
    '   file with the fingerprint it recorded when the file was attached)',
    '  {"type":"stayed_inside"}  (the engine checks its own records: every step of this project ran under its write',
    '   limits, and the folder has no forbidden settings file (.claude, .codex, .mcp.json, CLAUDE.md, AGENTS.md, .env, .git),',
    '   no link and no secret-looking text; it proves only that part of a criterion, not what was read or guessed)',
    '  {"type":"source_contains","source":"sources/…","text":"exact text","path":"relative/path"}  (the text is in a web',
    '   page original the engine itself saved under sources/, unchanged since; with "path", that file contains it too —',
    '   e.g. a version in research.md that matches the official page)',
    '  {"type":"file_updated","path":"relative/path"}  (in a repeated round: the file is new or changed since this round',
    '   started, compared with the fingerprints the engine recorded then)',
    '  {"type":"json_shape","path":"data/x.json","list":"items (optional key; default the file itself is the list)",',
    '   "count":12,"fields":{"name":"string","price":"positive_integer","note":"one_line","tags":"string_array"},"unique":"name"}',
    '   (the engine parses the JSON itself; kinds: string, one_line, number, integer, positive_integer, boolean, array,',
    '   string_array, date; count, fields and unique are each optional)',
    '  {"type":"folder_only","path":"folder/","files":["a.json","README.md"]}  (the folder holds exactly these files)',
    '  {"type":"file_excludes","path":"index.html","texts":["http://","https://","fetch("]}  (none of these texts is in',
    '   the file, letter case ignored; proves a "없다·쓰지 않는다" criterion for exactly those texts). Example: for',
    '   "index.html은 외부 라이브러리·http 참조·fetch 없이 동작한다" give {"type":"file_excludes","path":"index.html",',
    '   "texts":["http://","https://","src=\\"//","fetch(","XMLHttpRequest"]}. Finding something else that IS there',
    '   (e.g. "<style>") never proves that something is NOT there.',
    '  {"type":"screen_ok","path":"index.html"}  (in verification: the engine opened this page in an isolated browser at',
    '   PC 1440px and phone 390px just before this step and found no horizontal overflow, broken image or script error;',
    '   it does not judge whether the page looks good)',
    '  {"type":"document_made","path":"x.hwpx","text":"optional exact text"}  (the engine itself made this 한글 document',
    '   from your Markdown, it passed the structure check and is unchanged since; with "text", the document contains it)',
    'To get a 한글 document (HWPX), write the text as Markdown and add "documents":[{"from":"x.md","to":"x.hwpx",',
    '"preset":"보고서"}] (presets: 기안문, 보고서, 계획서, 통지, 회의록, 개조식, 업무보고, 서울방침, 보도자료; at most 3).',
    'After your step the engine makes it, checks it, and saves previews (x.hwpx.svg, x.hwpx.html) and a read-back (x.hwpx.md).',
    'If you read web pages, list them in "sources":[{"url":"https://…"}] (at most 5). After your step the engine fetches',
    'each allowed page again and saves its original text under sources/ for comparison. Never write into sources/.',
    'Do not claim done without doing the work. Put anything a person must judge in "note".',
    'Add "person": true to a criterion (or the part of it) that no file and no engine check can prove, so only 대장 can',
    'judge it. Never use it for work that is still missing.',
    'You may add "requests":[{"team":"dev|design|research","task":"specific follow-up within this project","criteria":["verifiable criterion"],"risk":"low|normal|high","complexity":"simple|normal|complex","effects":[]}] to propose collaboration. Requests are proposals, not permissions. Never expand the user scope.',
    'You may add "remember":[{"scope":"all"|"<team id>","text":"..."}] (at most 3) for lasting preferences or rules 대장 stated; they apply only after 대장 approves them.',
    'A criterion with several parts (four sections, three files, each field) may use "checks":[{...},{...}] instead of',
    '"check" (at most 8); it counts only when every check passes and at least one is about the criterion. Use null only when no',
    'combination of these checks can prove it — reading a file yourself and saying so is not proof.',
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
    // "checks": a criterion with several parts (four sections, three files) counts only when every check passes and
    // each is about it. Seen in a real run: the verifier confirmed such criteria by reading and left "check": null,
    // because one check could only look at one text.
    const list = Array.isArray(item?.checks) && item.checks.length ? item.checks.slice(0, 8) : item?.check ? [item.check] : [];
    let result = list.length ? runChecks(list, criterion, cwd, ctx, item?.done === true) : { status: 'none' };
    // stayed_inside proves only the work-folder part of a criterion; the rest (e.g. "nothing guessed") stays with 대장.
    if (result.status === 'pass' && item?.done === true && list.length === 1 && list[0].type === 'stayed_inside') {
      const rest = beyondBoundary(criterion);
      if (rest.length) result = { status: 'partial', reason: `${result.proof.replace(/^엔진 확인 · /, '')} — 엔진은 이 부분만 확인함 · “${rest.join(' ')}” 부분은 대장 판단` };
    }
    // A check only counts for a criterion the tool itself reports as done.
    if (result.status === 'pass' && item?.done === true) evidence.push({ criterion, proof: result.proof });
    claims.push({ criterion, claimed: item?.done === true, check: result.status, note, detail: result.proof ?? result.reason ?? '',
      ...(item?.person === true && result.status !== 'pass' ? { person: true } : {}) });
  });
  return { evidence, claims };
}

// One check, or several that must all pass. A passing check that is about something else (e.g. "IMG-5390 is in
// result.md" for "nothing was guessed") proves nothing.
function runChecks(list, criterion, cwd, ctx, claimed) {
  if (list.length > 1 && list.some(c => c?.type === 'stayed_inside')) return { status: 'invalid', reason: 'stayed_inside 는 다른 확인과 묶지 않고 따로 낸다' };
  const proofs = [];
  for (const [i, check] of list.entries()) {
    const at = list.length > 1 ? `${i + 1}번째 확인: ` : '';
    const r = check && typeof check === 'object' ? runCheck(check, cwd, ctx) : { status: 'invalid', reason: '잘못된 확인' };
    if (r.status !== 'pass') return { ...r, reason: `${at}${r.reason ?? ''}` };
    proofs.push(r.proof.replace(/^엔진 확인 · /, ''));
  }
  // Every check must pass, so a set is at least as strong as the one about the criterion; a technical extra
  // (an id, a class name) need not share its words (seen in a real run: id="total-ratio" spoiled a proven set).
  if (claimed && !list.some(c => relatesTo(c, criterion))) return { status: 'unrelated', reason: `${proofs.join(' / ')} — 이 조건과 관련 없는 검사라 근거로 치지 않음` };
  return { status: 'pass', proof: `엔진 확인 · ${proofs.join(' / ')}` };
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
  if (check.type === 'stayed_inside') return BOUNDARY_TOPIC.test(c);
  if (check.type === 'file_updated') return /회차|갱신|새로|update/.test(c);
  if (check.type === 'document_made') {
    return namesFile(c, check.path) || (check.text && words(check.text).some(w => mentions(c, w))) || DOCUMENT_TOPIC.test(c);
  }
  if (check.type === 'source_contains') {
    return words(check.text).some(w => mentions(c, w)) || (check.path ? namesFile(c, check.path) && !CLAIMS_ABSENCE.test(c) : SOURCE_TOPIC.test(c));
  }
  if (check.type === 'file_unchanged') return UNCHANGED_WORDS.test(c);
  if (check.type === 'file_exists') return words(String(check.path).replace(/\\/g, '/')).some(w => mentions(c, w));
  // (also "a check that opens the page in a real browser": the engine's own check is exactly that)
  if (check.type === 'screen_ok') return /화면|모바일|레이아웃|넘침|깨진|브라우저|렌더링|헤드리스|screen|layout|browser|render|headless/.test(c);
  if (check.type === 'file_excludes') {
    return ABSENCE.test(c) && ((check.texts ?? []).some(t => words(t).some(w => mentions(c, w)) || c.includes(String(t).toLowerCase())) || namesFile(c, check.path));
  }
  // a data check speaks to a criterion that names the file (or JSON) and does not claim an absence
  if (check.type === 'json_shape') return (namesFile(c, check.path) || /json/.test(c)) && !/없[다고음]$/.test(c.trim());
  // "only these files": every listed file (or the folder) is named in the criterion
  if (check.type === 'folder_only') {
    return Array.isArray(check.files) && check.files.length > 0 && check.files.every(f => c.includes(path.basename(String(f)).toLowerCase()))
      && /만\s|만$|only|외에|밖에/.test(c);
  }
  if (check.type === 'file_contains') {
    if (words(check.text).some(w => mentions(c, w))) return true;
    // A value the work had to find (a version, a total) cannot appear in the criterion itself: a check still counts
    // when the criterion names the file it reads — unless the criterion claims an absence ("추측이 없다"), which text
    // that is present can never prove.
    return namesFile(c, check.path) && !CLAIMS_ABSENCE.test(c);
  }
  return false;
}
const DOCUMENT_TOPIC = /문서|hwpx|한글 파일|보고서|기안|서식|계획서|회의록|보도자료|통지/;
const SOURCE_TOPIC =/출처|원문|공식|source|official/;
const CLAIMS_ABSENCE =/없[다고으음이는었]|않[았는다고음]|아니[다고]|금지|no |never|without/;
// file_excludes speaks only to a criterion that claims an absence ("…없이", "쓰지 않는다", "금지").
const ABSENCE = /없[다고으음이는었이]|않[았는다고음]|아니[다고]|금지|제외|no |never|without|free/;
const namesFile = (criterion, file) => {
  const base = path.basename(String(file ?? '').replace(/\\/g, '/')).toLowerCase();
  return base.length >= 3 && criterion.includes(base);
};

const BOUNDARY_TOPIC = /폴더\s*밖|바깥|금지된?\s*설정|설정\s*파일|비밀\s*정보|outside|secret/;
// Words of a criterion that stayed_inside does not speak to (reading, guessing, accuracy, …).
const BOUNDARY_STEMS = ['작업', '폴더', '밖', '바깥', '파일', '비밀', '정보', '기록', '금지', '설정', '생성', '건드', '수정', '쓰', '만들', '없', '않', '바꾸', '변경'];
const GLUE = new Set(['및', '또는', '그리고', '전혀', '하나도', '모두', '어떤', '아무']);
const beyondBoundary = criterion => (String(criterion).match(/[가-힣]+|[a-zA-Z0-9]+/g) ?? [])
  .filter(w => !GLUE.has(w) && !BOUNDARY_STEMS.some(stem => w.startsWith(stem)) && !/^(outside|secrets?|files?|no|none)$/i.test(w));

function runCheck(check, cwd, ctx = {}) {
  if (check?.type === 'stayed_inside') return ctx.boundary ? ctx.boundary() : { status: 'invalid', reason: '엔진 기록을 볼 수 없음' };
  if (check?.type === 'tests_pass') {
    if (!ctx.test) return ctx.verifying ? { status: 'fail', reason: '실행된 테스트 없음 (테스트 파일이 없거나 샌드박스를 쓸 수 없음)' }
      : { status: 'later', reason: '테스트는 검증 단계에서 엔진이 실행' };
    return ctx.test.passed ? { status: 'pass', proof: `엔진 확인 · 샌드박스에서 ${ctx.test.label} 통과` }
      : { status: 'fail', reason: `${ctx.test.label} 실패` };
  }
  if (check?.type === 'file_unchanged') return checkUnchanged(check, cwd, ctx.originals ?? {});
  if (check?.type === 'source_contains') return checkSource(check, cwd, ctx.sources ?? {});
  if (check?.type === 'document_made') return checkDocument(check, cwd, ctx.documents ?? {});
  if (check?.type === 'file_updated') return checkUpdated(check, cwd, ctx.baseline);
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
  if (check.type === 'screen_ok') return checkScreen(rel, ctx.visual);
  if (check.type === 'file_excludes') return checkExcludes(check, target, rel);
  if (check.type === 'json_shape') return checkJsonShape(check, target, rel);
  if (check.type === 'folder_only') return checkFolderOnly(check, target, rel);
  return { status: 'invalid', reason: '지원하지 않는 확인 방식' };
}

// json_shape: a data file the engine parses itself — valid JSON, a list of exactly `count` items, each with the named
// fields of the named kinds, and `unique` values not repeated. Seen in a real run: "menu.json has 12 items with these
// fields" had no check, so 대장 was asked to judge what a program can prove.
const FIELD_KINDS = {
  string: v => typeof v === 'string' && v.trim() !== '',
  one_line: v => typeof v === 'string' && v.trim() !== '' && !/[\r\n]/.test(v),
  number: v => typeof v === 'number' && Number.isFinite(v),
  integer: v => Number.isInteger(v),
  positive_integer: v => Number.isInteger(v) && v > 0,
  boolean: v => typeof v === 'boolean',
  array: v => Array.isArray(v),
  string_array: v => Array.isArray(v) && v.every(x => typeof x === 'string'),
  date: v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)),
};
function checkJsonShape(check, target, rel) {
  if (!existsSync(target) || !statSync(target).isFile()) return { status: 'fail', reason: `파일 ${rel} 없음` };
  if (statSync(target).size > MAX_READ) return { status: 'invalid', reason: '파일이 너무 큼' };
  let data;
  try { data = JSON.parse(readFileSync(target, 'utf8').replace(/^﻿/, '')); } catch { return { status: 'fail', reason: `${rel}이(가) 올바른 JSON이 아님` }; }
  const key = typeof check.list === 'string' && check.list ? check.list : null;
  const list = key ? data?.[key] : data;
  const where = key ? `${rel}의 ${key}` : rel;
  if (!Array.isArray(list)) return { status: 'fail', reason: `${where}이(가) 목록(배열)이 아님` };
  const done = [`올바른 JSON 목록 ${list.length}개`];
  if (check.count !== undefined) {
    if (!Number.isInteger(check.count) || check.count < 0) return { status: 'invalid', reason: '개수(count)가 잘못됨' };
    if (list.length !== check.count) return { status: 'fail', reason: `${where}의 항목이 ${list.length}개 (${check.count}개여야 함)` };
  }
  const fields = check.fields && typeof check.fields === 'object' ? Object.entries(check.fields).slice(0, 20) : [];
  for (const [name, kind] of fields) {
    const ok = FIELD_KINDS[kind];
    if (!ok) return { status: 'invalid', reason: `알 수 없는 값 종류: ${kind} (${Object.keys(FIELD_KINDS).join(', ')})` };
    const bad = list.findIndex(item => !item || typeof item !== 'object' || !ok(item[name]));
    if (bad >= 0) return { status: 'fail', reason: `${where}의 ${bad + 1}번째 항목 ${name}이(가) ${kind}가 아님` };
  }
  if (fields.length) done.push(`필드 ${fields.map(([n, k]) => `${n}(${k})`).join('·')}`);
  if (typeof check.unique === 'string' && check.unique) {
    const seen = new Set();
    for (const item of list) {
      const v = JSON.stringify(item?.[check.unique]);
      if (seen.has(v)) return { status: 'fail', reason: `${where}에 ${check.unique} 값이 겹침: ${v.slice(0, 40)}` };
      seen.add(v);
    }
    done.push(`${check.unique} 겹침 없음`);
  }
  return { status: 'pass', proof: `엔진 확인 · ${where}: ${done.join(', ')}` };
}

// file_excludes: none of these texts is in the file (letter case ignored). It proves an absence ("외부 주소가 없다")
// only for exactly the texts listed, which is why the criterion must claim an absence and name one of them.
function checkExcludes(check, target, rel) {
  const texts = (Array.isArray(check.texts) ? check.texts : []).filter(t => typeof t === 'string' && t.trim()).slice(0, 20);
  if (!texts.length) return { status: 'invalid', reason: '없어야 할 문구 목록(texts)이 없음' };
  if (!existsSync(target) || !statSync(target).isFile()) return { status: 'fail', reason: `파일 ${rel} 없음` };
  if (statSync(target).size > MAX_READ) return { status: 'invalid', reason: '파일이 너무 큼' };
  const body = readFileSync(target, 'utf8').toLowerCase();
  const found = texts.filter(t => body.includes(t.toLowerCase()));
  const shown = list => list.slice(0, 6).map(t => `“${t.length > 30 ? `${t.slice(0, 30)}…` : t}”`).join(', ');
  return found.length ? { status: 'fail', reason: `${rel}에 ${shown(found)} 있음` }
    : { status: 'pass', proof: `엔진 확인 · ${rel}에 ${shown(texts)} 없음` };
}

// screen_ok: the engine's own 화면 검사 of this step (visual-check.js) captured the page at both widths and found
// nothing plainly broken. Only the engine's run counts; a capture a team made or described does not.
function checkScreen(rel, visual) {
  if (!visual || !['pass', 'found'].includes(visual.status)) return { status: 'fail', reason: '이번 단계에 엔진 화면 검사가 실행되지 않음' };
  const shots = (visual.screenshots ?? []).filter(s => s.file === rel);
  if (!shots.some(s => s.width >= 1000) || !shots.some(s => s.width < 600)) return { status: 'fail', reason: `${rel}의 PC·모바일 캡처가 없음` };
  const broken = (visual.details ?? []).filter(d => d.startsWith(`${rel} (`) && SCREEN_BROKEN.test(d));
  return broken.length ? { status: 'fail', reason: `화면 검사: ${broken.slice(0, 3).join(' · ')}` }
    : { status: 'pass', proof: `엔진 확인 · ${rel} 화면 검사 (PC ${shots.find(s => s.width >= 1000).width}px · 모바일 ${shots.find(s => s.width < 600).width}px) 깨진 곳 없음` };
}
const SCREEN_BROKEN = /가로 넘침|깨진 이미지|JavaScript 실행 오류|보이는 글이 없음|거의 보이지 않는 글/;

// folder_only: the folder holds exactly these files (at any depth), nothing more and nothing missing.
function checkFolderOnly(check, target, rel) {
  const want = (Array.isArray(check.files) ? check.files : []).map(f => String(f).replace(/\\/g, '/').replace(/^\.\//, ''));
  if (!want.length || want.length > 50) return { status: 'invalid', reason: '확인할 파일 목록이 없음' };
  if (!existsSync(target) || !statSync(target).isDirectory()) return { status: 'fail', reason: `폴더 ${rel} 없음` };
  const have = [];
  const walk = (dir, prefix) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (have.length > 500) return;
      const r = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r); else have.push(r);
    }
  };
  walk(target, '');
  const extra = have.filter(f => !want.includes(f)), missing = want.filter(f => !have.includes(f));
  if (extra.length || missing.length) {
    return { status: 'fail', reason: `폴더 ${rel}${extra.length ? ` · 더 있는 파일: ${extra.slice(0, 5).join(', ')}` : ''}${missing.length ? ` · 없는 파일: ${missing.slice(0, 5).join(', ')}` : ''}` };
  }
  return { status: 'pass', proof: `엔진 확인 · 폴더 ${rel}에 ${want.join(', ')}만 있음` };
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

// sources: { "sources/x.txt": { url, sha, fetchedAt } } — originals the engine saved (web-sources.js). A file the engine
// did not save, or one changed since, proves nothing.
function checkSource(check, cwd, sources) {
  if (typeof check.text !== 'string' || !check.text) return { status: 'invalid', reason: '확인할 문구가 없음' };
  const target = insideWorkspace(check.source, cwd);
  if (!target) return { status: 'invalid', reason: '작업 폴더 밖이거나 잘못된 원문 경로' };
  const rel = path.relative(cwd, target).replace(/\\/g, '/');
  const rec = sources[rel];
  if (!rec) return { status: 'invalid', reason: `${rel}은(는) 엔진이 저장한 원문이 아님` };
  if (!existsSync(target) || !statSync(target).isFile()) return { status: 'fail', reason: `원문 ${rel} 없어짐` };
  const content = readFileSync(target);
  if (createHash('sha256').update(content).digest('hex') !== rec.sha) return { status: 'fail', reason: `원문 ${rel}이(가) 저장 뒤 바뀜` };
  const shown = check.text.length > 60 ? `${check.text.slice(0, 60)}…` : check.text;
  if (!content.toString('utf8').includes(check.text)) return { status: 'fail', reason: `원문(${rec.url})에 “${shown}” 없음` };
  if (check.path) {
    const other = runCheck({ type: 'file_contains', path: check.path, text: check.text }, cwd);
    if (other.status !== 'pass') return other;
    return { status: 'pass', proof: `엔진 확인 · ${check.path}의 “${shown}”이(가) 원문(${rec.url}, ${rec.fetchedAt.slice(0, 10)} 저장)에도 있음` };
  }
  return { status: 'pass', proof: `엔진 확인 · 원문(${rec.url}, ${rec.fetchedAt.slice(0, 10)} 저장)에 “${shown}” 있음` };
}

// baseline: { "file": sha } the engine recorded when a routine round started (routines.js). A file counts as updated
// this round when it is new or its content differs from that record.
function checkUpdated(check, cwd, baseline) {
  if (!baseline) return { status: 'invalid', reason: '반복 실행 회차가 아니라 비교할 시작 기록이 없음' };
  const target = insideWorkspace(check.path, cwd);
  if (!target) return { status: 'invalid', reason: '작업 폴더 밖이거나 잘못된 경로' };
  const rel = path.relative(cwd, target).replace(/\\/g, '/');
  if (!existsSync(target) || !statSync(target).isFile()) return { status: 'fail', reason: `파일 ${rel} 없음` };
  const now = createHash('sha256').update(readFileSync(target)).digest('hex');
  if (baseline[rel] === now) return { status: 'fail', reason: `${rel}이(가) 이번 회차 시작 때와 같음 (갱신 안 됨)` };
  return { status: 'pass', proof: `엔진 확인 · ${rel}이(가) 이번 회차에 ${baseline[rel] ? '새로 바뀜' : '새로 생김'}` };
}

// documents: { "x.hwpx": { from, preset, sha, validated, lint, readback: { path, sha } } } — what the engine made
// (doc-convert.js make). Only an engine-made, structure-checked, unchanged document counts.
function checkDocument(check, cwd, documents) {
  const target = insideWorkspace(check.path, cwd);
  if (!target) return { status: 'invalid', reason: '작업 폴더 밖이거나 잘못된 경로' };
  const rel = path.relative(cwd, target).replace(/\\/g, '/');
  const rec = documents[rel];
  if (!rec) return { status: 'invalid', reason: `${rel}은(는) 엔진이 만든 문서가 아님` };
  const hash = p => createHash('sha256').update(readFileSync(path.join(cwd, p))).digest('hex');
  if (!existsSync(target)) return { status: 'fail', reason: `${rel} 없어짐` };
  if (hash(rel) !== rec.sha) return { status: 'fail', reason: `${rel}이(가) 엔진이 만든 뒤 바뀜` };
  if (!rec.validated) return { status: 'fail', reason: `${rel} 구조 검증 실패 (한컴오피스에서 안 열릴 수 있음)` };
  let found = '';
  if (typeof check.text === 'string' && check.text) {
    const back = rec.readback;
    if (!back || !existsSync(path.join(cwd, back.path)) || hash(back.path) !== back.sha) return { status: 'invalid', reason: '문서를 다시 읽은 기록이 없거나 바뀜' };
    const shown = check.text.length > 60 ? `${check.text.slice(0, 60)}…` : check.text;
    if (!readFileSync(path.join(cwd, back.path), 'utf8').includes(check.text)) return { status: 'fail', reason: `${rel}에 “${shown}” 없음` };
    found = ` · 문서에 “${shown}” 있음`;
  }
  const lint = rec.lint ? ` · 표기법 검수 오류 ${rec.lint.errors}·경고 ${rec.lint.warnings}` : '';
  return { status: 'pass', proof: `엔진 확인 · ${rel} (${rec.preset} 서식, ${rec.from}에서 엔진이 만듦) 구조 검증 통과${found}${lint}` };
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
      if (['.git', 'node_modules', '.hq-screens'].includes(entry.name) || entry.isSymbolicLink()) continue;
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
      if (['.git', 'node_modules', '.hq-screens'].includes(entry.name) || entry.isSymbolicLink()) continue;
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

// stayed_inside, from the engine's own records only (never the tool's word):
// - every step of the goal ran under a write guard the engine set: Claude with the Sentinel hook and file tools only
//   (no shell), Codex in its own sandbox (read-only or workspace-write);
// - the Sentinel log for these steps: writes it allowed (all inside the folder) and attempts it blocked;
// - the folder now holds no forbidden settings file, no link, and no secret-looking text.
// runs: this goal's run records (checkpoint.guard is saved when a step starts).
export function boundaryCheck({ runs = [], sentinelLog = null, project = null, cwd }) {
  const steps = runs.filter(r => r.checkpoint && !r.simulated);
  if (!steps.length) return { status: 'invalid', reason: '확인할 실행 기록이 없음' };
  const unguarded = steps.filter(r => !r.checkpoint.guard);
  if (unguarded.length) return { status: 'invalid', reason: `${unguarded.map(r => r.round).join(', ')}번째 단계는 쓰기 제한 기록이 없음 (이 확인 방식이 생기기 전 실행)` };
  const open = steps.filter(r => r.checkpoint.guard.by === 'none');
  if (open.length) return { status: 'fail', reason: `${open.map(r => r.round).join(', ')}번째 단계는 감시 에이전트 없이 실행됨` };
  const since = steps.map(r => r.startedAt).filter(Boolean).sort()[0] ?? '';
  let log = [];
  if (steps.some(r => r.checkpoint.guard.by === 'sentinel')) {
    try { log = readFileSync(sentinelLog, 'utf8').split('\n').flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } }); }
    catch { return { status: 'invalid', reason: '감시 에이전트 기록을 읽을 수 없음' }; }
    log = log.filter(e => e.project === project && e.at >= since && WRITE_TOOLS.includes(e.tool));
  }
  const written = log.filter(e => e.decision === 'allow').length, blocked = log.filter(e => e.decision !== 'allow').length;
  const found = { forbidden: [], links: [], secrets: [] };
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name), rel = path.relative(cwd, full).replace(/\\/g, '/');
      if (FORBIDDEN_NAMES.test(entry.name)) { found.forbidden.push(rel); continue; }
      if (entry.isSymbolicLink()) { found.links.push(rel); continue; }
      if (entry.name === 'node_modules') continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && statSync(full).size <= MAX_READ && hasSecret(readFileSync(full, 'utf8'))) found.secrets.push(rel);
    }
  };
  walk(cwd);
  if (found.forbidden.length) return { status: 'fail', reason: `금지된 설정 파일이 있음 · ${found.forbidden.slice(0, 5).join(', ')}` };
  if (found.links.length) return { status: 'fail', reason: `작업 폴더 안에 바로가기(링크)가 있음 · ${found.links.slice(0, 5).join(', ')}` };
  if (found.secrets.length) return { status: 'fail', reason: `비밀정보 형식이 있는 파일 · ${found.secrets.slice(0, 5).join(', ')}` };
  const by = kind => steps.filter(r => r.checkpoint.guard.by === kind).length;
  const parts = [];
  if (by('sentinel')) parts.push(`Claude ${by('sentinel')}단계: 파일 도구만 쓰고 셸 없음, 감시 에이전트가 쓰기 ${written}번 모두 작업 폴더 안으로 확인${blocked ? ` · 막은 쓰기 ${blocked}번` : ''}`);
  const codex = by('codex-read-only') + by('codex-workspace-write');
  if (codex) parts.push(`Codex ${codex}단계: Codex 자체 샌드박스 (읽기 전용 ${by('codex-read-only')} · 작업 폴더·임시 폴더 쓰기 ${by('codex-workspace-write')})`);
  return { status: 'pass', proof: `엔진 확인 · ${steps.length}단계 모두 엔진이 정한 쓰기 제한 아래 실행됨 (${parts.join(' / ')}) · 금지된 설정 파일·링크·비밀정보 형식 없음 · 읽기는 확인 범위 밖` };
}
