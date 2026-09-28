import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PersistentStore } from '../src/persistent-store.js';
import { GoalScheduler } from '../src/scheduler.js';

const MIN = 60_000, HOUR = 60 * MIN;
const T0 = Date.parse('2026-09-28T00:00:00Z');
const fakeClock = () => ({ t: T0, now() { return this.t; } });
const tempDir = () => mkdtempSync(path.join(tmpdir(), 'hq-sched-'));
const flush = () => new Promise(resolve => setImmediate(resolve));
const netError = () => Object.assign(new Error('ECONNRESET'), { kind: 'network' });

function setup(runner, dataDir = tempDir()) {
  const store = new PersistentStore({ dataDir });
  const clock = fakeClock();
  const calls = [];
  const scheduler = new GoalScheduler({ store, clock, runner: { run: async (goal, run) => { calls.push(run); return runner(goal, run, calls.length); } } });
  return { store, clock, calls, scheduler, dataDir };
}
const goalInput = (extra = {}) => ({ projectId: 'sample', kind: 'research', objective: 'Survey options', completionCriteria: ['Report written', 'Sources cited'], ...extra });

test('goal requires objective, known kind and completion criteria', () => {
  const { scheduler, store } = setup(() => ({}));
  assert.throws(() => scheduler.addGoal(goalInput({ completionCriteria: [] })), /completion criteria/);
  assert.throws(() => scheduler.addGoal(goalInput({ kind: 'forever' })), /kind/);
  const goal = scheduler.addGoal(goalInput());
  assert.equal(goal.status, 'scheduled');
  assert.equal(goal.round, 0);
  assert.equal(goal.nextRunAt, new Date(T0).toISOString());
  store.close();
});

test('verified goal stops repeating', async () => {
  const { scheduler, store, clock, calls } = setup(() => ({ outcome: 'completed',
    evidence: [{ criterion: 'Report written', proof: 'docs/report.md' }, { criterion: 'Sources cited', proof: '12 links' }] }));
  const goal = scheduler.addGoal(goalInput());
  await scheduler.tick();
  assert.equal(store.getGoal(goal.id).status, 'verified');
  assert.equal(store.getGoal(goal.id).nextRunAt, null);
  clock.t += 48 * HOUR; await scheduler.tick();
  assert.equal(calls.length, 1);
  store.close();
});

test('evidence missing for a criterion is not verification', async () => {
  const { scheduler, store } = setup(() => ({ outcome: 'completed', evidence: [{ criterion: 'Report written', proof: 'docs/report.md' }, { criterion: 'Sources cited', proof: '' }] }));
  const goal = scheduler.addGoal(goalInput());
  await scheduler.tick();
  assert.equal(store.getGoal(goal.id).status, 'scheduled');
  store.close();
});

test('research repeats every 6h and improvement every 24h', async () => {
  const { scheduler, store, clock, calls } = setup((goal, run) => ({ outcome: 'completed', diffHash: `${goal.id}-${run.round}` }));
  const research = scheduler.addGoal(goalInput());
  const improvement = scheduler.addGoal(goalInput({ kind: 'improvement', projectId: 'other' }));
  await scheduler.tick();
  assert.equal(store.getGoal(research.id).nextRunAt, new Date(T0 + 6 * HOUR).toISOString());
  assert.equal(store.getGoal(improvement.id).nextRunAt, new Date(T0 + 24 * HOUR).toISOString());
  clock.t = T0 + 6 * HOUR - 1; await scheduler.tick();
  assert.equal(calls.length, 2);
  clock.t = T0 + 6 * HOUR; await scheduler.tick();
  assert.equal(calls.length, 3);
  assert.equal(store.getGoal(research.id).round, 2);
  assert.equal(store.getGoal(improvement.id).round, 1);
  store.close();
});

test('network errors retry after 1/5/15 minutes then require review', async () => {
  const { scheduler, store, clock, calls } = setup(() => { throw netError(); });
  const goal = scheduler.addGoal(goalInput());
  await scheduler.tick();
  for (const delay of [1, 5, 15]) {
    const g = store.getGoal(goal.id);
    assert.equal(g.status, 'retry_wait');
    assert.equal(g.nextRunAt, new Date(clock.t + delay * MIN).toISOString());
    clock.t += delay * MIN - 1; await scheduler.tick();
    clock.t += 1; await scheduler.tick();
  }
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map(c => c.round), [1, 1, 1, 1]);
  assert.deepEqual(calls.map(c => c.attempt), [0, 1, 2, 3]);
  assert.equal(store.getGoal(goal.id).status, 'review_required');
  assert.equal(store.getGoal(goal.id).reason, 'network_retries_exhausted');
  store.close();
});

for (const kind of ['auth', 'limit', 'permission']) {
  test(`${kind} errors block without retry`, async () => {
    const { scheduler, store, clock, calls } = setup(() => ({ outcome: 'error', errorKind: kind, message: 'denied' }));
    const goal = scheduler.addGoal(goalInput());
    await scheduler.tick();
    clock.t += 48 * HOUR; await scheduler.tick();
    assert.equal(calls.length, 1);
    assert.equal(store.getGoal(goal.id).status, 'blocked');
    assert.equal(store.getGoal(goal.id).reason, `${kind}_error`);
    store.close();
  });
}

test('test failures get at most two fix rounds', async () => {
  const { scheduler, store, calls } = setup((goal, run) => ({ outcome: 'test_failed', diffHash: `diff-${run.round}` }));
  const goal = scheduler.addGoal(goalInput());
  for (let i = 0; i < 5; i++) await scheduler.tick();
  assert.equal(calls.length, 3);
  assert.equal(store.getGoal(goal.id).status, 'review_required');
  assert.equal(store.getGoal(goal.id).reason, 'test_fix_exhausted');
  store.close();
});

test('three rounds without real progress require review; log growth is not progress', async () => {
  const { scheduler, store, clock, calls } = setup((goal, run, n) => ({ outcome: 'completed', diffHash: 'same',
    log: 'x'.repeat(n * 100), evidence: [{ criterion: 'Report written', proof: 'draft' }] }));
  const goal = scheduler.addGoal(goalInput());
  for (let i = 0; i < 6; i++) { await scheduler.tick(); clock.t += 6 * HOUR; }
  // Round 1 is progress (first criterion met, first diff); rounds 2-4 repeat the same state.
  assert.equal(calls.length, 4);
  assert.equal(store.getGoal(goal.id).status, 'review_required');
  assert.equal(store.getGoal(goal.id).reason, 'no_progress');
  store.close();
});

test('same goal round cannot be claimed twice, even by two schedulers', async () => {
  const releases = [];
  const { scheduler, store, calls, dataDir } = setup(() => new Promise(resolve => releases.push(resolve)));
  const goal = scheduler.addGoal(goalInput());
  const other = setup(() => new Promise(resolve => releases.push(resolve)), dataDir);
  other.clock.t = T0;
  scheduler.tick(); scheduler.tick(); other.scheduler.tick();
  await flush();
  assert.equal(calls.length + other.calls.length, 1);
  assert.equal(store.listRuns(goal.id).length, 1);
  assert.throws(() => store.insertRun({ id: 'dup', goalId: goal.id, round: 1, attempt: 0 }), /UNIQUE/);
  releases.forEach(resolve => resolve({ outcome: 'completed' }));
  await flush();
  store.close(); other.store.close();
});

test('restart marks interrupted goal for recovery and does not auto-resume', async () => {
  const first = setup(() => new Promise(() => {}));
  const goal = first.scheduler.addGoal(goalInput());
  first.scheduler.tick(); await flush();
  assert.equal(first.store.getGoal(goal.id).status, 'running');
  first.store.close();

  const second = setup(() => ({ outcome: 'completed', diffHash: 'after-restart' }), first.dataDir);
  assert.equal(second.store.getGoal(goal.id).status, 'recovery_required');
  assert.equal(second.store.listRuns(goal.id)[0].status, 'interrupted');
  second.clock.t += 48 * HOUR; await second.scheduler.tick();
  assert.equal(second.calls.length, 0);
  second.scheduler.resume(goal.id);
  await second.scheduler.tick();
  assert.equal(second.calls.length, 1);
  assert.equal(second.calls[0].round, 2);
  second.store.close();
});
