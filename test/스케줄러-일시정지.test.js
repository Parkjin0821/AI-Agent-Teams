import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PersistentStore } from '../src/영구저장소.js';
import { GoalScheduler } from '../src/작업스케줄러.js';

const T0 = Date.parse('2026-09-28T00:00:00Z');
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup(runner) {
  const store = new PersistentStore({ dataDir: mkdtempSync(path.join(tmpdir(), 'hq-pause-')) });
  const clock = { t: T0, now() { return this.t; } };
  const calls = [];
  const scheduler = new GoalScheduler({ store, clock, runner: { run: async (goal, run) => { calls.push(run); return runner(goal, run); } } });
  const goal = scheduler.addGoal({ projectId: 'sample', kind: 'research', objective: 'Survey', completionCriteria: ['Report written'], title: '  시장 조사  ' });
  return { store, clock, calls, scheduler, goal };
}

test('goal keeps an optional display title', () => {
  const { store, goal, scheduler } = setup(() => ({}));
  assert.equal(goal.title, '시장 조사');
  assert.throws(() => scheduler.addGoal({ projectId: 'x', kind: 'research', objective: 'o', completionCriteria: ['c'], title: 'x'.repeat(101) }), /title/);
  store.close();
});

test('paused goal is not run until resumed', async () => {
  const { store, calls, scheduler, goal } = setup(() => ({ outcome: 'completed', diffHash: 'd' }));
  scheduler.pause(goal.id);
  assert.equal(store.getGoal(goal.id).status, 'paused');
  await scheduler.tick();
  assert.equal(calls.length, 0);
  scheduler.resume(goal.id);
  assert.equal(store.getGoal(goal.id).status, 'scheduled');
  await scheduler.tick();
  assert.equal(calls.length, 1);
  store.close();
});

test('pausing a running goal lets the round finish and save, then stops', async () => {
  const releases = [];
  const { store, clock, calls, scheduler, goal } = setup(() => new Promise(resolve => releases.push(resolve)));
  scheduler.tick(); await flush();
  scheduler.pause(goal.id);
  assert.equal(store.getGoal(goal.id).status, 'running', 'the running round is not interrupted');
  releases.shift()({ outcome: 'completed', diffHash: 'd1' });
  await flush(); await flush();
  assert.equal(store.listRuns(goal.id)[0].status, 'finished');
  assert.equal(store.getGoal(goal.id).status, 'paused');
  clock.t += 48 * 3_600_000; await scheduler.tick();
  assert.equal(calls.length, 1);
  store.close();
});

test('only waiting or running goals can be paused', async () => {
  const { store, scheduler, goal } = setup(() => ({ outcome: 'completed', evidence: [{ criterion: 'Report written', proof: 'r.md' }] }));
  await scheduler.tick();
  assert.equal(store.getGoal(goal.id).status, 'verified');
  assert.throws(() => scheduler.pause(goal.id), /pause/);
  store.close();
});

test('simulated rounds are marked as simulated on the run record', async () => {
  const { store, scheduler, goal } = setup(() => ({ outcome: 'completed', simulated: true }));
  await scheduler.tick();
  assert.equal(store.listRuns(goal.id)[0].simulated, true);
  store.close();
});
