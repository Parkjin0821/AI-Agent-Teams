import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { autonomyDecision, LEVELS } from '../src/자율정책.js';
import { GoalScheduler } from '../src/작업스케줄러.js';
import { PersistentStore } from '../src/영구저장소.js';
import { DEFAULT_POLICY } from '../src/정책.js';
import { createApp } from '../src/앱.js';
import { lintCriteria } from '../src/완료근거.js';

const OWN = '빵집다운 분위기다 (대장이 화면에서 확인) — 자동 검증 불가: 분위기는 취향';

test('자율 정책: the fixed table — what each level settles on its own, and what always waits for 대장', () => {
  const c = (level, extra = {}) => autonomyDecision('criteria', { level, criteria: ['index.html 파일이 있다'], ...extra }).decision;
  assert.deepEqual(LEVELS.map(l => c(l)), ['ask', 'auto', 'auto', 'auto'], 'clean, all engine-provable');
  assert.deepEqual(LEVELS.map(l => c(l, { ownerJudged: 1 })), ['ask', 'ask', 'auto', 'auto'], 'a 대장 check in the list: L1 asks');
  assert.deepEqual(LEVELS.map(l => c(l, { issues: ['남은 점'] })), ['ask', 'ask', 'ask', 'ask'], 'pre-check findings left and not yet rewritten');
  assert.deepEqual(LEVELS.map(l => c(l, { issues: ['남은 점'], rewritten: true })), ['ask', 'ask', 'ask', 'auto'], 'L3 after one rewrite');
  assert.equal(autonomyDecision('criteria', { level: 'L3', criteria: [] }).decision, 'ask');
  assert.deepEqual(LEVELS.map(l => autonomyDecision('trust', { level: l }).decision), ['ask', 'ask', 'auto', 'auto']);
  assert.deepEqual(LEVELS.map(l => autonomyDecision('web', { level: l }).decision), ['ask', 'auto', 'auto', 'auto']);
  for (const kind of ['question', 'owner_check', 'risky_connector', 'path_rule', 'external_publish', 'github', 'delete', 'payment', 'new_permission', 'policy_change']) {
    assert.ok(LEVELS.every(l => autonomyDecision(kind, { level: l }).decision === 'ask'), kind + ' always waits for 대장');
  }
  assert.equal(autonomyDecision('criteria', { level: 'L9', criteria: ['x'] }).decision, 'ask', 'an unknown level is L0');
});

test('자율 정책: a 대장 check must carry why no engine check can do it', () => {
  assert.match(lintCriteria(['빵집다운 분위기다 (대장이 화면에서 확인)'])[0], /자동 검증이 안 되는 이유/);
  assert.deepEqual(lintCriteria(['index.html 파일이 있다', OWN]), []);
});

function setup(level) {
  const store = new PersistentStore({ dataDir: mkdtempSync(path.join(tmpdir(), 'hq-auto-')) });
  const calls = [];
  let plans = 0;
  const scheduler = new GoalScheduler({ store, clock: { now: () => Date.parse('2026-10-18T09:00:00Z') }, policy: DEFAULT_POLICY, autonomy: () => level,
    trust: { required: () => 3, count: () => 0, add: () => {} },
    runner: { run: async (goal, run) => { calls.push(run.team);
      if (run.team === 'plan') return plans++ === 0 ? { outcome: 'completed', plan: { nextTask: '구현', team: 'dev', reviews: [], completionCriteria: ['index.html 파일이 있다', OWN] } }
        : { outcome: 'completed', plan: { nextTask: '구현', team: 'dev', reviews: [] } };
      if (run.team === 'dev') return { outcome: 'completed', diffHash: 'd' + calls.length, evidence: [] };
      return { outcome: 'completed' }; } } });
  const goal = scheduler.addGoal({ projectId: 'auto', kind: 'team', autoRun: true, objective: '빵집 페이지', conversation: true, completionCriteria: [] });
  return { store, scheduler, goal, calls };
}

test('자율 정책: at L2 the engine settles the criteria and lets results through, recording each; at L0 대장 is asked', async () => {
  const l2 = setup('L2');
  try {
    for (let i = 0; i < 3; i++) await l2.scheduler.runGoal(l2.goal.id);
    const g = l2.store.getGoal(l2.goal.id);
    assert.deepEqual(l2.calls, ['plan', 'plan', 'dev']);
    assert.equal(g.criteriaApprovalPending, false);
    assert.notEqual(g.reason, 'trust_review', 'no 신뢰 쌓기 stop');
    assert.ok(g.messages.some(m => /자율 L2 · 완료 조건 2개를 자동 확정 \(L2 · 사전 점검 통과\)/.test(m.text)));
    const audit = l2.store.recentEvents(50).filter(e => e.type === 'policy.auto').map(e => [e.kind, e.level]);
    assert.deepEqual(audit.reverse(), [['criteria', 'L2'], ['trust', 'L2']]);
  } finally { l2.store.close(); }
  const l0 = setup('L0');
  try {
    await l0.scheduler.runGoal(l0.goal.id);
    const g = l0.store.getGoal(l0.goal.id);
    assert.deepEqual([g.status, g.reason, g.criteriaApprovalPending], ['review_required', 'criteria_approval_required', true]);
    assert.equal(l0.store.recentEvents(50).filter(e => e.type === 'policy.auto').length, 0);
  } finally { l0.store.close(); }
  const l1 = setup('L1');
  try {
    await l1.scheduler.runGoal(l1.goal.id);
    assert.equal(l1.store.getGoal(l1.goal.id).reason, 'criteria_approval_required', 'L1 asks when a 대장 check is in the list');
  } finally { l1.store.close(); }
});

test('자율 정책: the level is set by 대장 at creation or with a confirmed change, and recorded', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hq-autoapp-'));
  const app = createApp({ root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects') });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
  try {
    const made = await call('POST', '/api/projects', { objective: '빵집 페이지', conversation: true, autonomy: 'L2' });
    assert.equal(made.status, 201);
    assert.equal(app.registry.getPolicy(`project:${made.body.projectId}`).autonomy, 'L2');
    assert.ok(app.store.getGoal(made.body.id).messages.some(m => /자율 수준 L2 · 감독형 자율/.test(m.text)));
    assert.match((await call('POST', '/api/projects', { objective: 'x', autonomy: 'L7' })).body.error, /autonomy must be/);
    assert.match((await call('PUT', `/api/projects/${made.body.projectId}/autonomy`, { level: 'L3' })).body.error, /confirmed by 대장/);
    const changed = await call('PUT', `/api/projects/${made.body.projectId}/autonomy`, { level: 'L3', confirm: true });
    assert.equal(changed.body.autonomy, 'L3');
    assert.deepEqual(app.store.recentEvents(20).filter(e => e.type === 'policy.changed').map(e => [e.from, e.to, e.by]), [['L2', 'L3', '대장']]);
    const plain = await call('POST', '/api/projects', { objective: '옛 방식', conversation: true });
    assert.equal(app.registry.getPolicy(`project:${plain.body.projectId}`).autonomy, undefined, 'no level given: the old rules');
  } finally { app.server.close(); }
});
