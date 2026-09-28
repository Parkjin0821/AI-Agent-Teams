import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PersistentStore } from '../src/persistent-store.js';
import { GoalScheduler } from '../src/scheduler.js';
import { ModelRegistry } from '../src/model-policy.js';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-09-28T00:00:00Z');
const flush = () => new Promise(resolve => setImmediate(resolve));
const evidence = { url: 'https://code.claude.com/docs/en/model-config', checkedAt: '2026-09-28T00:00:00Z' };

function setup(runner) {
  const store = new PersistentStore({ dataDir: mkdtempSync(path.join(tmpdir(), 'hq-sm-')) });
  const clock = { t: T0, now() { return this.t; } };
  const registry = new ModelRegistry({ store, clock });
  const calls = [];
  const scheduler = new GoalScheduler({ store, clock, registry,
    runner: { run: async (goal, run) => { calls.push(run); return runner(goal, run, calls.length); } } });
  const verify = id => registry.upsertModel({ executor: 'claude-code', id, label: id, supportEvidence: evidence, accountCheckedAt: evidence.checkedAt });
  const goal = scheduler.addGoal({ projectId: 'sample', kind: 'research', objective: 'Survey', completionCriteria: ['Report written'] });
  return { store, clock, registry, calls, scheduler, verify, goal };
}

test('goal keeps execution tool and model override separate and validated', () => {
  const { scheduler, store, goal } = setup(() => ({}));
  assert.equal(goal.executor, 'claude-code');
  assert.deepEqual(goal.modelOverride, { mode: 'inherit' });
  assert.throws(() => scheduler.addGoal({ projectId: 'x', kind: 'research', objective: 'o', completionCriteria: ['c'], executor: 'gpt' }), /executor/);
  assert.throws(() => scheduler.addGoal({ projectId: 'x', kind: 'research', objective: 'o', completionCriteria: ['c'], modelOverride: { mode: 'pinned' } }), /model/);
  store.close();
});

test('unavailable pinned model waits instead of silently switching, then runs once verified', async () => {
  const { scheduler, store, registry, calls, verify, goal } = setup(() => ({ outcome: 'completed', model: 'model-a', diffHash: 'd1' }));
  registry.setPolicy('project:sample', { mode: 'pinned', model: 'model-a' }, { by: '대장' });
  await scheduler.tick();
  assert.equal(calls.length, 0);
  assert.equal(store.getGoal(goal.id).status, 'model_wait');
  assert.equal(store.getGoal(goal.id).reason, 'pinned_model_unavailable');
  verify('model-a');
  await scheduler.tick();
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].round, calls[0].attempt, calls[0].executor, calls[0].model], [1, 0, 'claude-code', 'model-a']);
  assert.equal(store.listRuns(goal.id)[0].policyVersion, 1);
  store.close();
});

test('policy change during a run applies only from the next round; displayed model comes from the tool report', async () => {
  const releases = [];
  const { scheduler, store, registry, clock, calls, verify, goal } = setup(() => new Promise(resolve => releases.push(resolve)));
  verify('model-a'); verify('model-b');
  registry.setPolicy('project:sample', { mode: 'pinned', model: 'model-a' }, { by: '대장' });
  scheduler.tick(); await flush();
  registry.setPolicy('project:sample', { model: 'model-b' }, { by: '대장' });
  const during = scheduler.modelStatus(goal.id);
  assert.deepEqual([during.requested, during.actual, during.next, during.changePending], ['model-a', null, 'model-b', true]);

  releases.shift()({ outcome: 'completed', diffHash: 'd1' });   // tool did not report its model
  await flush(); await flush();
  assert.equal(store.getGoal(goal.id).activeModel, null);
  assert.equal(store.listRuns(goal.id)[0].actualModel, null);

  clock.t += 6 * HOUR; scheduler.tick(); await flush();
  assert.equal(calls[1].model, 'model-b');
  releases.shift()({ outcome: 'completed', model: 'model-b', diffHash: 'd2' });
  await flush(); await flush();
  assert.equal(store.getGoal(goal.id).activeModel, 'model-b');
  assert.equal(scheduler.modelStatus(goal.id).changePending, false);
  store.close();
});

test('retry state survives a model wait: the retry stays in the same round', async () => {
  const { scheduler, store, registry, clock, calls, verify, goal } = setup((g, run, n) => {
    if (n === 1) throw Object.assign(new Error('reset'), { kind: 'network' });
    return { outcome: 'completed', model: run.model, diffHash: 'd' };
  });
  await scheduler.tick();
  assert.equal(store.getGoal(goal.id).status, 'retry_wait');
  registry.setPolicy('project:sample', { mode: 'pinned', model: 'model-a' }, { by: '대장' });
  clock.t += 60_000; await scheduler.tick();
  assert.equal(store.getGoal(goal.id).status, 'model_wait');
  verify('model-a');
  await scheduler.tick();
  assert.deepEqual(calls.map(c => [c.round, c.attempt]), [[1, 0], [1, 1]]);
  store.close();
});
