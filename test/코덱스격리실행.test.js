import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  BASELINE_FILE, BASELINE_KEYS, CodexIsolatedRunner, applyPlan, checkProjectFolder, hashFolder, judgePreflight, planReturn, readBaseline,
} from '../src/코덱스격리실행.js';
import { packFolder, sha256 } from '../src/작업묶음.js';
import { WSL_CONF, linuxProfileArgs, runCommand, wslCommand } from '../src/코덱스격리.js';

// Codex 격리 실행기 (대장 결정 2, 2026-10-18): 실행 전 점검 · 반환 판정 · 반영 규칙. The first part never starts WSL or Codex.
//   AGENT_HQ_CODEX_ISOLATION_TEST=wsl   live: preflight against the recorded baseline, tamper detection, two jobs at once,
//                                       return/conflict handling with a concurrent "Claude" edit (Codex's sandbox only, no model)
//   AGENT_HQ_CODEX_ISOLATION_EXEC=1     also one real codex exec job through the runner (uses subscription usage)
const LIVE = process.env.AGENT_HQ_CODEX_ISOLATION_TEST === 'wsl';
const EXEC = process.env.AGENT_HQ_CODEX_ISOLATION_EXEC === '1';
const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const temp = (prefix = 'hq-runner-') => mkdtempSync(path.join(tmpdir(), prefix));
function project(files, dir = temp()) {
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, ...rel.split('/'));
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

const GOOD = {
  wslconf: 'h1', wslconf_text: Buffer.from(WSL_CONF).toString('base64'), fstab: 'h2', root_password: 'L', uid0: 'root,', run_user: 'hqcodex:1000:1000:/home/hqcodex:/bin/bash',
  run_user_password: 'L', run_user_groups: 'hqcodex', sudo: '', sudoers: '', setuid: 'h3', windows_mounts: '0', mnt_c: '0', job_root: 'hqcodex:700',
  run_user_home: 'hqcodex:700', codex_package: 'h4', codex_launcher: 'h5', bwrap: 'h6', node: 'h7', interop_flag: 'enabled', windows_exe_ran: 'no',
  login: 'chatgpt', wslconfig_windows: 'h8', wsl_version: 'WSL 3.0.3.0',
};
const snap = (extra = {}) => ({ reachable: true, items: { ...GOOD, ...extra } });
const base = (extra = {}) => ({ items: Object.fromEntries(BASELINE_KEYS.map(k => [k, ({ ...GOOD, ...extra })[k]])) });

test('preflight: passes only when every rule holds AND nothing differs from the approved baseline', () => {
  assert.deepEqual(judgePreflight(snap(), base()), { ok: true, problems: [] });
  assert.match(judgePreflight(snap(), null).problems[0], /승인된 기준이 없다/);
  assert.equal(judgePreflight({ reachable: false, error: 'x' }, base()).ok, false);
  for (const k of BASELINE_KEYS) {
    const r = judgePreflight(snap({ [k]: 'changed' }), base());
    assert.equal(r.ok, false, k);
    assert.ok(r.problems.includes(`기준과 다름 · ${k}`), k);
  }
});

test('preflight: a baseline recorded from a broken state cannot make it pass', () => {
  const broken = [
    { windows_exe_ran: 'yes' }, { sudo: '/usr/bin/sudo' }, { sudoers: '/etc/sudoers' }, { windows_mounts: '1' }, { mnt_c: '3' }, { root_password: 'P' },
    { uid0: 'root,toor,' }, { run_user_groups: 'hqcodex sudo' }, { run_user_password: 'P' }, { job_root: 'hqcodex:755' }, { login: 'other' },
    { wslconf_text: Buffer.from(WSL_CONF.replace('[interop]\nenabled = false', '[interop]\nenabled = true')).toString('base64') },
  ];
  for (const b of broken) assert.equal(judgePreflight(snap(b), base(b)).ok, false, JSON.stringify(b));
});

test('project folder: the engine, a home or drive root, and folders holding protected files never go to Codex', () => {
  assert.throws(() => checkProjectFolder(os.homedir()), /홈/);
  assert.throws(() => checkProjectFolder(path.parse(ROOT).root), /홈|드라이브/);
  assert.throws(() => checkProjectFolder(ROOT), /엔진/);
  assert.throws(() => checkProjectFolder(path.dirname(ROOT)), /엔진|홈/);
  assert.throws(() => checkProjectFolder(path.dirname(ROOT), { home: 'C:\\nowhere' }), /엔진 폴더를 품은/);
  assert.throws(() => checkProjectFolder(path.join(ROOT, 'src')), /projects/);
  const withPolicy = project({ 'architecture-policy.json': '{}' });
  const fine = project({ 'a.txt': 'x' });
  try {
    assert.throws(() => checkProjectFolder(withPolicy), /보호 파일/);
    assert.equal(checkProjectFolder(fine), path.resolve(fine));
  } finally { rmSync(withPolicy, { recursive: true, force: true }); rmSync(fine, { recursive: true, force: true }); }
});

// A sent manifest, a return and the project's current state, as plain objects.
const sentOf = (files, skipped = []) => ({ hashes: Object.fromEntries(Object.entries(files).map(([p, b]) => [p, sha256(Buffer.from(b))])), skipped: skipped.map(p => ({ path: p })) });
const returnOf = files => ({ files: Object.entries(files).map(([p, b]) => ({ path: p, data: Buffer.from(b) })), dirs: [] });
const actions = plan => Object.fromEntries(plan.changes.map(c => [c.path, c.action]));

test('return plan: modify, add and delete what Codex changed; leave what it did not', () => {
  const files = { 'a.txt': 'A', 'b.txt': 'B', 'keep.txt': 'K' };
  const plan = planReturn({ sent: sentOf(files), returned: returnOf({ 'a.txt': 'A2', 'keep.txt': 'K', 'new/d.txt': 'D' }), current: sentOf(files).hashes });
  assert.deepEqual(actions(plan), { 'a.txt': 'modify', 'new/d.txt': 'add', 'b.txt': 'delete' });
  assert.equal(plan.unchanged, 1);
  assert.deepEqual([plan.conflicts, plan.rejected], [[], []]);
});

test('return plan: a file the project changed meanwhile is a conflict, never overwritten', () => {
  const files = { 'c.txt': 'C', 'gone.txt': 'G' };
  const current = { 'c.txt': sha256(Buffer.from('Claude edit')), 'gone.txt': sha256(Buffer.from('Claude edit 2')), 'late.txt': sha256(Buffer.from('L')) };
  const plan = planReturn({ sent: sentOf(files), returned: returnOf({ 'c.txt': 'Codex edit', 'late.txt': 'Codex' }), current });
  assert.deepEqual(plan.changes, []);
  assert.deepEqual(plan.conflicts.map(c => c.path).sort(), ['c.txt', 'gone.txt', 'late.txt']);
});

test('return plan: secrets, agent config, files never sent and paths outside the allowed scope are refused', () => {
  const files = { 'src/a.js': 'a', 'docs/x.md': 'x' };
  const plan = planReturn({ sent: sentOf(files, ['.env.local', 'private']), current: sentOf(files).hashes, allow: ['src'],
    returned: returnOf({ 'src/a.js': 'a2', 'docs/x.md': 'x2', '.env': 'K=1', 'id_rsa': 'k', 'private/notes.txt': 'p', 'src/b.js': 'b' }) });
  assert.deepEqual(actions(plan), { 'src/a.js': 'modify', 'src/b.js': 'add' });
  assert.deepEqual(plan.rejected.map(r => r.path).sort(), ['.env', 'docs/x.md', 'id_rsa', 'private/notes.txt'].sort());
  // Deleting outside the scope is refused too.
  const del = planReturn({ sent: sentOf(files), current: sentOf(files).hashes, allow: ['src'], returned: returnOf({ 'src/a.js': 'a' }) });
  assert.deepEqual(del.rejected.map(r => r.path), ['docs/x.md']);
  assert.deepEqual(del.changes, []);
});

test('return plan: names that are one file on Windows (case or Unicode form) are refused together', () => {
  const plan = planReturn({ sent: sentOf({}), current: {}, returned: returnOf({ 'Read.md': '1', 'read.md': '2', ['한글.txt'.normalize('NFD')]: '3', '한글.txt': '4' }) });
  assert.deepEqual(plan.changes, []);
  assert.equal(plan.conflicts.length, 4);
});

test('apply: writes through a temporary file, checks the hash after, deletes, and refuses a target changed after planning', () => {
  const dir = project({ 'a.txt': 'A', 'b.txt': 'B', 'c.txt': 'C' });
  try {
    const sent = packFolder(dir);
    const plan = planReturn({ sent, returned: returnOf({ 'a.txt': 'A2', 'c.txt': 'C2', 'n/d.txt': 'D' }), current: hashFolder(dir) });
    writeFileSync(path.join(dir, 'c.txt'), 'changed after planning');
    const r = applyPlan(dir, plan);
    assert.deepEqual(r.applied.map(a => `${a.action}:${a.path}`).sort(), ['add:n/d.txt', 'delete:b.txt', 'modify:a.txt']);
    assert.deepEqual(r.failed.map(f => f.path), ['c.txt']);
    assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'A2');
    assert.equal(readFileSync(path.join(dir, 'c.txt'), 'utf8'), 'changed after planning');
    assert.ok(!existsSync(path.join(dir, 'b.txt')));
    assert.ok(!packFolder(dir).files.some(f => f.includes('.hq-apply-')), 'no temporary file left');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('apply: a folder on the way that is a link is refused', (t) => {
  const dir = project({ 'a.txt': 'A' }), outside = temp();
  try {
    try { symlinkSync(outside, path.join(dir, 'out'), 'junction'); } catch { t.skip('links cannot be made here'); return; }
    const r = applyPlan(dir, { changes: [{ path: 'out/x.txt', action: 'add', data: Buffer.from('x'), hash: sha256(Buffer.from('x')), before: null }] });
    assert.equal(r.applied.length, 0);
    assert.match(r.failed[0].why, /링크/);
    assert.ok(!existsSync(path.join(outside, 'x.txt')));
  } finally { rmSync(path.join(dir, 'out'), { force: true, recursive: false }); rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('runner: a failed preflight stops the job before anything reaches the distro', async () => {
  const calls = [];
  const runner = new CodexIsolatedRunner({ baselineFile: path.join(temp(), 'none.json'), run: async (c) => { calls.push(c); return { code: 0, output: '' }; },
    snapshot: async () => snap() });
  const r = await runner.runJob({ projectDir: project({ 'a.txt': 'A' }), execute: async () => { throw new Error('must not run'); } });
  assert.equal(r.outcome, 'blocked');
  assert.match(r.problems.join('\n'), /승인된 기준이 없다/);
  assert.deepEqual(calls, []);
});

// ── Live (WSL, no model unless EXEC) ────────────────────────────────────────────────────────────────────────────
const skip = LIVE ? (readBaseline(BASELINE_FILE) ? false : '기준 없음: node scripts/코덱스격리-준비.mjs --record-baseline') : 'AGENT_HQ_CODEX_ISOLATION_TEST=wsl 일 때만';
const root = argv => runCommand(wslCommand({ user: 'root', argv }), { timeoutMs: 60_000 });
// Runs node <script> in the job through Codex's Linux sandbox alone (no model).
const sandboxed = script => ({ dir, run, distro, user }) => run(wslCommand({ distro, user, cwd: dir, argv: ['codex', 'sandbox', ...linuxProfileArgs('write'), '-P', 'hq', '-C', dir, '--', 'node', script] }), { timeoutMs: 120_000 });

test('live: preflight passes now, and stops on a changed wsl.conf or a planted sudo — before any job folder exists', { skip, timeout: 300_000 }, async () => {
  const runner = new CodexIsolatedRunner();
  assert.deepEqual((await runner.preflight()).problems, []);
  const saved = (await root(['base64', '-w0', '/etc/wsl.conf'])).output.trim();
  try {
    await root(['sh', '-c', 'echo "# hq tamper test" >> /etc/wsl.conf']);
    const r = await runner.preflight();
    assert.ok(r.problems.includes('기준과 다름 · wslconf'), r.problems.join('\n'));
  } finally { await root(['sh', '-c', 'printf %s "$1" | base64 -d > /etc/wsl.conf', 'sh', saved]); }
  try {
    await root(['sh', '-c', 'printf "#!/bin/sh\\nexit 0\\n" > /usr/local/bin/sudo && chmod 755 /usr/local/bin/sudo']);
    const before = (await root(['sh', '-c', `ls ${'/srv/hq/jobs'} | wc -l`])).output.trim();
    const job = await runner.runJob({ projectDir: project({ 'a.txt': 'A' }), execute: async () => { throw new Error('must not run'); } });
    assert.equal(job.outcome, 'blocked');
    assert.ok(job.problems.some(p => /sudo/.test(p)), job.problems.join('\n'));
    assert.equal((await root(['sh', '-c', 'ls /srv/hq/jobs | wc -l'])).output.trim(), before, 'no job folder was made');
  } finally { await root(['rm', '-f', '/usr/local/bin/sudo']); }
  assert.deepEqual((await runner.preflight()).problems, [], 'restored');
});

test('live: two jobs at once keep their files and results apart', { skip, timeout: 600_000 }, async (t) => {
  const runner = new CodexIsolatedRunner();
  const ids = [`c-${randomBytes(5).toString('hex')}`, `c-${randomBytes(5).toString('hex')}`];
  const work = (me, other) => [
    "const fs = require('fs');",
    `fs.writeFileSync('own-${me}.txt', '${me}');`,
    `fs.writeFileSync('shared.txt', '${me}');`,
    'const until = Date.now() + 3000; while (Date.now() < until) {}',
    `let leak = false; try { fs.readFileSync('/srv/hq/jobs/${other}/shared.txt'); leak = true; } catch {}`,
    `try { fs.writeFileSync('/srv/hq/jobs/${other}/planted.txt', 'x'); leak = true; } catch {}`,
    "fs.writeFileSync('report.json', JSON.stringify({ leak, files: fs.readdirSync('.').sort() }));",
  ].join('\n');
  const dirs = ids.map((id, i) => project({ 'shared.txt': 'start', 'work.cjs': work(id, ids[1 - i]) }));
  try {
    const results = await Promise.all(ids.map((id, i) => runner.runJob({ projectDir: dirs[i], jobId: id, execute: sandboxed('work.cjs') })));
    for (const [i, r] of results.entries()) {
      t.diagnostic(`작업 ${i + 1}: ${r.outcome} · 반영 ${JSON.stringify(r.applied?.applied?.map(a => a.path))} · 시간 ${JSON.stringify(r.timings)}`);
      assert.equal(r.outcome, 'completed', JSON.stringify(r.problems));
      const report = JSON.parse(readFileSync(path.join(dirs[i], 'report.json'), 'utf8'));
      assert.equal(report.leak, false, 'a job reached the other job');
      // Codex's sandbox shows a few masked names (.agents .aws .codex .git) as empty placeholders; they never come back.
      const seenFiles = report.files.filter(f => !['.agents', '.aws', '.codex', '.git'].includes(f));
      t.diagnostic(`작업 ${i + 1} 안에서 본 목록: ${JSON.stringify(report.files)}`);
      assert.deepEqual(seenFiles, [`own-${ids[i]}.txt`, 'shared.txt', 'work.cjs']);
      assert.equal(readFileSync(path.join(dirs[i], 'shared.txt'), 'utf8'), ids[i]);
      assert.ok(!existsSync(path.join(dirs[i], `own-${ids[1 - i]}.txt`)) && !existsSync(path.join(dirs[i], 'planted.txt')));
    }
    assert.equal((await root(['sh', '-c', `ls /srv/hq/jobs | grep -c -e ${ids[0]} -e ${ids[1]} || true`])).output.trim(), '0', 'job folders removed');
  } finally { for (const d of dirs) rmSync(d, { recursive: true, force: true }); }
});

test('live: what comes back is checked, conflicts keep the other step\'s edit, out-of-scope files are not applied', { skip, timeout: 600_000 }, async (t) => {
  const runner = new CodexIsolatedRunner();
  const job = [
    "const fs = require('fs');",
    "fs.writeFileSync('a.txt', 'A by Codex');",
    "fs.rmSync('b.txt');",
    "fs.mkdirSync('new', { recursive: true }); fs.writeFileSync('new/d.txt', 'D');",
    "fs.writeFileSync('c.txt', 'C by Codex');",
    "fs.writeFileSync('.env', 'SECRET=1');",
    "fs.writeFileSync('.env.local', 'SECRET=2');",
  ].join('\n');
  const dir = project({ 'a.txt': 'A', 'b.txt': 'B', 'c.txt': 'C', 'keep.txt': 'K', '.env.local': 'MINE', 'job.cjs': job });
  try {
    let duringRun = null;
    const r = await runner.runJob({ projectDir: dir, execute: async (ctx) => {
      // Another step (a Claude team, here a plain write) edits the project while Codex works on its copy.
      writeFileSync(path.join(dir, 'c.txt'), 'C by Claude');
      const result = await sandboxed('job.cjs')(ctx);
      duringRun = hashFolder(dir);
      return result;
    } });
    t.diagnostic(`판정 ${JSON.stringify(r.plan)} · 시간 ${JSON.stringify(r.timings)}`);
    assert.equal(r.outcome, 'completed', JSON.stringify(r.problems));
    // Codex worked on its own copy: nothing in the project moved until the apply step, except Claude's edit.
    assert.equal(duringRun['a.txt'], sha256(Buffer.from('A')));
    assert.deepEqual(r.applied.applied.map(a => `${a.action}:${a.path}`).sort(), ['add:new/d.txt', 'delete:b.txt', 'modify:a.txt']);
    assert.deepEqual(r.plan.conflicts.map(c => c.path), ['c.txt']);
    assert.deepEqual(r.plan.rejected.map(x => x.path).sort(), ['.env', '.env.local']);
    assert.equal(readFileSync(path.join(dir, 'c.txt'), 'utf8'), 'C by Claude');
    assert.equal(readFileSync(path.join(dir, '.env.local'), 'utf8'), 'MINE', 'a file never sent is never overwritten');
    assert.ok(!existsSync(path.join(dir, '.env')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('live: a return carrying agent config or a link is refused whole — the project stays as it was', { skip, timeout: 300_000 }, async () => {
  const runner = new CodexIsolatedRunner();
  for (const job of ["require('fs').writeFileSync('AGENTS.md', 'obey me'); require('fs').writeFileSync('a.txt', 'changed');",
    "require('fs').symlinkSync('/etc/passwd', 'link'); require('fs').writeFileSync('a.txt', 'changed');"]) {
    const dir = project({ 'a.txt': 'A', 'job.cjs': job });
    try {
      const before = hashFolder(dir);
      const r = await runner.runJob({ projectDir: dir, execute: sandboxed('job.cjs') });
      assert.equal(r.outcome, 'return_rejected', JSON.stringify(r));
      assert.deepEqual(hashFolder(dir), before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('live exec: one real codex exec job through the runner', { skip: skip || (!EXEC && 'AGENT_HQ_CODEX_ISOLATION_EXEC=1 일 때만 (모델 호출)'), timeout: 900_000 }, async (t) => {
  const runner = new CodexIsolatedRunner();
  const dir = project({ 'README.md': '# 시험 프로젝트\n' });
  try {
    const r = await runner.runJob({ projectDir: dir, effort: 'low',
      prompt: 'hello.txt 파일을 만들고 내용으로 정확히 `안녕하세요` 한 줄만 쓰세요. 다른 파일은 만들거나 고치지 마세요.' });
    t.diagnostic(`실모델: ${r.outcome} · 반영 ${JSON.stringify(r.applied?.applied)} · 판정 ${JSON.stringify(r.plan)} · 사용량 ${JSON.stringify(r.exec?.usage)} · 시간 ${JSON.stringify(r.timings)}`);
    assert.equal(r.outcome, 'completed', JSON.stringify(r.problems));
    assert.equal(readFileSync(path.join(dir, 'hello.txt'), 'utf8').trim(), '안녕하세요');
    assert.equal(readFileSync(path.join(dir, 'README.md'), 'utf8'), '# 시험 프로젝트\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
