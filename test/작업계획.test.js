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
    assert.deepEqual(calls, ['plan', 'plan', 'research:T1', 'qa:T1', 'plan:T1'], 'T1 went to its own team (research), not the team planning named; verification knows the task');
    assert.match(g.messages.map(m => m.text).join('\n'), /작업 계획 3개:\nT1 조사팀 · 요구사항 정리\nT2 디자인팀 · 화면 설계·구현 \(← T1\)/);
    assert.deepEqual(g.taskPlan.tasks.map(t => [t.id, t.status, t.attempts]), [['T1', 'done', 1], ['T2', 'pending', 0], ['T3', 'running', 1]]);
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
