import test from 'node:test';
import assert from 'node:assert/strict';
import { GoalScheduler } from '../src/작업스케줄러.js';
import { selectAssignment } from '../src/작업배정.js';
import { parsePlan } from '../src/팀.js';
import { enqueueRequests, normalizeRequests } from '../src/팀검토.js';
test('human criterion evidence cannot bypass team verification', () => {
  const goals = new Map();
  const runs = [];
  const store = { listGoals: () => [...goals.values()], getGoal: id => goals.get(id), saveGoal: g => (goals.set(g.id,g),g), emit: async () => {},
    listRuns: () => runs };
  const scheduler = new GoalScheduler({ store, runner: {} });
  const g = scheduler.addGoal({ kind: 'team', projectId: 'regression', objective: 'test', completionCriteria: ['checked'] });
  // Before the verification team has looked, 대장 cannot mark a team criterion done.
  assert.throws(() => scheduler.confirmCriterion(g.id, 'checked'), /verification team has not checked/);
  runs.push({ team: 'qa', status: 'finished', outcome: 'completed', simulated: true });
  assert.throws(() => scheduler.confirmCriterion(g.id, 'checked'), /verification team has not checked/, 'a simulated check does not count');
  runs.push({ team: 'qa', status: 'finished', outcome: 'completed', simulated: false });
  const confirmed = scheduler.confirmCriterion(g.id, 'checked');
  assert.notEqual(confirmed.status, 'verified');
  assert.equal(store.getGoal(g.id).confirmed.length, 1);
});
test('coding tasks require code capability even without model-declared requirements', () => {
  const catalog = [{ id: 'text', executor: 'codex', tier: 1, efforts: ['medium'], capabilities: ['text'],
    supportEvidence: { url: 'test', checkedAt: '2026-09-29' }, accountCheckedAt: '2026-09-29' }];
  assert.equal(selectAssignment({ catalog, team: 'dev', profile: { taskType: 'coding' } }).state, 'waiting');
});
test('evaluation linkage survives planning parsing', () => {
  const plan = parsePlan('AGENT_HQ_PLAN\n' + JSON.stringify({ next_task: 'work', team: 'design', evalTaskId: 'fixed-task', conditionsKey: 'fixed-conditions' }));
  assert.equal(plan.profile?.evalTaskId, 'fixed-task');
  assert.equal(plan.profile?.conditionsKey, 'fixed-conditions');
});
test('duplicate requests in the same incoming batch create one queue entry', () => {
  const r = normalizeRequests([{ team: 'dev', task: 'test', criteria: ['passes'] }], 'qa')[0];
  assert.equal(enqueueRequests([], [r,r]).length, 1);
});
