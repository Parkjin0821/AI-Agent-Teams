import test from 'node:test';
import assert from 'node:assert/strict';
import { measureGoal, summarize, METRICS } from '../src/목표측정.js';
import { parseTasks, startPlan } from '../src/작업계획.js';

const C = ['요구사항.md 에 사용자 역할 3가지가 있다', 'index.html 이 있다', '테스트가 통과한다'];
const RUBRIC = {
  requirements: [
    { name: '요구사항·역할', match: /요구사항|역할/, teams: ['research'] },
    { name: '유사 서비스 조사', match: /유사|조사/, teams: ['research'] },
    { name: '화면 흐름 설계', match: /화면|흐름/, teams: ['design'] },
    { name: '테스트', match: /테스트|test/i, teams: ['dev'] },
  ],
  goalChecks: [
    { name: 'index.html', file: /(^|\/)index\.html$/ },
    { name: '지원자 확정 기능', file: /\.(html|js)$/, contains: /확정/ },
    { name: '출처 2곳', file: /\.md$/, contains: /https?:\/\/\S+/, min: 2 },
    { name: '원문 저장', file: /^sources\//, sources: true },
  ],
};
const tasks = parseTasks([
  { id: 'T1', title: '요구사항 정리', team: 'research', outputs: ['요구사항.md'], criteria: [1] },
  { id: 'T2', title: '화면 흐름과 구현', team: 'dev', outputs: ['index.html'], criteria: [2], depends_on: ['T1'] },
  { id: 'T3', title: '기능 테스트', team: 'dev', outputs: ['앱.test.js'], criteria: [3], depends_on: ['T2'] },
]);
const plan = startPlan(tasks, 't0');
plan.tasks[0] = { ...plan.tasks[0], status: 'done', attempts: 1, handoff: { made: [{ path: '요구사항.md', ok: true }], decisions: [], openIssues: [], forNext: '역할 3개 그대로' } };
plan.tasks[1] = { ...plan.tasks[1], status: 'done', attempts: 2, handoff: { made: [{ path: 'index.html', ok: false }], decisions: [], openIssues: [], forNext: '' } };
plan.tasks[2] = { ...plan.tasks[2], status: 'running', attempts: 1 };
const goal = { id: 'g1', status: 'review_required', completionCriteria: C, evidence: [{ criterion: C[0] }], taskPlan: plan };
const FILES = {
  '요구사항.md': '# 요구사항\n역할: 주최자, 스태프, 관리자\n참고: https://a.example/x',
  'index.html': '<button>지원자 확정</button>',
  'sources/a.html': 'https://b.example https://c.example 확정',
  'reports/결과패키지/PROJECT_SUMMARY.md': '**상태:** 완료 · 엔진 검증 통과\n## 사용 방법\n- 화면: 브라우저로 index.html 를 연다',
  'reports/결과패키지/TASK_MANIFEST.json': '{}', 'reports/결과패키지/DECISIONS.md': '', 'reports/결과패키지/OPEN_ISSUES.md': '', 'reports/결과패키지/HANDOFF.md': '',
  'reports/결과패키지/evidence/evidence.json': JSON.stringify({ criteria: C.map(c => ({ criterion: c })) }),
};
const read = f => FILES[f] ?? null;
const runs = Array.from({ length: 10 }, (_, i) => ({ id: String(i), team: i % 2 ? 'qa' : 'dev' }));
const events = [
  { type: 'task.assigned', goalId: 'g1', task: 'T1', team: 'research', attempt: 1 },
  { type: 'task.assigned', goalId: 'g1', task: 'T2', team: 'dev', attempt: 1 },
  { type: 'task.assigned', goalId: 'g1', task: 'T2', team: 'dev', attempt: 2 },
  { type: 'task.assigned', goalId: 'g1', task: 'T3', team: 'design', attempt: 1 },
  { type: 'task.replanned', goalId: 'g1', version: 2 },
  { type: 'task.assigned', goalId: 'other', task: 'T1', team: 'dev', attempt: 5 },
];

test('목표 중심 측정: six measures from the engine records, the files and the rubric — each with what it missed', () => {
  const m = measureGoal({ goal, runs, events, files: Object.keys(FILES), read, rubric: RUBRIC });
  assert.deepEqual(Object.keys(m), METRICS.map(([k]) => k));
  // 1. "유사 서비스 조사" has no task
  assert.equal(m.decomposition.score, 3 / 4);
  assert.deepEqual(m.decomposition.misses, ['유사 서비스 조사']);
  // 2. 화면 흐름 went to dev (rubric: design); T3 ran by design though the graph says dev
  assert.equal(m.assignment.score, (7 - 2) / 7);
  assert.match(m.assignment.misses.join('\n'), /화면 흐름 설계 → dev \(기대: design\)[\s\S]*T3 를 design 가 실행 \(계획: dev\)/);
  // 3. T1 handed over fully; T2's listed file was not found by the engine (T3 has no follower)
  assert.equal(m.handoff.score, 1 / 2);
  assert.match(m.handoff.misses[0], /T2 화면 흐름과 구현: 엔진이 못 찾은 파일: index.html/);
  // 4. one second try + one re-plan over ten steps; the other project's events do not count
  assert.equal(m.rework.rate, 0.2);
  // 5. package says 완료 but the project is not verified; 앱.test.js was planned and is missing
  assert.ok(m.package.misses.includes('완료 표시가 검증 결과와 일치'));
  assert.ok(m.package.misses.includes('계획된 산출물 앱.test.js'));
  assert.ok(!m.package.misses.includes('실행 방법(화면) 안내'));
  // 6. sources/ only counts when a check asks for it: 출처 2곳 needs .md files, and there is one link there
  assert.deepEqual(m.goal.misses, ['출처 2곳']);
  assert.equal(m.goal.score, 3 / 4);
});

test('목표 중심 측정: no graph means nothing was split; engine files never count as the goal\'s results', () => {
  const m = measureGoal({ goal: { id: 'g2', status: 'verified', completionCriteria: C, evidence: [] }, runs: [], events: [],
    files: ['reports/완료보고서-1.md', 'reports/결과패키지/PROJECT_SUMMARY.md'], read: () => '확정 https://x https://y', rubric: RUBRIC });
  assert.equal(m.decomposition.score, 0);
  assert.match(m.decomposition.basis, /작업 그래프 없음/);
  assert.equal(m.handoff.score, null);
  assert.equal(m.rework.score, null);
  assert.equal(m.goal.score, 0, 'the engine\'s own report text proves nothing about the goal');
  const avg = summarize([m, measureGoal({ goal, runs, events, files: Object.keys(FILES), read, rubric: RUBRIC })]);
  assert.equal(avg.decomposition.value, (0 + 0.75) / 2);
  assert.deepEqual(avg.handoff, { value: 0.5, n: 1 }, 'a project with no value is left out of the average');
});
