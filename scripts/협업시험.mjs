#!/usr/bin/env node
// Claude Code + Codex 실제 협업 시험 (docs/codex-격리-복원.md 15절, 대장 지시 2026-10-18). 실제 모델을 부른다 — 구독 사용량을 쓴다.
//   node scripts/협업시험.mjs              시험 A(순차 협업) + B(동시 협업) + C(작업 중 종료·복구)
//   node scripts/협업시험.mjs A|B|C       하나만
// 시험 프로젝트는 임시 폴더, 기록은 data/협업시험/<시각>/ (운영 저장소와 분리). 운영 스케줄러·서버는 건드리지 않는다.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliAgentAdapter, resolveBins } from '../src/실행어댑터.js';
import { CodexIsolatedRunner, hashFolder } from '../src/코덱스격리실행.js';
import { CollaborationHarness, handoffText } from '../src/협업하네스.js';
import { linuxProfileArgs, runCommand, wslCommand } from '../src/코덱스격리.js';

const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const which = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'ABC';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const CODEX_MODEL = 'gpt-6.1-sol';   // pinned so the run records which model did the work (the account default, 2026-10-18)

function project(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hq-collab-'));
  for (const [rel, body] of Object.entries(files)) { const full = path.join(dir, ...rel.split('/')); mkdirSync(path.dirname(full), { recursive: true }); writeFileSync(full, body); }
  return dir;
}
const BASE = {
  'package.json': JSON.stringify({ name: 'hq-collab-trial', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
  'README.md': '# 협업 시험 프로젝트\n\n시간 길이 문자열을 다루는 작은 라이브러리. 의존성 없음, Node 내장 모듈만 사용.\n',
  'CHANGELOG.md': '# 변경 기록\n',
};
const PARSE_CONTRACT = [
  'src/기간.js 에 `export function parseDuration(text)` 를 만든다. 계약:',
  '- 입력은 시(h)·분(m)·초(s) 단위 조각을 큰 단위부터 이어 붙인 문자열. 예: "1h30m" → 5400, "45s" → 45, "2h" → 7200, "1h0m5s" → 3605, "90m" → 5400. 결과는 초(정수).',
  '- 각 단위는 한 번만, h → m → s 순서로만. 숫자는 0 이상의 정수.',
  '- 문자열이 아니거나 빈 문자열, 형식이 맞지 않으면(예: "abc", "5x", "1h-2m", "30m1h", "1h1h") TypeError 를 던진다.',
].join('\n');
// The engine's acceptance tests import the trial project's files; the paths are assembled so the repository's own
// import check (test/파일이름.test.js) does not read them as imports of this script.
const SRC = file => `'./${'src'}/${file}'`;
const ACCEPT_A = `import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration } from ${SRC('기간.js')};
test('engine acceptance: parseDuration contract', () => {
  for (const [t, v] of [['1h30m', 5400], ['45s', 45], ['2h', 7200], ['1h0m5s', 3605], ['90m', 5400], ['0s', 0]]) assert.equal(parseDuration(t), v, t);
  for (const bad of ['', 'abc', '5x', '1h-2m', '30m1h', '1h1h', null, 12]) assert.throws(() => parseDuration(bad), TypeError, String(bad));
});
`;
const ACCEPT_B = ACCEPT_A + `import { formatDuration } from ${SRC('형식.js')};
import { sumDurations } from ${SRC('합계.js')};
test('engine acceptance: formatDuration and sumDurations', () => {
  assert.equal(formatDuration(5405), '1h 30m 5s');
  assert.equal(formatDuration(60), '1m');
  assert.equal(formatDuration(0), '0s');
  assert.throws(() => formatDuration(-1), RangeError);
  assert.equal(sumDurations(['1h', '30m', '45s']), 5445);
  assert.equal(sumDurations([]), 0);
  assert.throws(() => sumDurations(['1h', 'bad']), TypeError);
});
`;
const PARSE_SOURCE = `export function parseDuration(text) {
  if (typeof text !== 'string' || !text) throw new TypeError('duration must be a non-empty string');
  const m = /^(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+)s)?$/.exec(text);
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) throw new TypeError(\`invalid duration: \${text}\`);
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}
`;

function makeHarness(dataDir) {
  return new CollaborationHarness({
    dataDir,
    claude: new CliAgentAdapter({ enabled: true, bins: resolveBins(), timeoutMs: 12 * 60_000 }),
    codex: new CodexIsolatedRunner(),
    sentinel: { script: path.join(ROOT, 'scripts', '보안감시-훅.mjs') },
    codexModel: CODEX_MODEL,
  });
}
const sec = ms => `${(ms / 1000).toFixed(1)}초`;
const took = run => run?.startedAt && run?.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null;
const line = (label, r) => `${label}: ${r.outcome} · ${r.run?.team ?? '-'}/${r.run?.executor ?? '-'} · 모델 ${r.run?.actualModel ?? '-'} · ${sec(took(r.run) ?? 0)} · 사용량 ${JSON.stringify(r.run?.usage ?? null)}`
  + ` · 바뀐 파일 ${JSON.stringify([...(r.checkpoint?.added ?? []), ...(r.checkpoint?.modified ?? []), ...(r.checkpoint?.removed ?? [])])}`
  + (r.plan?.conflicts?.length || r.result?.plan?.conflicts?.length ? ` · 충돌 ${JSON.stringify((r.plan ?? r.result.plan).conflicts.map(c => c.path))}` : '');

const report = { stamp, scenarios: {} };
const log = (...a) => { console.log(...a); };

// ── 시험 A: 순차 협업 ───────────────────────────────────────────────────────────────────────────────────────────
async function scenarioA(h) {
  const dir = project(BASE);
  const goal = h.goal({ projectId: 'collab-A', title: '시험 A · parseDuration', criteria: ['엔진 인수 시험 통과'] });
  const out = { project: dir, steps: [] };
  try {
    const a1 = await h.claudeStep(goal, { team: 'dev', kind: 'dev', key: 'A1-claude-implement', projectDir: dir,
      prompt: `${PARSE_CONTRACT}\n\n그리고 test/기간.test.js 에 node:test 로 시험을 쓴다. 다른 파일은 만들지 않는다. 끝나면 무엇을 만들었는지 짧게 답한다.` });
    out.steps.push(line('A1 Claude 구현', a1)); log(out.steps.at(-1));
    if (a1.outcome !== 'completed') return { ...out, ok: false };
    const changed = [...a1.checkpoint.added, ...a1.checkpoint.modified];
    const text = handoffText({ title: goal.title, objective: 'parseDuration 구현에 대한 독립 코드 검토', criteria: goal.completionCriteria, from: 'claude', done: ['parseDuration 과 시험 작성'],
      changed, verification: ['아직 엔진 검증 전'], next: '계약 위반·경계 사례·버그를 독립적으로 찾는다 (파일은 고치지 않는다)', to: 'codex', reason: '교차 검토 (작업한 도구와 다른 도구)' });
    const ho1 = h.handoff(goal, { from: a1.run, to: { team: 'qa', executor: 'codex' }, text });
    const a2 = await h.codexStep(goal, { team: 'qa', kind: 'code-review', key: 'A2-codex-review', projectDir: dir, access: 'read', workerExecutor: 'claude-code',
      prompt: `${text}\n\n[계약]\n${PARSE_CONTRACT}\n\n지침: 파일을 고치거나 만들지 말고 읽기만 한다. src/기간.js 와 test/기간.test.js 를 검토해 계약 위반, 빠진 경계 사례, 버그를 찾는다.`
        + ' 답의 마지막에 JSON 한 덩어리만: {"verdict":"pass"|"changes","issues":[{"file":"","problem":"","fix":""}]}' });
    out.steps.push(line('A2 Codex 독립 검토', a2)); log(out.steps.at(-1));
    out.review = a2.answer.slice(-3000);
    if (a2.outcome !== 'completed') return { ...out, ok: false };
    const back = handoffText({ title: goal.title, objective: '독립 검토 반영', criteria: goal.completionCriteria, from: 'codex', done: ['독립 검토'], changed: [],
      verification: ['Codex 검토 결과 아래'], next: '타당한 지적만 반영한다', to: 'claude', reason: '검토 결과 전달' });
    const ho2 = h.handoff(goal, { from: a2.run, to: { team: 'dev', executor: 'claude-code' }, text: `${back}\n\n[Codex 검토]\n${a2.answer.slice(-6000)}` });
    const a3 = await h.claudeStep(goal, { team: 'dev', kind: 'dev', key: 'A3-claude-fix', projectDir: dir,
      prompt: `${back}\n\n[계약]\n${PARSE_CONTRACT}\n\n[Codex 독립 검토 결과]\n${a2.answer.slice(-6000)}\n\n위 검토에서 계약에 비춰 타당한 지적만 src/기간.js·test/기간.test.js 에 반영한다. 타당하지 않은 지적은 고치지 말고 이유를 답에 쓴다. 다른 파일은 건드리지 않는다.` });
    out.steps.push(line('A3 Claude 수정', a3)); log(out.steps.at(-1));
    const v = await h.verify(goal, { projectDir: dir, acceptance: { name: 'zz-engine-acceptance.test.mjs', source: ACCEPT_A }, key: 'A4-engine-verify' });
    out.steps.push(`A4 엔진 독립 검증: ${v.ok ? '통과' : '실패'} · 시험 파일 ${v.pass}개 통과 · 실패 ${v.fail}개`); log(out.steps.at(-1));
    // Checks the 대장 asked for.
    const runs = h.store.listRuns(goal.id);
    out.checks = {
      handoffComplete: changed.every(f => ho1.text.includes(f)) && ho2.text.includes('[Codex 검토]'),
      codexChangedNothing: !a2.checkpoint.added.length && !a2.checkpoint.modified.length && !a2.checkpoint.removed.length,
      claudeSentinelDenied: (a1.denied?.length ?? 0) + (a3.denied?.length ?? 0),
      evidenceMatchesProject: v.ok && Object.entries(v.evidence.files).every(([p, hsh]) => hashFolder(dir)[p] === hsh),
      reworkedFiles: [...(a3.checkpoint?.modified ?? [])],
      duplicateWork: (a3.checkpoint?.added ?? []).filter(f => changed.includes(f)),
      runs: runs.map(r => ({ team: r.team, executor: r.executor, model: r.actualModel, outcome: r.outcome, ms: took(r), usage: r.usage })),
    };
    out.ok = v.ok && out.checks.handoffComplete && out.checks.codexChangedNothing && out.checks.claudeSentinelDenied === 0 && out.checks.evidenceMatchesProject;
    out.finalFiles = Object.keys(hashFolder(dir));
    return out;
  } finally { out.keep = dir; }
}

// ── 시험 B: 동시 협업 ───────────────────────────────────────────────────────────────────────────────────────────
async function scenarioB(h) {
  const dir = project({ ...BASE, 'src/기간.js': PARSE_SOURCE });
  const goal = h.goal({ projectId: 'collab-B', title: '시험 B · 동시 작업 두 개', criteria: ['엔진 인수 시험 통과', '충돌 파일은 덮어쓰지 않음'] });
  const out = { project: dir, steps: [] };
  const before = hashFolder(dir);
  await h.route({ team: 'dev', kind: 'dev-complex', approvals: { complexDev: true } });   // preflight first, so both start from the same base
  const [b1, b2] = await Promise.all([
    h.claudeStep(goal, { team: 'dev', kind: 'dev', key: 'B1-claude-format', projectDir: dir,
      prompt: 'src/형식.js 에 `export function formatDuration(seconds)` 를 만든다. 0 이상의 정수 초를 "1h 30m 5s" 처럼 0이 아닌 단위만 공백으로 이어 쓴다(60 → "1m", 0 → "0s"). 음수나 정수가 아니면 RangeError. '
        + '그리고 CHANGELOG.md 끝에 "- formatDuration 추가 (Claude)" 한 줄을 더한다. 그 밖의 파일은 건드리지 않는다.' }),
    h.codexStep(goal, { team: 'dev', kind: 'dev-complex', approvals: { complexDev: true }, key: 'B2-codex-sum', projectDir: dir, access: 'write',
      prompt: 'src/합계.js 에 `export function sumDurations(texts)` 를 만든다. 문자열 배열을 받아 ./기간.js 의 parseDuration 으로 각각 초로 바꿔 더한 값을 돌려준다(빈 배열 → 0). 잘못된 항목이 있으면 parseDuration 의 TypeError 를 그대로 던진다. '
        + 'src/기간.js 는 고치지 않는다. 그리고 CHANGELOG.md 끝에 "- sumDurations 추가 (Codex)" 한 줄을 더한다. 그 밖의 파일은 건드리지 않는다.' }),
  ]);
  out.steps.push(line('B1 Claude (복사본, 동시)', b1)); log(out.steps.at(-1));
  out.steps.push(line('B2 Codex (WSL 작업 폴더, 동시)', b2)); log(out.steps.at(-1));
  const overlap = b1.run && b2.run ? Math.min(Date.parse(b1.run.finishedAt), Date.parse(b2.run.finishedAt)) - Math.max(Date.parse(b1.run.startedAt), Date.parse(b2.run.startedAt)) : 0;
  const v = await h.verify(goal, { projectDir: dir, acceptance: { name: 'zz-engine-acceptance.test.mjs', source: ACCEPT_B }, key: 'B3-engine-verify' });
  out.steps.push(`B3 엔진 독립 검증: ${v.ok ? '통과' : '실패'} · 시험 파일 ${v.pass}개 통과 · 실패 ${v.fail}개`); log(out.steps.at(-1));
  const after = hashFolder(dir);
  const conflicts = [...(b1.plan?.conflicts ?? []), ...(b2.result?.plan?.conflicts ?? [])];
  out.checks = {
    ranAtTheSameTimeMs: overlap,
    sameBase: Boolean(b1.run?.isolation?.sentDigest) && b1.run.isolation.sentDigest === b2.run?.isolation?.sentDigest,
    conflicts: conflicts.map(c => c.path),
    changelog: readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'),
    changelogWrittenOnce: (readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8').match(/추가 \((Claude|Codex)\)/g) ?? []).length === 1,
    srcFiles: Object.keys(after).filter(p => p.startsWith('src/')),
    parseUntouched: after['src/기간.js'] === before['src/기간.js'],
  };
  out.ok = v.ok && overlap > 0 && out.checks.sameBase && out.checks.conflicts.includes('CHANGELOG.md') && out.checks.changelogWrittenOnce && out.checks.parseUntouched;
  out.keep = dir;
  return out;
}

// ── 시험 C: 작업 중 엔진 종료 → 복구 → 중복 실행 방지 ───────────────────────────────────────────────────────────
async function scenarioC(dataDir) {
  const dir = project({ ...BASE, 'src/기간.js': PARSE_SOURCE });
  const before = hashFolder(dir);
  const out = { project: dir, steps: [] };
  // A child process plays the engine: it starts a Codex job (Codex's sandbox only, a long sleep) and is killed mid-way.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--crash-child', dataDir, dir], { stdio: 'ignore', windowsHide: true });
  const journal = path.join(dataDir, 'journal.json');
  let jobId = null;
  for (let i = 0; i < 120 && !jobId; i++) { await new Promise(r => setTimeout(r, 500)); try { jobId = JSON.parse(readFileSync(journal, 'utf8'))['C1-codex-long']?.jobId ?? null; } catch { /* not yet */ } }
  const listed = async () => (await runCommand(wslCommand({ user: 'root', argv: ['ls', '/srv/hq/jobs'] }))).output.split(/\s+/).filter(Boolean);
  // Wait until the job folder exists in the distro (after the child's preflight), then a little more so the job runs.
  let existedBeforeKill = false;
  for (let i = 0; i < 60 && jobId && !existedBeforeKill; i++) { await new Promise(r => setTimeout(r, 1000)); existedBeforeKill = (await listed()).includes(jobId); }
  await new Promise(r => setTimeout(r, 3000));
  spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  await new Promise(r => setTimeout(r, 3000));
  out.steps.push(`C1 엔진 프로세스 강제 종료 · 작업 ${jobId} · 종료 전 작업 폴더 있음 ${existedBeforeKill}`); log(out.steps.at(-1));
  const h = makeHarness(dataDir);
  try {
    const found = await h.recover();
    const leftover = jobId ? (await listed()).includes(jobId) : null;
    // pgrep run directly (no shell whose own command line would match the pattern); it never counts itself.
    const procs = jobId ? String((await runCommand(wslCommand({ user: 'root', argv: ['pgrep', '-f', `/srv/hq/jobs/${jobId}`] }))).output.split(/\s+/).filter(Boolean).length) : '?';
    out.steps.push(`C2 복구: 중단 표시 ${JSON.stringify(found.map(f => `${f.key}:${f.status}`))} · 작업 폴더 남음 ${leftover} · 남은 프로세스 ${procs} · 프로젝트 그대로 ${JSON.stringify(hashFolder(dir)) === JSON.stringify(before)}`); log(out.steps.at(-1));
    let refused = null;
    try { await h.codexStep(h.goal({ projectId: 'collab-C', title: '재시도' }), { team: 'qa', kind: 'verify', key: 'C1-codex-long', projectDir: dir, access: 'read', execute: async () => ({ code: 0, output: '' }) }); }
    catch (error) { refused = error.message; }
    out.steps.push(`C3 같은 작업 다시 시작: ${refused ? `거부 — ${refused}` : '실행됨 (문제)'}`); log(out.steps.at(-1));
    const retried = await h.codexStep(h.goal({ projectId: 'collab-C', title: '재시도' }), { team: 'qa', kind: 'verify', key: 'C1-codex-long', projectDir: dir, access: 'read', retry: true,
      execute: async ({ dir: jobDir, run, distro, user }) => run(wslCommand({ distro, user, cwd: jobDir, argv: ['codex', 'sandbox', ...linuxProfileArgs('read'), '-P', 'hq', '-C', jobDir, '--', 'node', '-e', 'console.log("ok")'] })) });
    out.steps.push(`C4 명시적 재시도(retry): ${retried.outcome} · 시도 ${h.journal.read()['C1-codex-long']?.attempts}`); log(out.steps.at(-1));
    out.ok = Boolean(jobId) && existedBeforeKill && found.some(f => f.key === 'C1-codex-long') && leftover === false && procs === '0' && Boolean(refused) && retried.outcome === 'completed'
      && JSON.stringify(hashFolder(dir)) === JSON.stringify(before);
    return out;
  } finally { h.close(); rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[2] === '--crash-child') {
  const [dataDir, dir] = process.argv.slice(3);
  const h = makeHarness(dataDir);
  await h.codexStep(h.goal({ projectId: 'collab-C', title: '중단될 작업' }), { team: 'qa', kind: 'verify', key: 'C1-codex-long', projectDir: dir, access: 'read',
    execute: async ({ dir: jobDir, run, distro, user }) => run(wslCommand({ distro, user, cwd: jobDir, argv: ['codex', 'sandbox', ...linuxProfileArgs('read'), '-P', 'hq', '-C', jobDir, '--', 'sleep', '120'] }), { timeoutMs: 200_000 }) });
  process.exit(0);
}

const dataDir = path.join(ROOT, 'data', '협업시험', stamp);
mkdirSync(dataDir, { recursive: true });
log(`협업 시험 시작 ${stamp} · 기록 ${dataDir}`);
const h = makeHarness(dataDir);
const pre = await h.codex.preflight();
log(`실행 전 점검: ${pre.ok ? '통과' : '실패'} · 신뢰 ${pre.trust} (서명 ${pre.signing})${pre.ok ? '' : `\n- ${pre.problems.join('\n- ')}`}`);
if (!pre.ok) process.exit(1);
try {
  if (which.includes('A')) report.scenarios.A = await scenarioA(h);
  if (which.includes('B')) report.scenarios.B = await scenarioB(h);
} finally { h.close(); }
if (which.includes('C')) report.scenarios.C = await scenarioC(path.join(dataDir, 'C'));
writeFileSync(path.join(dataDir, '결과.json'), JSON.stringify(report, null, 2));
log(`\n결과: ${Object.entries(report.scenarios).map(([k, v]) => `${k} ${v.ok ? '통과' : '실패'}`).join(' · ')}\n기록: ${path.join(dataDir, '결과.json')}`);
for (const v of Object.values(report.scenarios)) if (v.keep && existsSync(v.keep)) log(`시험 프로젝트(확인 후 지워도 됨): ${v.keep}`);
process.exit(Object.values(report.scenarios).every(v => v.ok) ? 0 : 1);
