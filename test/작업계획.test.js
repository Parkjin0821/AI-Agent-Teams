import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { lintTasks, parseTasks, readyTasks, settleTasks, startPlan, planText, taskText } from '../src/작업계획.js';
import { parsePlan } from '../src/팀.js';
import { GoalScheduler } from '../src/작업스케줄러.js';
import { PersistentStore } from '../src/영구저장소.js';
import { DEFAULT_POLICY } from '../src/정책.js';

const C = ['요구사항.md 에 사용자 역할 3가지가 있다', 'index.html 이 있다', '테스트가 통과한다', '분위기가 따뜻하다 (대장이 화면에서 확인) — 자동 검증 불가: 취향'];
const owner = c => /\(대장이[^)]*확인\)/.test(c);
const RAW = [
  { id: 'T1', title: '요구사항 정리', team: 'research', outputs: ['요구사항.md'], criteria: [1], depends_on: [] },
  { id: 'T2', title: '화면 설계·구현', team: 'design', inputs: ['T1'], outputs: ['index.html'], criteria: [2], depends_on: ['T1'] },
  { id: 'T3', title: '기능과 테스트', team: 'dev', inputs: ['T1'], outputs: ['앱.js', '앱.test.js'], criteria: [3], depends_on: ['T1'], on_fail: '실패한 테스트부터 고친다' },
];

test('작업 계획: the engine checks a graph — teams, outputs, every criterion served, known prerequisites, no cycle', () => {
  const tasks = parseTasks(RAW);
  assert.deepEqual(lintTasks(tasks, C, { ownerJudged: owner }), [], "대장's own criterion needs no task");
  const bad = parseTasks([
    { id: 'T1', title: '', team: 'qa', outputs: [], criteria: [9], depends_on: ['T2'] },
    { id: 'T2', title: 'x', team: 'dev', outputs: ['../밖.md'], criteria: [], depends_on: ['T1', 'T7'] },
  ]);
  const issues = lintTasks(bad, C, { ownerJudged: owner }).join('\n');
  for (const want of ['T1: 작업 이름', 'T1: 담당 팀은', 'T1: 산출물(outputs)이 없다', '없는 완료 조건 9번', '../밖.md 은 작업 폴더 안 경로가 아니다', '선행 작업 T7 가 목록에 없다', '순환', '완료 조건 1번을 맡은 작업이 없다']) {
    assert.ok(issues.includes(want), want);
  }
  assert.match(lintTasks(null, C)[0], /작업 목록\(tasks\)이 없다/);
});

test('작업 계획: what can start now, and a task is done when the engine proved its criteria', () => {
  let plan = startPlan(parseTasks(RAW), '2026-10-18T00:00:00Z');
  assert.deepEqual(readyTasks(plan).map(t => t.id), ['T1']);
  plan = settleTasks(plan, C, [{ criterion: C[0] }]);
  assert.deepEqual(plan.tasks.map(t => t.status), ['done', 'pending', 'pending']);
  assert.deepEqual(readyTasks(plan).map(t => t.id), ['T2', 'T3'], 'independent tasks are ready together');
  assert.match(planText(plan), /T2 \[대기 · 지금 할 수 있음\] 디자인팀 · 화면 설계·구현 · 산출물: index.html · 조건 2번 · 선행: T1/);
  assert.match(taskText(plan.tasks[2]), /이번 작업 T3: 기능과 테스트[\s\S]*실패하면: 실패한 테스트부터 고친다/);
  const p = parsePlan('계획\nAGENT_HQ_PLAN {"next_task":"T2 진행","team":"dev","task_id":"T2","tasks":' + JSON.stringify(RAW) + '}');
  assert.equal(p.taskId, 'T2');
  assert.equal(p.tasks.length, 3);
});

test('작업 계획: planning writes the graph with the criteria, picks tasks by id; verification marks them done', async () => {
  const store = new PersistentStore({ dataDir: mkdtempSync(path.join(tmpdir(), 'hq-plan-')) });
  const calls = [];
  let plans = 0;
  const scheduler = new GoalScheduler({ store, clock: { now: () => Date.parse('2026-10-18T09:00:00Z') }, policy: DEFAULT_POLICY, autonomy: () => 'L2',
    trust: { required: () => 0, count: () => 0, add: () => {} },
    runner: { run: async (goal, run) => {
      calls.push(run.team + (goal.team.taskId ? ':' + goal.team.taskId : ''));
      if (run.team === 'plan') {
        plans++;
        if (plans === 1) return { outcome: 'completed', plan: { nextTask: '시작', team: 'dev', reviews: [], completionCriteria: C, tasks: parseTasks(RAW) } };
        return { outcome: 'completed', plan: { nextTask: '요구사항', team: 'dev', taskId: plans === 2 ? 'T1' : 'T3', reviews: [] } };
      }
      if (run.team === 'qa') return { outcome: 'completed', evidence: [{ criterion: C[0], proof: '엔진 확인' }], findings: { feedback: '', improvements: [] }, claims: [] };
      return { outcome: 'completed', diffHash: 'd' + calls.length, evidence: [] };
    } } });
  const goal = scheduler.addGoal({ projectId: 'plan', kind: 'team', autoRun: true, objective: '행사 스태프 매칭', conversation: true, completionCriteria: [] });
  try {
    for (let i = 0; i < 5; i++) await scheduler.runGoal(goal.id);
    const g = store.getGoal(goal.id);
    assert.deepEqual(calls, ['plan', 'plan', 'research:T1', 'qa:T1', 'design:T2'], 'T1 went to its own team (research); after verification the engine handed T2 to design without calling planning');
    assert.match(g.messages.map(m => m.text).join('\n'), /작업 계획 3개:\nT1 조사팀 · 요구사항 정리\nT2 디자인팀 · 화면 설계·구현 \(← T1\)/);
    assert.deepEqual(g.taskPlan.tasks.map(t => [t.id, t.status, t.attempts]), [['T1', 'done', 1], ['T2', 'running', 1], ['T3', 'pending', 0]]);
  } finally { store.close(); }
});

test('작업 계획: a graph still wrong after one rewrite is left out — the project runs as before, with no extra approval', async () => {
  const store = new PersistentStore({ dataDir: mkdtempSync(path.join(tmpdir(), 'hq-plan2-')) });
  const bad = parseTasks([{ id: 'T1', title: '전부', team: 'dev', outputs: [], criteria: [1] }]);
  const scheduler = new GoalScheduler({ store, clock: { now: () => Date.parse('2026-10-18T09:00:00Z') }, policy: DEFAULT_POLICY, autonomy: () => 'L2',
    trust: { required: () => 0, count: () => 0, add: () => {} },
    runner: { run: async (goal, run) => run.team === 'plan' ? { outcome: 'completed', plan: { nextTask: 'x', team: 'dev', reviews: [], completionCriteria: C.slice(0, 3), tasks: bad } } : { outcome: 'completed' } } });
  const goal = scheduler.addGoal({ projectId: 'plan2', kind: 'team', autoRun: true, objective: 'x', conversation: true, completionCriteria: [] });
  try {
    await scheduler.runGoal(goal.id);
    assert.match(store.getGoal(goal.id).team.feedback, /작업 계획 사전 점검[\s\S]*T1: 산출물\(outputs\)이 없다/);
    await scheduler.runGoal(goal.id);
    const g = store.getGoal(goal.id);
    assert.equal(g.taskPlan, null);
    assert.equal(g.criteriaApprovalPending, false, 'L2 still settles the criteria');
    assert.match(g.messages.map(m => m.text).join('\n'), /작업 계획은 점검을 통과하지 못해 쓰지 않습니다/);
  } finally { store.close(); }
});

test('표준 인계: what a team hands over is kept with its task (listed files checked by the engine) and given to the tasks after it', async () => {
  const { readHandoff, recordHandoff, upstreamText } = await import('../src/작업계획.js');
  const h = readHandoff({ made: ['요구사항.md', './없는파일.md', '../밖.md'], decisions: ['역할은 주최자·스태프·관리자 셋'], open_issues: ['정산 방식 미정'],
    for_next: '요구사항.md 2장의 화면 목록을 그대로 쓴다' }, p => p === '요구사항.md' || p === '../밖.md');
  assert.deepEqual(h.made, [{ path: '요구사항.md', ok: true }, { path: '없는파일.md', ok: false }, { path: '../밖.md', ok: false }], 'outside the folder never counts');
  assert.equal(readHandoff({}), null);
  let plan = startPlan(parseTasks(RAW), 't0');
  plan = recordHandoff(plan, 'T1', h, 't1');
  const text = upstreamText(plan, plan.tasks[1]);
  assert.match(text, /T1 요구사항 정리 \(조사팀\)\n  만든 것: 요구사항.md, 없는파일.md \(엔진이 찾지 못함\), \.\.\/밖.md \(엔진이 찾지 못함\)\n  결정: 역할은 주최자·스태프·관리자 셋\n  남은 문제: 정산 방식 미정\n  다음 팀에게: 요구사항.md 2장의/);
  assert.equal(upstreamText(plan, plan.tasks[0]), '', 'a task with no prerequisites gets nothing');
  const { teamPrompt } = await import('../src/팀.js');
  const prompt = teamPrompt('design', { goal: { objective: 'x', completionCriteria: C, taskPlan: plan, messages: [] }, team: { step: 'design', taskId: 'T2', task: 'T2 진행' }, files: [] });
  assert.match(prompt, /선행 작업 인계[\s\S]*다음 팀에게: 요구사항.md 2장의/);
  assert.match(prompt, /이번 작업 T2: 화면 설계·구현/);
});

test('표준 인계: the scheduler keeps a work step\'s handoff on its task', async () => {
  const store = new PersistentStore({ dataDir: mkdtempSync(path.join(tmpdir(), 'hq-hand-')) });
  let plans = 0;
  const scheduler = new GoalScheduler({ store, clock: { now: () => Date.parse('2026-10-18T09:00:00Z') }, policy: DEFAULT_POLICY, autonomy: () => 'L2',
    trust: { required: () => 0, count: () => 0, add: () => {} },
    runner: { run: async (goal, run) => {
      if (run.team === 'plan') return ++plans === 1 ? { outcome: 'completed', plan: { nextTask: 's', team: 'dev', reviews: [], completionCriteria: C, tasks: parseTasks(RAW) } }
        : { outcome: 'completed', plan: { nextTask: 'T1', team: 'research', taskId: 'T1', reviews: [] } };
      return { outcome: 'completed', diffHash: 'd', evidence: [], handoff: { made: [{ path: '요구사항.md', ok: true }], decisions: [], openIssues: ['정산 미정'], forNext: '' } };
    } } });
  const goal = scheduler.addGoal({ projectId: 'hand', kind: 'team', autoRun: true, objective: 'x', conversation: true, completionCriteria: [] });
  try {
    for (let i = 0; i < 3; i++) await scheduler.runGoal(goal.id);
    const t1 = store.getGoal(goal.id).taskPlan.tasks[0];
    assert.deepEqual([t1.handoff.made[0].path, t1.handoff.openIssues[0]], ['요구사항.md', '정산 미정']);
  } finally { store.close(); }
});

test('엔진 배정: an unfinished task is tried again with the feedback; after three tries planning is asked to re-plan', async () => {
  const store = new PersistentStore({ dataDir: mkdtempSync(path.join(tmpdir(), 'hq-assign-')) });
  const calls = [];
  let plans = 0;
  const scheduler = new GoalScheduler({ store, clock: { now: () => Date.parse('2026-10-18T09:00:00Z') }, policy: { ...DEFAULT_POLICY, maxNoProgress: 99 }, autonomy: () => 'L2',
    trust: { required: () => 0, count: () => 0, add: () => {} },
    runner: { run: async (goal, run) => {
      calls.push(run.team + (goal.team.taskId ? ':' + goal.team.taskId : ''));
      if (run.team === 'plan') return ++plans === 1 ? { outcome: 'completed', plan: { nextTask: 's', team: 'dev', reviews: [], completionCriteria: C, tasks: parseTasks(RAW) } }
        : { outcome: 'completed', plan: { nextTask: 'T1', team: 'research', taskId: 'T1', reviews: [] } };
      if (run.team === 'qa') return { outcome: 'completed', evidence: [], findings: { feedback: '요구사항.md 가 비어 있음', improvements: [] }, claims: [{ criterion: C[0], check: 'fail' }] };
      return { outcome: 'completed', diffHash: 'd' + calls.length, evidence: [] };
    } } });
  const goal = scheduler.addGoal({ projectId: 'assign', kind: 'team', autoRun: true, objective: 'x', conversation: true, completionCriteria: [] });
  try {
    for (let i = 0; i < 9 && calls.filter(c => c === 'plan' || c.startsWith('plan:')).length < 3; i++) await scheduler.runGoal(goal.id);
    assert.deepEqual(calls.slice(0, 8), ['plan', 'plan', 'research:T1', 'qa:T1', 'research:T1', 'qa:T1', 'research:T1', 'qa:T1']);
    assert.equal(calls[8], 'plan', 'third failure: planning, not a fourth try');
    const g = store.getGoal(goal.id);
    assert.match(g.team.feedback, /작업 T1 \(요구사항 정리\) 이 3번 시도에도 끝나지 않았습니다/);
    assert.ok(g.messages.some(m => /엔진 배정 · T1 요구사항 정리 → 조사팀 \(다시\)/.test(m.text)));
  } finally { store.close(); }
});

test('동적 재계획: a new list replaces only the tasks not yet done; finished tasks and their handoffs stay; a bad list keeps the old plan', async () => {
  const { replan, remapCriteria, recordHandoff } = await import('../src/작업계획.js');
  let plan = settleTasks(startPlan(parseTasks(RAW), 't0'), C, [{ criterion: C[0] }]);
  plan = recordHandoff(plan, 'T1', { made: [{ path: '요구사항.md', ok: true }], decisions: [], openIssues: [], forNext: '역할 3개' }, 't1');
  const next = parseTasks([
    { id: 'T1', title: '다시 쓰면 안 됨', team: 'dev', outputs: ['x.md'], criteria: [1] },
    { id: 'T4', title: '화면 뼈대', team: 'design', outputs: ['index.html'], criteria: [2], depends_on: ['T1'] },
    { id: 'T5', title: '테스트 먼저', team: 'dev', outputs: ['앱.test.js'], criteria: [3], depends_on: ['T1'] },
  ]);
  const r = replan(plan, next, C, { ownerJudged: owner }, 't2');
  assert.equal(r.ok, true);
  assert.deepEqual([r.plan.version, r.kept, r.added], [2, 1, 2]);
  assert.deepEqual(r.plan.tasks.map(t => [t.id, t.status, t.attempts ?? 0]), [['T1', 'done', 0], ['T4', 'pending', 0], ['T5', 'pending', 0]], 'a finished id is never overwritten');
  assert.equal(r.plan.tasks[0].handoff.forNext, '역할 3개');
  const bad = replan(plan, parseTasks([{ id: 'T4', title: '화면', team: 'design', outputs: ['index.html'], criteria: [2], depends_on: ['T1'] }]), C, { ownerJudged: owner });
  assert.equal(bad.ok, false);
  assert.match(bad.issues.join('\n'), /완료 조건 3번을 맡은 작업이 없다/);
  assert.match(replan(plan, parseTasks([RAW[0]]), C).issues[0], /새 작업이 없다/);
  const moved = remapCriteria(plan, C, ['새 조건', C[2], C[0]]);
  assert.deepEqual(moved.tasks.map(t => t.criteria), [[3], [], [2]], 'criteria follow their text; a dropped one leaves the task');
});

function replanScheduler(dataName, onPlan, qa) {
  const store = new PersistentStore({ dataDir: mkdtempSync(path.join(tmpdir(), dataName)) });
  const calls = [];
  let plans = 0;
  const scheduler = new GoalScheduler({ store, clock: { now: () => Date.parse('2026-10-18T09:00:00Z') }, policy: { ...DEFAULT_POLICY, maxNoProgress: 99 }, autonomy: () => 'L2',
    trust: { required: () => 0, count: () => 0, add: () => {} },
    runner: { run: async (goal, run) => {
      calls.push(run.team + (goal.team.taskId ? ':' + goal.team.taskId : ''));
      if (run.team === 'plan') return { outcome: 'completed', plan: { nextTask: 'n', team: 'dev', reviews: [], ...onPlan(++plans, goal) } };
      if (run.team === 'qa') return qa(goal);
      return { outcome: 'completed', diffHash: 'd' + calls.length, evidence: [] };
    } } });
  return { store, scheduler, calls };
}
const T4 = [
  { id: 'T4', title: '요구사항 초안 (역할만)', team: 'research', outputs: ['요구사항.md'], criteria: [1] },
  { id: 'T2', title: '화면 설계·구현', team: 'design', outputs: ['index.html'], criteria: [2], depends_on: ['T4'] },
  { id: 'T3', title: '기능과 테스트', team: 'dev', outputs: ['앱.js'], criteria: [3], depends_on: ['T4'] },
];

test('동적 재계획: after three failed tries planning\'s new list is taken (once asked), and the new task starts with one attempt', async () => {
  const { store, scheduler, calls } = replanScheduler('hq-replan-', (n, goal) => {
    if (n === 1) return { completionCriteria: C, tasks: parseTasks(RAW) };
    if (n === 2) return { taskId: 'T1', tasks: parseTasks(T4) };          // not asked: ignored
    return { taskId: 'T4', tasks: parseTasks(T4) };
  }, () => ({ outcome: 'completed', evidence: [], findings: { feedback: '요구사항.md 가 비어 있음', improvements: [] }, claims: [{ criterion: C[0], check: 'fail' }] }));
  const goal = scheduler.addGoal({ projectId: 'replan', kind: 'team', autoRun: true, objective: 'x', conversation: true, completionCriteria: [] });
  try {
    for (let i = 0; i < 10; i++) await scheduler.runGoal(goal.id);
    assert.deepEqual(calls.slice(8, 10), ['plan', 'research:T4']);
    const g = store.getGoal(goal.id);
    assert.equal(g.taskPlan.version, 2);
    assert.deepEqual(g.taskPlan.tasks.map(t => [t.id, t.status, t.attempts]), [['T4', 'running', 1], ['T2', 'pending', 0], ['T3', 'pending', 0]], 'one attempt, not two');
    assert.match(g.messages.map(m => m.text).join('\n'), /작업 계획 다시 짬 \(2판\) · 끝난 작업 0개 유지 · 새 작업 3개/);
    assert.equal(g.team.replanRequested, false);
  } finally { store.close(); }
});

test('동적 재계획: criteria changed by 대장\'s message without a new list — planning is asked once, then its list replaces the unfinished tasks', async () => {
  const C2 = [...C, 'README.md 가 있다'];
  const { store, scheduler, calls } = replanScheduler('hq-replan2-', n => {
    if (n === 1) return { completionCriteria: C, tasks: parseTasks(RAW) };
    if (n === 2) return { taskId: 'T1' };
    if (n === 3) return { completionCriteria: C2, taskId: 'T2' };
    return { taskId: 'T6', tasks: parseTasks([...RAW.slice(1), { id: 'T6', title: '설명서', team: 'dev', outputs: ['README.md'], criteria: [5], depends_on: ['T1'] }]) };
  }, () => ({ outcome: 'completed', evidence: [{ criterion: C[0], proof: '엔진 확인' }], findings: { feedback: '', improvements: [] }, claims: [] }));
  const goal = scheduler.addGoal({ projectId: 'replan2', kind: 'team', autoRun: true, objective: 'x', conversation: true, completionCriteria: [] });
  try {
    for (let i = 0; i < 4; i++) await scheduler.runGoal(goal.id);
    assert.equal(store.getGoal(goal.id).taskPlan.tasks[0].status, 'done');
    scheduler.message(goal.id, '설명서(README.md)도 넣어 줘');
    await scheduler.runGoal(goal.id);
    let g = store.getGoal(goal.id);
    assert.equal(g.team.step, 'plan', 'asked again instead of going on with the old tasks');
    assert.match(g.team.feedback, /작업 계획 다시 짜기 · 바뀐 완료 조건에 맞춰/);
    await scheduler.runGoal(goal.id);
    g = store.getGoal(goal.id);
    assert.deepEqual(calls.slice(4), ['plan:T2', 'plan:T2'], 'two planning steps, no work step on the old tasks in between');
    assert.deepEqual(g.taskPlan.tasks.map(t => [t.id, t.status]), [['T1', 'done'], ['T2', 'pending'], ['T3', 'pending'], ['T6', 'running']]);
    assert.deepEqual([g.team.worker, g.team.taskId, g.completionCriteria.length], ['dev', 'T6', 5]);
  } finally { store.close(); }
});

test('작업 계획: a project finished by 대장\'s confirmation marks its tasks done too (10차 실측: verified, tasks still pending)', () => {
  const store = new PersistentStore({ dataDir: mkdtempSync(path.join(tmpdir(), 'hq-confirm-')) });
  const scheduler = new GoalScheduler({ store, clock: { now: () => Date.parse('2026-10-18T09:00:00Z') }, policy: DEFAULT_POLICY, autonomy: () => 'L2',
    // the engine's own check passes (index.html is there, the tests ran): this test is about the plan's bookkeeping
    engineCheck: () => ({ status: 'pass', detail: '' }),
    trust: { required: () => 0, count: () => 0, add: () => {} }, runner: { run: async () => ({ outcome: 'completed' }) } });
  try {
    const goal = scheduler.addGoal({ projectId: 'confirm', kind: 'team', autoRun: true, objective: 'x', conversation: true, completionCriteria: C.slice(0, 3) });
    store.insertRun({ id: 'qa-seen', goalId: goal.id, round: 9, attempt: 0, team: 'qa', status: 'finished', outcome: 'completed', simulated: false });
    scheduler.update(store.getGoal(goal.id), { taskPlan: startPlan(parseTasks(RAW), 't0'), evidence: [{ criterion: C[0], proof: '엔진 확인', by: 'engine' }],
      status: 'review_required', reason: 'needs_decision', question: '남은 조건 확인', team: { ...goal.team, step: 'qa', awaitingJudgement: [C[1], C[2]] } });
    scheduler.confirmCriterion(goal.id, C[1]);
    assert.deepEqual(store.getGoal(goal.id).taskPlan.tasks.map(t => t.status), ['done', 'done', 'pending'], 'settled at each confirmation');
    scheduler.confirmCriterion(goal.id, C[2]);
    const g = store.getGoal(goal.id);
    assert.equal(g.status, 'verified');
    assert.deepEqual(g.taskPlan.tasks.map(t => t.status), ['done', 'done', 'done']);
  } finally { store.close(); }
});
