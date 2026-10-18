import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CollaborationHarness, Journal, applyCopy, claudeUsage, handoffText } from '../src/협업하네스.js';
import { packFolder } from '../src/작업묶음.js';
import { hashFolder } from '../src/코덱스격리실행.js';
import { observe } from '../src/관측.js';
import { projectRecord } from '../src/작업기록.js';

// 협업 하네스: 시험 C(장애·사용량)와 기록 연동을 가짜 실행기로 확인한다. 실제 Claude·Codex 협업은 scripts/협업시험.mjs.
const temp = (p = 'hq-harness-') => mkdtempSync(path.join(tmpdir(), p));
function project(files) {
  const dir = temp('hq-harness-proj-');
  for (const [rel, body] of Object.entries(files)) { const full = path.join(dir, ...rel.split('/')); mkdirSync(path.dirname(full), { recursive: true }); writeFileSync(full, body); }
  return dir;
}
const fakeCodex = ({ ok = true, job = null, calls = [] } = {}) => ({
  distro: 'hq-codex', user: 'hqcodex',
  preflight: async () => ({ ok, trust: 'unsigned', problems: ok ? [] : ['기준과 다름 · wslconf'] }),
  runJob: async (opts) => { calls.push(opts); return job ?? { outcome: 'completed', trust: 'unsigned', plan: { changes: [], conflicts: [], rejected: [], unchanged: 1 }, applied: { applied: [], failed: [] }, exec: { code: 0, answer: '검토: 문제 없음', usage: [{ input_tokens: 10, output_tokens: 2 }] }, timings: {} }; },
  run: async (cmd) => { calls.push({ cmd }); return { code: 0, output: '' }; },
});
const fakeClaude = (result, effect = null) => ({ run: async (provider, prompt, onEvent, opts) => {
  effect?.(opts.cwd);
  onEvent({ type: 'provider.output', chunk: '{"type":"result","result":"done","usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":5}}\n' });
  return { answer: 'done', model: 'claude-sonnet-5-5', ...result };
} });

test('journal: no second start, failed work needs an explicit retry, a crash leaves "interrupted" (never re-run on its own)', () => {
  const dir = temp(), j = new Journal(path.join(dir, 'j.json'));
  try {
    j.begin('A');
    assert.throws(() => j.begin('A'), /이미 시작된/);
    j.finish('A', 'failed');
    assert.throws(() => j.begin('A'), /retry/);
    assert.equal(j.begin('A', { retry: true }).attempts, 2);
    j.finish('A', 'finished');
    assert.throws(() => j.begin('A', { retry: true }), /이미 끝난/);
    j.begin('B', { info: { jobId: 'j-1' } });
    const found = new Journal(path.join(dir, 'j.json')).recover();   // a fresh process after a crash
    assert.deepEqual(found.map(f => [f.key, f.status, f.jobId]), [['B', 'interrupted', 'j-1']]);
    assert.throws(() => j.begin('B'), /retry/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Claude usage comes from its own result event', () => {
  assert.deepEqual(claudeUsage('x\n{"type":"result","usage":{"input_tokens":1,"output_tokens":2}}\n'), { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: undefined, cache_creation_input_tokens: undefined });
  assert.equal(claudeUsage('nothing'), null);
});

test('C · Claude out of usage: the step is held safely, nothing changes, and it is not re-run without a retry', async () => {
  const dataDir = temp(), dir = project({ 'a.txt': 'A' });
  const h = new CollaborationHarness({ dataDir, claude: fakeClaude({ outcome: 'limited', errorKind: 'limit' }, cwd => writeFileSync(path.join(cwd, 'a.txt'), 'half')), codex: fakeCodex() });
  try {
    const goal = h.goal({ projectId: 'p', title: 't' });
    const r = await h.claudeStep(goal, { team: 'dev', kind: 'dev', prompt: 'x', projectDir: dir, key: 'c1' });
    assert.equal(r.outcome, 'held');
    assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'A', 'the half-done work stayed in the copy');
    assert.equal(h.journal.read().c1.status, 'held');
    await assert.rejects(h.claudeStep(goal, { team: 'dev', kind: 'dev', prompt: 'x', projectDir: dir, key: 'c1' }), /retry/);
    // Router-level hold: the usage snapshot already says limited, so the adapter is never called.
    let called = false;
    const h2 = new CollaborationHarness({ dataDir: temp(), claude: { run: async () => { called = true; } }, codex: fakeCodex(), usage: () => ({ 'claude-code': 'limited', codex: 'available' }) });
    const held = await h2.claudeStep(h2.goal({ projectId: 'p', title: 't' }), { team: 'dev', kind: 'dev', prompt: 'x', projectDir: dir, key: 'c2' });
    assert.equal(held.outcome, 'held');
    assert.equal(called, false);
    h2.close();
  } finally { h.close(); rmSync(dataDir, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
});

test('C · Codex not approved or isolation failed: the step is blocked before any job, and the block is recorded', async () => {
  const dataDir = temp(), dir = project({ 'a.txt': 'A' }), calls = [];
  const h = new CollaborationHarness({ dataDir, claude: fakeClaude({ outcome: 'completed' }), codex: fakeCodex({ ok: false, calls }) });
  try {
    const goal = h.goal({ projectId: 'p', title: 't' });
    const r = await h.codexStep(goal, { team: 'qa', kind: 'code-review', prompt: 'x', projectDir: dir, key: 'x1', access: 'read', workerExecutor: 'claude-code' });
    // The router falls back to Claude for a review when Codex is blocked; the Codex step itself does not run.
    assert.equal(r.outcome, 'blocked');
    assert.deepEqual(calls, []);
    assert.ok(h.store.recentEvents().some(e => e.type === 'codex.blocked'));
  } finally { h.close(); rmSync(dataDir, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
});

test('C · recovery after a crash: interrupted Codex jobs are cleaned up and reported, not re-run', async () => {
  const dataDir = temp(), calls = [];
  const h = new CollaborationHarness({ dataDir, claude: fakeClaude({ outcome: 'completed' }), codex: fakeCodex({ calls }) });
  try {
    h.journal.begin('k', { info: { executor: 'codex' } });
    h.journal.update('k', { jobId: 'j-dead-1234' });
    const found = await h.recover();
    assert.deepEqual(found.map(f => f.key), ['k']);
    assert.ok(calls.some(c => c.cmd?.args.includes('rm') && c.cmd.args.includes('/srv/hq/jobs/j-dead-1234')));
    assert.ok(h.store.recentEvents().some(e => e.type === 'goal.recovery_required'));
  } finally { h.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('records: runs, hand-offs, models and usage land in the same shape the engine\'s observation reads', async () => {
  const dataDir = temp(), dir = project({ 'src/a.js': 'export const a = 1;\n' });
  const h = new CollaborationHarness({ dataDir, claude: fakeClaude({ outcome: 'completed' }, cwd => writeFileSync(path.join(cwd, 'src', 'a.js'), 'export const a = 2;\n')), codex: fakeCodex() });
  try {
    const goal = h.goal({ projectId: 'harness-p', title: '협업 시험' });
    const c = await h.claudeStep(goal, { team: 'dev', kind: 'dev', prompt: 'x', projectDir: dir, key: 'k1' });
    assert.deepEqual(c.checkpoint.modified, ['src/a.js']);
    assert.equal(c.run.usage.input_tokens, 100);
    assert.equal(c.run.actualModel, 'claude-sonnet-5-5');
    const text = handoffText({ title: '협업 시험', objective: '검토', criteria: ['시험 통과'], from: 'claude', done: ['구현'], changed: c.checkpoint.modified, verification: [], next: '독립 검토', to: 'codex', reason: '교차 검토' });
    const ho = h.handoff(goal, { from: c.run, to: { team: 'qa', executor: 'codex' }, text });
    assert.match(ho.text, /Changed files: src\/a\.js/);
    const x = await h.codexStep(goal, { team: 'qa', kind: 'code-review', prompt: text, projectDir: dir, key: 'k2', access: 'read', workerExecutor: 'claude-code' });
    assert.equal(x.outcome, 'completed');
    assert.equal(x.run.executor, 'codex');
    assert.equal(x.run.isolation.backend, 'codex-wsl-isolated');
    const runs = h.store.listRuns(goal.id);
    assert.deepEqual(runs.map(r => `${r.team}:${r.executor}`), ['dev:claude-code', 'qa:codex']);
    const seen = observe({ goals: [h.store.getGoal(goal.id)], runsOf: id => h.store.listRuns(id), events: h.store.recentEvents() });
    const teams = Object.fromEntries((seen.teams ?? []).map(t => [t.team, t.steps]));
    assert.equal(teams.dev, 1);
    assert.equal(teams.qa, 1);
    const record = projectRecord(h.store, 'harness-p');
    assert.deepEqual(record.snapshot.checkpoints.map(cp => cp.executor), ['claude-code', 'codex']);
    assert.ok(h.store.recentEvents().some(e => e.type === 'team.handoff' && e.fromExecutor === 'claude-code' && e.toExecutor === 'codex'));
  } finally { h.close(); rmSync(dataDir, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
});

test('B · a Claude step in its own copy is applied with the same rules: non-conflicting files only, never an overwrite', () => {
  const dir = project({ 'src/a.js': 'A', 'CHANGELOG.md': '# 기록\n' });
  const copy = `${dir}-claude`;
  try {
    const sent = packFolder(dir);
    cpSync(dir, copy, { recursive: true });
    writeFileSync(path.join(copy, 'src', 'b.js'), 'B by Claude');
    writeFileSync(path.join(copy, 'CHANGELOG.md'), '# 기록\n- Claude\n');
    writeFileSync(path.join(dir, 'CHANGELOG.md'), '# 기록\n- Codex\n');   // the other model got there first
    const r = applyCopy({ sent, copyDir: copy, projectDir: dir });
    assert.deepEqual(r.applied.applied.map(a => a.path), ['src/b.js']);
    assert.deepEqual(r.plan.conflicts.map(c => c.path), ['CHANGELOG.md']);
    assert.equal(readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'), '# 기록\n- Codex\n');
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(copy, { recursive: true, force: true }); }
});
