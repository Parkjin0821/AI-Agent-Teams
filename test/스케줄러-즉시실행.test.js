import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PersistentStore } from '../src/영구저장소.js';
import { GoalScheduler } from '../src/작업스케줄러.js';
import { ModelRegistry } from '../src/모델정책.js';

const T0 = Date.parse('2026-09-28T00:00:00Z');

function setup() {
  const store = new PersistentStore({ dataDir: mkdtempSync(path.join(tmpdir(), 'hq-runnow-')) });
  const clock = { t: T0, now() { return this.t; } };
  const registry = new ModelRegistry({ store, clock });
  const calls = [];
  const scheduler = new GoalScheduler({ store, clock, registry, runner: { run: async (goal, run) => { calls.push([goal.id, run.round]); return { outcome: 'completed', diffHash: `d${calls.length}` }; } } });
  const add = (projectId) => scheduler.addGoal({ projectId, kind: 'research', objective: 'o', completionCriteria: ['c'] });
  return { store, clock, registry, calls, scheduler, add };
}

test('runGoal runs exactly one round of one goal, even before its scheduled time', async () => {
  const { store, calls, scheduler, add } = setup();
  const a = add('alpha'), b = add('beta');
  await scheduler.runGoal(a.id);
  assert.deepEqual(calls, [[a.id, 1]]);
  assert.equal(Date.parse(store.getGoal(a.id).nextRunAt) > T0, true, 'next round is 6h later');
  const run = await scheduler.runGoal(a.id);
  assert.equal(run.round, 2, 'manual run does not wait for the schedule');
  assert.deepEqual(calls.map(c => c[0]), [a.id, a.id], 'the other goal is untouched');
  assert.equal(store.getGoal(b.id).round, 0);
  store.close();
});

test('runGoal still respects pause, finished goals and model waits', async () => {
  const { store, registry, calls, scheduler, add } = setup();
  const g = add('alpha');
  scheduler.pause(g.id);
  await assert.rejects(scheduler.runGoal(g.id), /cannot run/);
  scheduler.resume(g.id);
  registry.setPolicy('project:alpha', { mode: 'pinned', model: 'unverified' }, { by: '대장' });
  assert.equal(await scheduler.runGoal(g.id), null);
  assert.equal(store.getGoal(g.id).status, 'model_wait');
  assert.equal(calls.length, 0);
  await assert.rejects(scheduler.runGoal('missing'), /cannot run/);
  store.close();
});
