import test from 'node:test';
import assert from 'node:assert/strict';
import { assessUsage } from '../src/정책.js';
import { GoalScheduler } from '../src/작업스케줄러.js';
import { subscriptionCapacity } from '../src/구독안전.js';

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

test('Claude runs without a terminal reading, but every stop signal still stops it; Codex still needs fresh percentages', async () => {
  const { capacityBasis } = await import('../src/구독안전.js');
  const now = Date.now();
  const account = { subscription: true, checkedAt: new Date(now).toISOString() };
  const later = new Date(now + 3600000).toISOString();
  const win = (period, blocked) => ({ period, blocked, resetAt: later });
  const claude = extra => ({ provider: 'claude', windows: [], ...extra });
  // No terminal reading at all, and an old one within its window: Claude may run on the limit-state basis.
  assert.equal(subscriptionCapacity(account, claude({}), now, now), true);
  assert.equal(subscriptionCapacity(account, claude({ stale: true, windows: [win('five_hour', false), win('weekly', false)] }), now, now), true);
  assert.equal(capacityBasis(claude({ stale: true }), now), 'limit_status');
  // An old reading already at the stop line still stops: usage only grows inside a window.
  assert.equal(subscriptionCapacity(account, claude({ stale: true, windows: [win('five_hour', true)] }), now, now), false);
  // Near limit, over limit or paid overage reported by a team run stops.
  for (const l of [{ status: 'allowed_warning' }, { status: 'rejected' }, { status: 'allowed', usingOverage: true }]) {
    assert.equal(subscriptionCapacity(account, claude({ limitStatus: [l] }), now, now), false, JSON.stringify(l));
  }
  // Login must still be a fresh subscription login.
  assert.equal(subscriptionCapacity({ ...account, subscription: false }, claude({}), now, now), false);
  assert.equal(subscriptionCapacity({ subscription: true, checkedAt: new Date(now - 61000).toISOString() }, claude({}), now, now), false);
  // Codex has an official live query, so it keeps requiring fresh percentages.
  assert.equal(subscriptionCapacity(account, { provider: 'codex', windows: [] }, now, now), false);
  assert.equal(subscriptionCapacity(account, { provider: 'codex', stale: true, windows: [win('five_hour', false), win('weekly', false)] }, now, now), false);
  assert.equal(capacityBasis({ provider: 'codex', windows: [win('five_hour', false), win('weekly', false)] }, now), 'percent');
});