import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PersistentStore } from '../src/persistent-store.js';
import { GoalScheduler } from '../src/scheduler.js';
import { DEFAULT_POLICY } from '../src/policy.js';

const T0 = new Date(2026, 8, 28, 10, 0, 0).getTime(); // local 10:00
const C = ['index.html 파일이 있다', '합계 테스트 통과'];
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup(respond, policy = {}) {
  const store = new PersistentStore({ dataDir: mkdtempSync(path.join(tmpdir(), 'hq-team-')) });
  const clock = { t: T0, now() { return this.t; } };
  const calls = [];
  const scheduler = new GoalScheduler({ store, clock, policy: { ...DEFAULT_POLICY, ...policy },
    runner: { run: async (goal, run) => { calls.push({ team: run.team, executor: run.executor, task: goal.team.task, feedback: goal.team.feedback }); return respond(run.team, calls.length, goal); } } });
  const add = (extra = {}) => scheduler.addGoal({ projectId: extra.projectId ?? 'budget', kind: 'team', autoRun: true, objective: '가계부', completionCriteria: C, ...extra });
  return { store, clock, calls, scheduler, add };
}
const ev = (...idx) => idx.map(i => ({ criterion: C[i], proof: '엔진 확인' }));
async function ticks(scheduler, n) { for (let i = 0; i < n; i++) await scheduler.tick({ autoOnly: true }); }

test('teams rotate plan → dev → qa → plan, each with its own tool, passing the task and feedback on', async () => {
  const { store, calls, scheduler, add } = setup((team, n) => ({
    plan: { outcome: 'completed', plan: { nextTask: `작업${n}`, needsDecision: null, allDone: false } },
    dev: { outcome: 'completed', evidence: ev(0), diffHash: `d${n}` },
    qa: { outcome: 'completed', evidence: ev(0), findings: { feedback: '합계 테스트 실패', improvements: [] } },
  })[team]);
  const g = add();
  await ticks(scheduler, 4);
  assert.deepEqual(calls.map(c => [c.team, c.executor]), [['plan', 'claude-code'], ['dev', 'claude-code'], ['qa', 'codex'], ['plan', 'claude-code']]);
  assert.equal(calls[1].task, '작업1');
  assert.equal(calls[3].feedback, '합계 테스트 실패');
  const saved = store.getGoal(g.id);
  assert.deepEqual([saved.status, saved.team.step, saved.team.cycle], ['scheduled', 'dev', 2]);
  assert.deepEqual(saved.evidence.map(e => e.criterion), [C[0]], 'a planning round does not wipe evidence');
  assert.equal(store.listRuns(g.id)[2].team, 'qa');
  store.close();
});

test('when every criterion is proven the project stops and improvements wait for 대장', async () => {
  const { store, calls, scheduler, add } = setup((team) => ({
    plan: { outcome: 'completed', plan: { nextTask: '마무리', needsDecision: null, allDone: false } },
    dev: { outcome: 'completed', evidence: ev(0, 1), diffHash: 'd' },
    qa: { outcome: 'completed', evidence: ev(0, 1), findings: { feedback: '', improvements: ['다크 모드', 'CSV 내보내기'] } },
  })[team]);
  const g = add();
  await ticks(scheduler, 6);
  const saved = store.getGoal(g.id);
  assert.equal(saved.status, 'verified');
  assert.equal(saved.autoRun, false);
  assert.deepEqual(saved.proposal.items, ['다크 모드', 'CSV 내보내기']);
  assert.equal(saved.proposal.status, 'pending');
  assert.equal(calls.length, 3);
  const next = scheduler.acceptProposal(g.id);
  assert.deepEqual([next.projectId, next.kind, next.autoRun], ['budget', 'team', true]);
  assert.deepEqual(next.completionCriteria, ['다크 모드', 'CSV 내보내기']);
  assert.equal(store.getGoal(g.id).proposal.status, 'accepted');
  assert.throws(() => scheduler.acceptProposal(g.id), /proposal/);
  store.close();
});

test('the planning team can stop to ask 대장, and the answer goes back to planning', async () => {
  const { store, calls, scheduler, add } = setup((team, n) => (n === 1
    ? { outcome: 'completed', plan: { nextTask: '', needsDecision: '결제 API 키가 필요합니다', allDone: false } }
    : { outcome: 'completed', plan: { nextTask: '키 없이 진행', needsDecision: null, allDone: false } }));
  const g = add();
  await ticks(scheduler, 3);
  let saved = store.getGoal(g.id);
  assert.deepEqual([saved.status, saved.reason, saved.question], ['review_required', 'needs_decision', '결제 API 키가 필요합니다']);
  assert.equal(calls.length, 1);
  scheduler.answer(g.id, '키 없이 모의 결제로 진행');
  await ticks(scheduler, 1);
  assert.equal(calls[1].team, 'plan');
  assert.match(calls[1].feedback, /대장 답변 · 키 없이 모의 결제로 진행/);
  saved = store.getGoal(g.id);
  assert.equal(saved.team.step, 'dev');
  store.close();
});

test('three development rounds without real progress stop the project', async () => {
  const { store, calls, scheduler, add } = setup((team) => ({
    plan: { outcome: 'completed', plan: { nextTask: '같은 시도', needsDecision: null, allDone: false } },
    dev: { outcome: 'completed', evidence: [], diffHash: 'same' },
    qa: { outcome: 'completed', evidence: [], findings: { feedback: '안 됨', improvements: [] } },
  })[team], { maxRoundsPerDay: 50 });
  const g = add();
  await ticks(scheduler, 12);
  const saved = store.getGoal(g.id);
  assert.deepEqual([saved.status, saved.reason], ['review_required', 'no_progress']);
  // dev #1 is progress (first diff); dev #2, #3, #4 are not → stop right after dev #4
  // calls: p d q | p d q | p d q | p d  = 11
  assert.equal(calls.length, 11);
  store.close();
});

test('the daily round limit pauses a project until the next day', async () => {
  const { store, clock, calls, scheduler, add } = setup((team, n) => ({
    plan: { outcome: 'completed', plan: { nextTask: 't', needsDecision: null, allDone: false } },
    dev: { outcome: 'completed', evidence: [], diffHash: `d${n}` },
    qa: { outcome: 'completed', evidence: [], findings: { feedback: 'f', improvements: [] } },
  })[team], { maxRoundsPerDay: 4 });
  const g = add();
  await ticks(scheduler, 8);
  assert.equal(calls.length, 4);
  const saved = store.getGoal(g.id);
  const midnight = new Date(T0); midnight.setHours(24, 0, 0, 0);
  assert.deepEqual([saved.status, saved.reason, saved.nextRunAt], ['scheduled', 'daily_cap', midnight.toISOString()]);
  clock.t = midnight.getTime();
  await ticks(scheduler, 1);
  assert.equal(calls.length, 5);
  store.close();
});

test('only started projects run automatically; stop and start control it', async () => {
  const { store, calls, scheduler, add } = setup(() => ({ outcome: 'completed', plan: { nextTask: 't', needsDecision: null, allDone: false } }));
  const g = add({ autoRun: false });
  await ticks(scheduler, 2);
  assert.equal(calls.length, 0);
  scheduler.start(g.id);
  await ticks(scheduler, 1);
  assert.equal(calls.length, 1);
  scheduler.stop(g.id);
  await ticks(scheduler, 2);
  assert.equal(calls.length, 1);
  assert.equal(store.getGoal(g.id).status, 'paused');
  store.close();
});

const planFor = (team, reviews = []) => ({ outcome: 'completed', plan: { nextTask: '화면 작업', team, reviews, needsDecision: null, allDone: false } });

test('the planning team can hand a task to the design team', async () => {
  const { calls, scheduler, add, store } = setup((team, n) => ({
    plan: planFor('design'),
    design: { outcome: 'completed', evidence: ev(0), diffHash: `d${n}` },
    qa: { outcome: 'completed', evidence: ev(0), findings: { feedback: 'f', improvements: [] } },
  })[team]);
  add();
  await ticks(scheduler, 3);
  assert.deepEqual(calls.map(c => [c.team, c.executor]), [['plan', 'claude-code'], ['design', 'claude-code'], ['qa', 'codex']]);
  store.close();
});

test('requested reviews run between the work and verification; blocking issues go back to planning', async () => {
  const { store, calls, scheduler, add } = setup((team, n) => ({
    plan: planFor('dev', ['security', 'policy']),
    dev: { outcome: 'completed', evidence: [], diffHash: `d${n}` },
    security: { outcome: 'completed', review: { verdict: 'issues', issues: ['API 키가 코드에 있음'], blocking: true, needsDecision: null } },
    policy: { outcome: 'completed', review: { verdict: 'pass', issues: [], blocking: false, needsDecision: null } },
  })[team]);
  const g = add();
  await ticks(scheduler, 4);
  assert.deepEqual(calls.map(c => c.team), ['plan', 'dev', 'security', 'plan'], 'policy and qa are skipped after a blocking issue');
  assert.equal(calls[2].executor, 'codex');
  assert.match(calls[3].feedback, /보안팀.*\n- API 키가 코드에 있음/);
  assert.equal(store.getGoal(g.id).team.cycle, 2);
  const runs = store.listRuns(g.id);
  assert.deepEqual(runs[0].plan, { nextTask: '화면 작업', team: 'dev', reviews: ['security', 'policy'] }, 'the plan summary is kept on the run');
  assert.deepEqual(runs[2].review, { verdict: 'issues', issues: ['API 키가 코드에 있음'], blocking: true }, 'the review verdict is kept on the run');
  store.close();
});

test('non-blocking review notes reach the planning team together with the verification feedback', async () => {
  const { calls, scheduler, add, store } = setup((team, n) => ({
    plan: planFor('dev', ['policy']),
    dev: { outcome: 'completed', evidence: [], diffHash: `d${n}` },
    policy: { outcome: 'completed', review: { verdict: 'issues', issues: ['폰트 라이선스 표기 필요'], blocking: false, needsDecision: null } },
    qa: { outcome: 'completed', evidence: [], findings: { feedback: '합계 틀림', improvements: [] } },
  })[team]);
  add();
  await ticks(scheduler, 5);
  assert.deepEqual(calls.map(c => c.team), ['plan', 'dev', 'policy', 'qa', 'plan']);
  assert.match(calls[4].feedback, /합계 틀림/);
  assert.match(calls[4].feedback, /\[정책팀\] 폰트 라이선스 표기 필요/);
  store.close();
});

test('a reviewer can stop to ask 대장; a malformed review stops too', async () => {
  const asking = setup((team) => ({
    plan: planFor('dev', ['policy']), dev: { outcome: 'completed', evidence: [], diffHash: 'd' },
    policy: { outcome: 'completed', review: { verdict: 'issues', issues: [], blocking: false, needsDecision: 'GPL 코드를 써도 될까요?' } },
  })[team]);
  const g1 = asking.add();
  await ticks(asking.scheduler, 4);
  const s1 = asking.store.getGoal(g1.id);
  assert.deepEqual([s1.status, s1.reason, s1.question], ['review_required', 'needs_decision', '[정책팀] GPL 코드를 써도 될까요?']);
  asking.store.close();

  const broken = setup((team) => ({
    plan: planFor('dev', ['security']), dev: { outcome: 'completed', evidence: [], diffHash: 'd' },
    security: { outcome: 'completed', review: null },
  })[team]);
  const g2 = broken.add();
  await ticks(broken.scheduler, 4);
  assert.deepEqual([broken.store.getGoal(g2.id).status, broken.store.getGoal(g2.id).reason], ['review_required', 'unclear_review']);
  broken.store.close();
});

test('concurrency: at most 2 at once, Codex at most 1, one round per project', async () => {
  const releases = [];
  const { calls, scheduler, add, store } = setup(() => new Promise(resolve => releases.push(resolve)));
  add({ projectId: 'a' }); add({ projectId: 'b' }); add({ projectId: 'c' }); add({ projectId: 'a' });
  scheduler.tick({ autoOnly: true }); await flush();
  assert.equal(calls.length, 2, 'two slots in total');
  const qaGoal = add({ projectId: 'd' });
  store.saveGoal({ ...store.getGoal(qaGoal.id), team: { step: 'qa', task: '', feedback: '', cycle: 1 } });
  const qaGoal2 = add({ projectId: 'e' });
  store.saveGoal({ ...store.getGoal(qaGoal2.id), team: { step: 'qa', task: '', feedback: '', cycle: 1 } });
  releases.splice(0).forEach(r => r({ outcome: 'completed', plan: { nextTask: 't', needsDecision: null, allDone: false } }));
  await flush(); await flush();
  scheduler.tick({ autoOnly: true }); await flush();
  const running = store.listGoals().filter(g => g.status === 'running');
  assert.ok(running.length <= 2);
  assert.ok(running.filter(g => g.team.step === 'qa').length <= 1, 'codex (qa) at most one');
  assert.equal(new Set(running.map(g => g.projectId)).size, running.length, 'one round per project');
  releases.splice(0).forEach(r => r({ outcome: 'completed' }));
  await flush(); await flush();
  store.close();
});
