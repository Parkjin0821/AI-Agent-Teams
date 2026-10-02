import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PersistentStore } from '../src/영구저장소.js';
import { GoalScheduler } from '../src/작업스케줄러.js';
import { DEFAULT_POLICY } from '../src/정책.js';
import { ProjectWorkspaces } from '../src/작업공간.js';
import { FRESH_CRITERION, Routines } from '../src/반복작업.js';
import { verifyReport } from '../src/완료근거.js';

// Monday 2026-09-28 08:00 local
const MON_8 = new Date(2026, 8, 28, 8, 0, 0).getTime();
function setup() {
  const store = new PersistentStore({ dataDir: mkdtempSync(path.join(tmpdir(), 'hq-rt-')) });
  const clock = { t: MON_8, now() { return this.t; } };
  const scheduler = new GoalScheduler({ store, clock, policy: DEFAULT_POLICY, runner: { run: async () => ({}) } });
  const workspaces = new ProjectWorkspaces(mkdtempSync(path.join(tmpdir(), 'hq-rt-ws-')));
  const routines = new Routines({ store, scheduler, workspaces, clock });
  const g = scheduler.addGoal({ projectId: 'weekly', kind: 'team', title: '주간 가격 조사', objective: '경쟁사 가격을 조사한다', completionCriteria: ['research.md에 가격표가 있다'] });
  scheduler.update(store.getGoal(g.id), { status: 'verified' });
  return { store, clock, scheduler, workspaces, routines, g };
}

test('a weekly routine starts a new round at its time, with the same criteria plus "updated this round"', async () => {
  const { store, clock, routines } = setup();
  try {
    const r = routines.set('weekly', { enabled: true, kind: 'weekly', weekday: 'mon', time: '09:00' });
    assert.equal(r.round, 0);
    assert.deepEqual(await routines.tick(), [], 'not before 09:00');
    clock.t = MON_8 + 60 * 60_000; // 09:00
    const [started] = await routines.tick();
    assert.equal(started.round, 1);
    const goal = store.getGoal(started.goalId);
    assert.deepEqual(goal.completionCriteria, ['research.md에 가격표가 있다', FRESH_CRITERION]);
    assert.match(goal.objective, /\[반복 실행 1회차 · 2026\. 9\. 28\. 09:00\]/);
    assert.equal(goal.autoRun, true);
    assert.match(goal.messages.at(-1).text, /반복 실행 1회차 시작 · 매주 월요일 09:00/);
    assert.deepEqual(await routines.tick(), [], 'once per due time');
    assert.match(routines.view('weekly').nextRunAt, /^2026-10-0[45]/, 'next Monday');
  } finally { store.close(); }
});

test('a round is skipped while the previous one is open; after the PC was off only the latest missed time runs', async () => {
  const { store, clock, routines, scheduler } = setup();
  try {
    routines.set('weekly', { enabled: true, kind: 'daily', time: '09:00' });
    clock.t = MON_8 + 60 * 60_000;
    const [first] = await routines.tick();
    clock.t += 86_400_000; // next day 09:00, round 1 still open
    const [skip] = await routines.tick();
    assert.equal(skip.skipped, true);
    assert.match(routines.get('weekly').lastResult, /건너뜀/);
    scheduler.update(store.getGoal(first.goalId), { status: 'verified' });
    clock.t += 3 * 86_400_000; // off for three days
    const runs = await routines.tick();
    assert.equal(runs.length, 1, 'one catch-up round, not three');
    assert.equal(runs[0].round, 2);
    await assert.rejects(routines.run('weekly', { manual: true }), /still open/, 'no manual round on top of an open one');
  } finally { store.close(); }
});

test('bad schedules are refused; turning it off stops rounds', async () => {
  const { store, clock, routines } = setup();
  try {
    assert.throws(() => routines.set('weekly', { enabled: true, kind: 'hourly', time: '09:00' }), /daily or weekly/);
    assert.throws(() => routines.set('weekly', { enabled: true, kind: 'daily', time: '9:00' }), /HH:MM/);
    assert.throws(() => routines.set('weekly', { enabled: true, kind: 'weekly', time: '09:00', weekday: 'monday' }), /weekday/);
    assert.throws(() => routines.set('nope', { enabled: true, kind: 'daily', time: '09:00' }), /not found/);
    routines.set('weekly', { enabled: true, kind: 'daily', time: '09:00' });
    routines.set('weekly', { enabled: false });
    clock.t = MON_8 + 2 * 86_400_000;
    assert.deepEqual(await routines.tick(), []);
  } finally { store.close(); }
});

test('file_updated proves a result file changed since the round started, never last round\'s file as is', async () => {
  const { store, clock, routines, workspaces } = setup();
  try {
    const cwd = workspaces.resolve('weekly');
    writeFileSync(path.join(cwd, 'research.md'), '지난주 가격표');
    const { goalId } = await routines.run('weekly', { manual: true });
    const goal = store.getGoal(goalId);
    const check = () => verifyReport({ criteria: [{ index: 2, done: true, check: { type: 'file_updated', path: 'research.md' } }] },
      goal.completionCriteria, cwd, { baseline: goal.routine.baseline }).claims[1];
    assert.match(check().detail, /이번 회차 시작 때와 같음/);
    writeFileSync(path.join(cwd, 'research.md'), '이번 주 가격표');
    assert.equal(check().check, 'pass');
    assert.match(check().detail, /이번 회차에 새로 바뀜/);
    assert.equal(verifyReport({ criteria: [{ index: 2, done: true, check: { type: 'file_updated', path: 'research.md' } }] }, goal.completionCriteria, cwd).claims[1].check, 'invalid', 'outside a routine round there is no start record');
  } finally { store.close(); }
});

test('the routine API saves a schedule, shows it in the engine view, and refuses a manual round on an open one', async () => {
  const { createApp } = await import('../src/앱.js');
  const root = mkdtempSync(path.join(tmpdir(), 'hq-rt-app-'));
  const app = createApp({ root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects') });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
  try {
    const g = app.scheduler.addGoal({ projectId: 'p-rt', kind: 'team', objective: '조사', completionCriteria: ['a'] });
    app.scheduler.start(g.id); // started, so it is an open round
    assert.equal((await call('PUT', '/api/projects/p-rt/routine', { enabled: true, kind: 'weekly', weekday: 'fri', time: '17:30' })).status, 200);
    const view = (await call('GET', '/api/engine')).body.projects.find(p => p.id === 'p-rt').routine;
    assert.deepEqual([view.enabled, view.label, typeof view.nextRunAt], [true, '매주 금요일 17:30', 'string']);
    assert.match((await call('POST', '/api/projects/p-rt/routine/run', {})).body.error, /still open/);
    app.scheduler.update(app.store.getGoal(g.id), { status: 'verified' });
    const run = await call('POST', '/api/projects/p-rt/routine/run', {});
    assert.deepEqual([run.status, run.body.round], [201, 1]);
    assert.equal((await call('PUT', '/api/projects/nope/routine', { enabled: true, kind: 'daily', time: '09:00' })).status >= 400, true);
  } finally { await app.close(); }
});

// 2026-10-02 real test: a routine set on a project 대장 had just made (never started) fired at 09:48 and was skipped as
// "이전 회차가 아직 진행 중 (00:48)" — nothing had run, and the time was UTC.
test('a never-started project is taken over by the first round, not skipped; skip notes show local time', async () => {
  const store = new PersistentStore({ dataDir: mkdtempSync(path.join(tmpdir(), 'hq-rt-')) });
  const clock = { t: MON_8, now() { return this.t; } };
  const scheduler = new GoalScheduler({ store, clock, policy: DEFAULT_POLICY, runner: { run: async () => ({}) } });
  const workspaces = new ProjectWorkspaces(mkdtempSync(path.join(tmpdir(), 'hq-rt-ws-')));
  const routines = new Routines({ store, scheduler, workspaces, clock });
  try {
    const g = scheduler.addGoal({ projectId: 'fresh', kind: 'team', title: '기록', objective: '기록.md 에 한 줄을 덧붙인다', completionCriteria: ['기록.md 에 확인 줄이 있다'] });
    routines.set('fresh', { enabled: true, kind: 'daily', time: '08:03' });
    clock.t = MON_8 + 3 * 60_000;
    const [started] = await routines.tick();
    assert.equal(started.round, 1);
    assert.equal(started.goalId, g.id, 'the unstarted goal itself becomes round 1');
    assert.equal(store.listGoals().filter(x => x.projectId === 'fresh').length, 1, 'no idle goal left beside it');
    const goal = store.getGoal(g.id);
    assert.deepEqual([goal.autoRun, goal.status, goal.completionCriteria.at(-1)], [true, 'scheduled', FRESH_CRITERION]);
    assert.match(goal.objective, /^기록\.md 에 한 줄을 덧붙인다\n\n\[반복 실행 1회차 · 2026\. 9\. 28\. 08:03\]/);
    assert.ok(goal.routine.baseline);
    clock.t += 86_400_000; // round 1 started and still open: now it is a real open round
    const [skip] = await routines.tick();
    assert.equal(skip.skipped, true);
    assert.match(routines.get('fresh').lastResult, /\(2026\. 9\. 29\. 08:03\)$/, 'local time, not UTC');
    // a paused (stopped) project is still 대장's open work and is not taken over
    const h = scheduler.addGoal({ projectId: 'held', kind: 'team', objective: 'x', completionCriteria: ['a'] });
    scheduler.stop(h.id);
    await assert.rejects(routines.run('held', { manual: true }), /still open/);
  } finally { store.close(); }
});

// 2026-10-02 real test: the routine round was due at 09:55 but waited 10+ minutes, because every freed slot went to
// older projects that were due again right after each step (goals were claimed in store order).
test('the scheduler gives a free slot to the goal that has waited longest, not the oldest project', async () => {
  const store = new PersistentStore({ dataDir: mkdtempSync(path.join(tmpdir(), 'hq-rt-')) });
  const clock = { t: MON_8, now() { return this.t; } };
  const ran = [];
  const scheduler = new GoalScheduler({ store, clock, policy: { ...DEFAULT_POLICY, maxConcurrent: 1 },
    runner: { run: async (goal) => { ran.push(goal.projectId); return { outcome: 'completed', evidence: [], claims: [] }; } } });
  try {
    const old = scheduler.addGoal({ projectId: 'older', kind: 'task', objective: 'x', completionCriteria: ['a'], autoRun: true });
    const late = scheduler.addGoal({ projectId: 'routine', kind: 'task', objective: 'y', completionCriteria: ['a'], autoRun: true });
    scheduler.update(store.getGoal(late.id), { nextRunAt: new Date(MON_8 - 10 * 60_000).toISOString() }); // due ten minutes ago
    scheduler.update(store.getGoal(old.id), { nextRunAt: new Date(MON_8 - 1_000).toISOString() }); // due again just now
    await scheduler.tick({ autoOnly: true });
    assert.deepEqual(ran, ['routine']);
  } finally { store.close(); }
});
