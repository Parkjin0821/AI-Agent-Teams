import test from 'node:test';
import assert from 'node:assert/strict';
import { assessUsage } from '../src/policy.js';
import { GoalScheduler } from '../src/scheduler.js';
import { subscriptionCapacity } from '../src/subscription-safety.js';

test('subscription guard rejects missing/stale authentication and overage before dispatch', () => {
  const now = Date.now();
  const account = { subscription: true, checkedAt: new Date(now).toISOString() };
  const quota = { windows: ['five_hour', 'weekly'].map(period => ({ period, blocked: false, resetAt: new Date(now + 3600000).toISOString() })) };
  assert.equal(subscriptionCapacity(account, quota, now, now), true);
  assert.equal(subscriptionCapacity(null, quota, now, now), false);
  assert.equal(subscriptionCapacity({ ...account, subscription: false }, quota, now, now), false);
  assert.equal(subscriptionCapacity(account, quota, now, now + 60000), false);
  assert.equal(subscriptionCapacity(account, { ...quota, stale: true }, now, now), false);
  assert.equal(subscriptionCapacity(account, { ...quota, limitStatus: [{ usingOverage: true }] }, now, now), false);
  assert.equal(subscriptionCapacity(account, { windows: [] }, now, now), false);
});

test('all usage paths stop at twenty percent remaining in the five-hour window', () => {
  const now = Date.now();
  const windows = ['five_hour', 'weekly'].map(period => ({ period, metric: 'remaining',
    percent: period === 'five_hour' ? 20 : 50, observedAt: new Date(now).toISOString(), resetAt: new Date(now + 3600000).toISOString() }));
  assert.equal(assessUsage({ windows }, now).state, 'limited');
});

test('quota interruption preserves every team checkpoint for permitted reassignment', () => {
  const scheduler = Object.create(GoalScheduler.prototype);
  scheduler.policy = {};
  scheduler.registry = { getPolicy: () => ({ allowProviderSwitch: true }) };
  for (const step of ['plan', 'research', 'dev', 'design', 'security', 'policy', 'qa']) {
    const result = scheduler.decide({ kind: 'team', team: { step }, attempt: 0 }, { outcome: 'error', errorKind: 'limit' }, [], 0);
    assert.equal(result.status, 'model_wait', step);
  }
});

test('legacy non-development handoff uses verified capabilities and independent reviewers', () => {
  const scheduler = Object.create(GoalScheduler.prototype);
  const entry = { executor: 'codex', id: 'test-codex', tier: 2, efforts: ['medium','high'], capabilities: ['text','code'],
    supportEvidence: { url: 'https://learn.chatgpt.com/docs/models', checkedAt: '2026-09-29' }, accountCheckedAt: '2026-09-29', available: true };
  let runs = [];
  scheduler.store = { listRuns: () => runs, listEvals: () => [] };
  scheduler.registry = { getPolicy: () => ({ allowProviderSwitch: true }), catalog: () => [entry] };
  scheduler.capacity = executor => executor === 'codex';
  scheduler.capabilities = () => ({ codex: ['text','code'], 'claude-code': ['text','code','web'] });
  const goal = step => ({ id: 'g', projectId: 'p', kind: 'team', team: { step, profile: {} } });
  assert.equal(scheduler.resolveFor(goal('design')).executor, 'codex');
  assert.equal(scheduler.resolveFor(goal('research')).state, 'waiting', 'Codex cannot inherit unsupported web tools');
  runs = [{ team: 'dev', executor: 'codex', simulated: false }];
  assert.equal(scheduler.resolveFor(goal('policy')).state, 'waiting', 'worker cannot review itself after handoff');
  assert.equal(scheduler.resolveFor(goal('security')).state, 'waiting', 'legacy default Codex cannot review its own work');
  assert.equal(scheduler.resolveFor(goal('qa')).state, 'waiting', 'legacy verification cannot use the worker executor');
});
