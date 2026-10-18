import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GoalScheduler } from '../src/작업스케줄러.js';
import { PersistentStore } from '../src/영구저장소.js';
import { DEFAULT_POLICY } from '../src/정책.js';
import { criterionState, engineCheckNow, objectiveCriterion } from '../src/완료근거.js';
import { buildPackage } from '../src/결과패키지.js';
import { parseTasks, startPlan } from '../src/작업계획.js';

// 완료 판정 (10차 실측 P0, 헌장 원칙 5): 회의록 was finished by 대장's confirmation with 회의록.hwpx never made. What the
// engine can check itself — a named file, its test run, the document it made — is never 대장's to stand in for.
const K = ['회의록.md 에 결정 사항 3건이 있다', '회의록.hwpx 를 엔진이 회의록 서식으로 만들었다', '문장이 공문서답게 정중하다 (대장이 확인)'];
const T0 = Date.parse('2026-10-18T09:00:00Z');

function setup(qa, { folder } = {}) {
  const store = new PersistentStore({ dataDir: mkdtempSync(path.join(tmpdir(), 'hq-done-')) });
  const cwd = folder ?? mkdtempSync(path.join(tmpdir(), 'hq-work-'));
  writeFileSync(path.join(cwd, '회의록.md'), '# 회의록\n결정 1 2 3\n');
  const calls = [];
  let plans = 0;
  const scheduler = new GoalScheduler({ store, clock: { now: () => T0 }, policy: { ...DEFAULT_POLICY, maxNoProgress: 99 }, autonomy: () => 'L2',
    trust: { required: () => 0, count: () => 0, add: () => {} },
    engineCheck: (goal, criterion) => engineCheckNow(criterion, cwd, { evidence: goal.evidence ?? [] }),
    runner: { run: async (goal, run) => {
      calls.push(run.team);
      if (run.team === 'plan') return { outcome: 'completed', plan: plans++ === 0 ? { nextTask: '회의록', team: 'dev', reviews: [] } : { allDone: true } };
      if (run.team === 'qa') return { outcome: 'completed', findings: { feedback: '', improvements: [] }, ...qa(calls.length) };
      return { outcome: 'completed', diffHash: 'd' + calls.length, evidence: [] };
    } } });
  const goal = scheduler.addGoal({ projectId: 'minutes', kind: 'team', autoRun: true, objective: '회의록', conversation: true, completionCriteria: K });
  const until = async (n, stop) => { for (let i = 0; i < n && !stop(store.getGoal(goal.id)); i++) await scheduler.runGoal(goal.id); };
  return { store, scheduler, goal, cwd, calls, until, get: () => store.getGoal(goal.id) };
}
const mdProof = { criterion: K[0], proof: '엔진 확인 · 회의록.md 에 결정', by: 'engine' };
const hwpxMissing = { criterion: K[1], check: 'fail', detail: '회의록.hwpx 없음' };

test('완료 판정: 객관적 조건과 주관적 조건 — the engine checks what names a file or its tests; 대장 judges the rest', () => {
  assert.equal(objectiveCriterion(K[0]), true);
  assert.equal(objectiveCriterion(K[1]), true);
  assert.equal(objectiveCriterion('합계 테스트가 통과한다'), true);
  assert.equal(objectiveCriterion(K[2]), false, '(대장이 확인) is 대장\'s by design');
  assert.equal(objectiveCriterion('설명이 친절하다'), false);
  // 검증 실패 · 검증 불가 · 주관적 승인 조건 are told apart
  assert.equal(criterionState(K[1], { claim: { check: 'fail' } }), 'failed');
  for (const check of ['invalid', 'later', 'unrelated']) assert.equal(criterionState(K[1], { claim: { check } }), 'unverifiable', check);
  assert.equal(criterionState(K[2], { claim: { check: 'none', person: true } }), 'subjective');
  assert.equal(criterionState('설명이 친절하다', { claim: { check: 'none', person: true } }), 'subjective');
  assert.equal(criterionState(K[1], { claim: { check: 'none', person: true } }), 'open', 'a verifier calling an objective criterion "a person\'s" does not make it so');
  assert.equal(criterionState(K[1], { proven: true }), 'proven');
});

test('완료 판정: the engine\'s own check now — a missing file fails, a present one passes, tests wait for verification', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'hq-now-'));
  assert.equal(engineCheckNow(K[1], cwd).status, 'fail');
  assert.match(engineCheckNow(K[1], cwd).detail, /회의록\.hwpx 있음 아님/);
  writeFileSync(path.join(cwd, '회의록.hwpx'), 'x');
  assert.equal(engineCheckNow(K[1], cwd).status, 'pass');
  assert.equal(engineCheckNow('합계 테스트가 통과한다', cwd).status, 'unverifiable', 'only verification runs the tests');
  assert.equal(engineCheckNow('합계 테스트가 통과한다', cwd, { evidence: [{ criterion: '합계 테스트가 통과한다', by: 'engine', test: { label: 'npm test' } }] }).status, 'pass');
  assert.equal(engineCheckNow(K[2], cwd).status, 'pass', 'nothing objective to check');
});

test('완료 판정: HWPX 없음 — two stalled verifications keep it a criterion, nothing for 대장 to confirm, never 완료', async () => {
  const t = setup(() => ({ evidence: [mdProof], claims: [{ criterion: K[0], check: 'pass' }, hwpxMissing, { criterion: K[2], check: 'none', person: true }] }));
  try {
    await t.until(12, g => g.status === 'review_required');
    // plan → dev → qa (fails) → plan (all done) → qa (stall 1: back to the work, said plainly) → plan → qa (stall 2: 대장)
    assert.deepEqual(t.calls, ['plan', 'dev', 'qa', 'plan', 'qa', 'plan', 'qa']);
    let g = t.get();
    assert.deepEqual([g.status, g.reason], ['review_required', 'needs_decision']);
    assert.match(g.question, /계속 실패합니다 \(대장 확인으로 완료할 수 없음\):\n- 회의록\.hwpx 를 엔진이/);
    assert.deepEqual(g.team.awaitingJudgement, [K[2]], 'only the subjective one is 대장\'s');
    assert.deepEqual(g.completionCriteria, K, 'no criterion was dropped or turned into an approval');
    assert.throws(() => t.scheduler.confirmCriterion(t.goal.id, K[1]), /객관적 조건은 대장 확인으로 대신할 수 없습니다 · 엔진 확인 실패: 회의록\.hwpx 있음 아님/);
    t.scheduler.confirmCriterion(t.goal.id, K[2], '정중함');
    g = t.get();
    assert.notEqual(g.status, 'verified', 'the subjective one alone does not finish it');
    assert.equal(g.evidence.some(e => e.criterion === K[1]), false);
  } finally { t.store.close(); }
});

test('완료 판정: 검증 불가 is held as such — the criterion stays, 대장 is asked for a way to check it, not to approve it', async () => {
  const t = setup(() => ({ evidence: [mdProof], claims: [{ criterion: K[0], check: 'pass' }, { criterion: K[1], check: 'invalid', detail: '지원하지 않는 확인 방식' },
    { criterion: K[2], check: 'none', person: true }] }));
  try {
    await t.until(12, g => g.status === 'review_required');
    const g = t.get();
    assert.match(g.question, /검증 불가 · 엔진이 아래 조건을 확인할 방법이 아직 없어 보류합니다 \(조건은 그대로 둡니다\):\n- 회의록\.hwpx/);
    assert.doesNotMatch(g.question, /계속 실패/, 'not called a failure of the work');
    assert.deepEqual(g.completionCriteria, K);
    assert.throws(() => t.scheduler.confirmCriterion(t.goal.id, K[1]), /대장 확인으로 대신할 수 없습니다/);
  } finally { t.store.close(); }
});

test('완료 판정: 대장\'s confirmation counts only while the engine\'s check holds — a file gone before the finish stops it', async () => {
  const t = setup(() => ({ evidence: [mdProof], claims: [{ criterion: K[0], check: 'pass' }, { criterion: K[1], check: 'none', person: true }, { criterion: K[2], check: 'none', person: true }] }));
  try {
    writeFileSync(path.join(t.cwd, '회의록.hwpx'), 'x');
    await t.until(12, g => g.status === 'review_required');
    assert.deepEqual(t.get().team.awaitingJudgement, [K[1], K[2]], 'the file is there, so its 대장 part may be judged');
    t.scheduler.confirmCriterion(t.goal.id, K[1], '서식 확인');
    rmSync(path.join(t.cwd, '회의록.hwpx'));
    t.scheduler.confirmCriterion(t.goal.id, K[2], '정중함');
    const g = t.get();
    assert.equal(g.status, 'scheduled', 'back to the work, not 완료');
    assert.match(g.team.feedback, /대장 확인 뒤 엔진 확인이 실패한 조건이 있어 완료하지 않습니다:\n- 회의록\.hwpx/);
    assert.equal(g.confirmed.find(k => k.criterion === K[1]).engine, 'fail', 'that confirmation no longer counts');
  } finally { t.store.close(); }
});

test('완료 판정: a confirmation made before this rule (회의록, 10차) does not count — the finish is found and corrected, history kept', () => {
  const t = setup(() => ({}));
  try {
    const plan = startPlan(parseTasks([{ id: 'T1', title: '회의록 쓰기', team: 'dev', outputs: ['회의록.md'], criteria: [1] },
      { id: 'T2', title: '한글 문서', team: 'dev', outputs: ['회의록.hwpx'], criteria: [2], depends_on: ['T1'] }]), 't0');
    const old = [K[1], K[2]].map(criterion => ({ criterion, proof: '대장 확인', by: 'human', at: 't1' }));
    t.scheduler.update(t.get(), { status: 'verified', reason: null, autoRun: false, autoRunBeforeFinish: true, confirmed: old,
      evidence: [mdProof, ...old.map(({ criterion, proof }) => ({ criterion, proof }))],
      taskPlan: { ...plan, tasks: plan.tasks.map(x => ({ ...x, status: 'done', attempts: 1 })) }, messages: [{ role: 'team', text: '이전 기록', at: 't0' }] });
    const dry = t.scheduler.recheckCompletion(t.goal.id);
    assert.deepEqual([dry.corrected, dry.problems.map(p => p.criterion)], [false, [K[1]]]);
    assert.equal(t.get().status, 'verified', 'a dry run changes nothing');
    const fixed = t.scheduler.recheckCompletion(t.goal.id, { apply: true });
    assert.equal(fixed.corrected, true);
    const g = t.get();
    assert.deepEqual([g.status, g.autoRun, g.team.step], ['scheduled', true, 'plan']);
    assert.deepEqual(g.taskPlan.tasks.map(x => [x.id, x.status]), [['T1', 'done'], ['T2', 'pending']], 'the task behind the missing file is open again');
    assert.deepEqual(g.evidence.map(e => e.criterion).sort(), [K[0], K[2]].sort(), 'the subjective confirmation still stands');
    assert.equal(g.confirmed.length, 2, 'confirmations stay in the record');
    assert.equal(g.messages[0].text, '이전 기록', 'history kept');
    assert.match(g.messages.at(-1).text, /완료 표시 정정 · [\s\S]*회의록\.hwpx[\s\S]*엔진 근거 없음 \(대장 확인만 있었음\)/);
    assert.ok(t.store.recentEvents(20).some(e => e.type === 'goal.completion_corrected' && e.goalId === t.goal.id));
    // 결과 패키지 follows: no longer 완료, and the reopened task is listed as open
    const pkg = buildPackage({ goal: g, runs: [{ team: 'dev' }], files: ['회의록.md'] });
    assert.doesNotMatch(pkg['PROJECT_SUMMARY.md'], /완료 · 엔진 검증 통과/);
    assert.match(pkg['OPEN_ISSUES.md'], /작업 T2 한글 문서/);
  } finally { t.store.close(); }
});

test('완료 판정: once the engine proves everything the project finishes — and the plan, the evidence and the package agree', async () => {
  const t = setup(() => ({ evidence: [mdProof, { criterion: K[1], proof: '엔진 확인 · 회의록.hwpx 를 엔진이 만듦', by: 'engine' }],
    claims: [{ criterion: K[0], check: 'pass' }, { criterion: K[1], check: 'pass' }, { criterion: K[2], check: 'none', person: true }] }));
  try {
    writeFileSync(path.join(t.cwd, '회의록.hwpx'), 'x');
    const plan = startPlan(parseTasks([{ id: 'T1', title: '회의록', team: 'dev', outputs: ['회의록.md', '회의록.hwpx'], criteria: [1, 2] },
      { id: 'T2', title: '추가 다듬기', team: 'dev', outputs: ['부록.md'], criteria: [] }]), 't0');
    t.scheduler.update(t.get(), { taskPlan: plan });
    await t.until(12, g => g.status === 'review_required' || g.status === 'verified');
    assert.deepEqual([t.get().status, t.get().reason], ['review_required', 'owner_approval'], 'only 대장\'s own criterion left');
    t.scheduler.confirmCriterion(t.goal.id, K[2], '정중함');
    const g = t.get();
    assert.equal(g.status, 'verified');
    assert.deepEqual(g.taskPlan.tasks.map(x => x.status), ['done', 'skipped'], 'nothing left waiting in a finished plan');
    const pkg = buildPackage({ goal: g, runs: [{ team: 'dev' }], files: ['회의록.md', '회의록.hwpx'] });
    assert.match(pkg['PROJECT_SUMMARY.md'], /완료 · 엔진 검증 통과/);
    assert.doesNotMatch(pkg['OPEN_ISSUES.md'], /작업 T/);
    assert.deepEqual(JSON.parse(pkg['TASK_MANIFEST.json']).tasks.map(x => x.status), ['done', 'skipped']);
  } finally { t.store.close(); }
});
