import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PersistentStore } from '../src/persistent-store.js';
import { GoalScheduler } from '../src/scheduler.js';

const T0 = Date.parse('2026-09-28T00:00:00Z');
const criteria = ['README.md 파일이 있다', '팀 회의를 한다'];

function setup(result) {
  const store = new PersistentStore({ dataDir: mkdtempSync(path.join(tmpdir(), 'hq-task-')) });
  const clock = { t: T0, now() { return this.t; } };
  const calls = [];
  const scheduler = new GoalScheduler({ store, clock, runner: { run: async () => { calls.push(1); return typeof result === 'function' ? result(calls.length) : result; } } });
  const goal = scheduler.addGoal({ projectId: 'hello', kind: 'task', objective: 'README 쓰기', completionCriteria: criteria });
  return { store, clock, calls, scheduler, goal };
}
const partial = { outcome: 'completed', answer: '다 했습니다', diffHash: 'd1',
  evidence: [{ criterion: criteria[0], proof: '엔진 확인 · 파일 README.md 있음' }],
  claims: [{ criterion: criteria[0], claimed: true, check: 'pass' }, { criterion: criteria[1], claimed: true, check: 'none', note: '사람이 판단' }] };

test('a one-off task never repeats on its own: unverified criteria wait for 대장', async () => {
  const { store, clock, calls, scheduler, goal } = setup(partial);
  await scheduler.tick();
  const g = store.getGoal(goal.id);
  assert.equal(g.status, 'review_required');
  assert.equal(g.reason, 'awaiting_review');
  assert.equal(g.nextRunAt, null);
  clock.t += 7 * 24 * 3_600_000; await scheduler.tick();
  assert.equal(calls.length, 1);
  store.close();
});

test('a task whose criteria are all proven ends immediately as verified', async () => {
  const { store, scheduler, goal } = setup({ outcome: 'completed', diffHash: 'd', evidence: criteria.map(c => ({ criterion: c, proof: '엔진 확인' })) });
  await scheduler.tick();
  assert.equal(store.getGoal(goal.id).status, 'verified');
  store.close();
});

test('the answer and per-criterion claims are kept on the run (answer capped)', async () => {
  const { store, scheduler, goal } = setup({ ...partial, answer: 'x'.repeat(10_000) });
  await scheduler.tick();
  const run = store.listRuns(goal.id)[0];
  assert.equal(run.answer.length, 4000);
  assert.equal(run.claims[1].note, '사람이 판단');
  store.close();
});

test('대장 can confirm the remaining criteria; confirmations survive later rounds', async () => {
  const { store, scheduler, goal } = setup(partial);
  await scheduler.tick();
  assert.throws(() => scheduler.confirmCriterion(goal.id, '없는 조건'), /criterion/);
  scheduler.confirmCriterion(goal.id, criteria[1], '회의록 확인함');
  const g = store.getGoal(goal.id);
  assert.equal(g.status, 'verified');
  assert.match(g.evidence.find(e => e.criterion === criteria[1]).proof, /대장 확인 · 회의록 확인함/);
  store.close();
});

test('a human confirmation is kept when the task is run again', async () => {
  const { store, scheduler, goal } = setup(() => ({ outcome: 'completed', diffHash: 'd', evidence: [], claims: [] }));
  await scheduler.tick();
  scheduler.confirmCriterion(goal.id, criteria[1]);
  scheduler.resume(goal.id);
  await scheduler.runGoal(goal.id);
  const g = store.getGoal(goal.id);
  assert.deepEqual(g.evidence.map(e => e.criterion), [criteria[1]]);
  assert.equal(g.status, 'review_required');
  store.close();
});

test('research goals still repeat on their interval', async () => {
  const store = new PersistentStore({ dataDir: mkdtempSync(path.join(tmpdir(), 'hq-task-')) });
  const scheduler = new GoalScheduler({ store, clock: { now: () => T0 }, runner: { run: async () => partial } });
  const g = scheduler.addGoal({ projectId: 'r', kind: 'research', objective: 'o', completionCriteria: criteria });
  await scheduler.tick();
  assert.equal(store.getGoal(g.id).status, 'scheduled');
  assert.throws(() => scheduler.addGoal({ projectId: 'r', kind: 'forever', objective: 'o', completionCriteria: criteria }), /kind/);
  store.close();
});
