import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTeam, parsePlan, qaFindings, TEAMS, teamPrompt } from '../src/teams.js';

const goal = { objective: '가계부 웹앱을 만든다', completionCriteria: ['index.html 파일이 있다', '합계 계산 테스트 통과'] };

test('three teams rotate plan → dev → qa → plan, each with its own tool and access', () => {
  assert.deepEqual([nextTeam(null), nextTeam('plan'), nextTeam('dev'), nextTeam('qa')], ['plan', 'dev', 'qa', 'plan']);
  assert.deepEqual(Object.values(TEAMS).map(t => [t.id, t.executor, t.access]),
    [['plan', 'claude-code', 'read'], ['dev', 'claude-code', 'write'], ['qa', 'codex', 'write']]);
});

test('planning prompt carries the goal, criteria, files and QA feedback and asks for a plan block', () => {
  const p = teamPrompt('plan', { goal, team: { feedback: '합계가 틀림' }, files: ['index.html'] });
  assert.match(p, /기획팀/);
  assert.match(p, /가계부 웹앱을 만든다/);
  assert.match(p, /2\. 합계 계산 테스트 통과/);
  assert.match(p, /index\.html/);
  assert.match(p, /합계가 틀림/);
  assert.match(p, /AGENT_HQ_PLAN/);
});

test('dev prompt gives the one task and asks for the checkable report; qa prompt asks for feedback and improvements', () => {
  const dev = teamPrompt('dev', { goal, team: { task: '합계 함수 작성' }, files: [] });
  assert.match(dev, /개발팀/);
  assert.match(dev, /합계 함수 작성/);
  assert.match(dev, /AGENT_HQ_REPORT/);
  const qa = teamPrompt('qa', { goal, team: { task: '합계 함수 작성' }, files: ['sum.js'] });
  assert.match(qa, /검증팀/);
  assert.match(qa, /"feedback"/);
  assert.match(qa, /"improvements"/);
  assert.match(qa, /Do not change/);
});

test('the plan block is parsed; a missing block is null', () => {
  const plan = parsePlan('다음은 이것입니다.\nAGENT_HQ_PLAN\n{"next_task":"합계 함수 작성","needs_decision":null,"all_done":false}');
  assert.deepEqual(plan, { nextTask: '합계 함수 작성', needsDecision: null, allDone: false });
  assert.equal(parsePlan('계획 없음'), null);
  assert.equal(parsePlan('AGENT_HQ_PLAN {"next_task":""}'), null, 'an empty task without a decision or done is not a plan');
  assert.deepEqual(parsePlan('AGENT_HQ_PLAN {"needs_decision":"결제 정보가 필요합니다"}').needsDecision, '결제 정보가 필요합니다');
});

test('QA findings are trimmed and bounded', () => {
  const f = qaFindings({ feedback: 'x'.repeat(3000), improvements: ['다크 모드', '', 'CSV 내보내기', 7, 'a', 'b', 'c', 'd'] });
  assert.equal(f.feedback.length, 1500);
  assert.deepEqual(f.improvements, ['다크 모드', 'CSV 내보내기', 'a', 'b', 'c']);
  assert.deepEqual(qaFindings(null), { feedback: '', improvements: [] });
});
