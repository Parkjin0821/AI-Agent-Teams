import test from 'node:test';
import assert from 'node:assert/strict';
import { nextStep, parsePlan, parseReview, qaFindings, TEAMS, teamPrompt } from '../src/teams.js';

const goal = { objective: '가계부 웹앱을 만든다', completionCriteria: ['index.html 파일이 있다', '합계 계산 테스트 통과'] };

test('six teams, each with its own tool and access', () => {
  assert.deepEqual(Object.values(TEAMS).map(t => [t.id, t.executor, t.access]), [
    ['plan', 'claude-code', 'read'], ['dev', 'claude-code', 'write'], ['design', 'claude-code', 'write'],
    ['security', 'codex', 'read'], ['policy', 'claude-code', 'read'], ['qa', 'codex', 'write']]);
});

test('the rotation follows what the planning team asked for', () => {
  const base = { step: 'plan', worker: 'dev', reviews: [] };
  assert.equal(nextStep(base), 'dev');
  assert.equal(nextStep({ ...base, worker: 'design' }), 'design');
  assert.equal(nextStep({ ...base, step: 'dev' }), 'qa', 'no reviews requested → straight to verification');
  assert.equal(nextStep({ ...base, step: 'dev', reviews: ['security', 'policy'] }), 'security');
  assert.equal(nextStep({ ...base, step: 'security', reviews: ['policy'] }), 'policy');
  assert.equal(nextStep({ ...base, step: 'policy', reviews: [] }), 'qa');
  assert.equal(nextStep({ ...base, step: 'qa' }), 'plan');
  assert.equal(nextStep({ step: undefined }), 'plan');
});

test('the plan says which team works next and which reviews to run', () => {
  const plan = parsePlan('AGENT_HQ_PLAN {"next_task":"로그인 화면","team":"design","reviews":["policy","security","other"],"needs_decision":null,"all_done":false}');
  assert.deepEqual(plan, { nextTask: '로그인 화면', team: 'design', reviews: ['security', 'policy'], needsDecision: null, allDone: false });
  assert.equal(parsePlan('AGENT_HQ_PLAN {"next_task":"합계 함수","team":"hacker"}').team, 'dev', 'unknown team falls back to development');
  assert.deepEqual(parsePlan('AGENT_HQ_PLAN {"next_task":"합계 함수"}').reviews, []);
  assert.equal(parsePlan('계획 없음'), null);
});

test('planning prompt explains when to call design, security and policy', () => {
  const p = teamPrompt('plan', { goal, team: { feedback: '보안팀: 비밀번호가 평문' }, files: ['index.html'] });
  assert.match(p, /디자인팀/);
  assert.match(p, /보안팀/);
  assert.match(p, /정책팀/);
  assert.match(p, /"reviews"/);
  assert.match(p, /비밀번호가 평문/);
});

test('each team has its own prompt; reviewers must not change files', () => {
  for (const step of ['dev', 'design', 'qa']) assert.match(teamPrompt(step, { goal, team: { task: 't' }, files: [] }), /AGENT_HQ_REPORT/);
  for (const step of ['security', 'policy']) {
    const p = teamPrompt(step, { goal, team: { task: 't' }, files: [] });
    assert.match(p, /AGENT_HQ_REVIEW/);
    assert.match(p, /Do not change/);
  }
  assert.match(teamPrompt('design', { goal, team: { task: 't' }, files: [] }), /디자인팀/);
  assert.throws(() => teamPrompt('marketing', { goal, team: {}, files: [] }), /unknown/);
});

test('a review block is parsed; a missing block is null', () => {
  assert.deepEqual(parseReview('AGENT_HQ_REVIEW {"verdict":"issues","issues":["API 키가 코드에 있음",""],"blocking":true,"needs_decision":null}'),
    { verdict: 'issues', issues: ['API 키가 코드에 있음'], blocking: true, needsDecision: null });
  assert.deepEqual(parseReview('AGENT_HQ_REVIEW {"verdict":"pass"}'), { verdict: 'pass', issues: [], blocking: false, needsDecision: null });
  assert.equal(parseReview('AGENT_HQ_REVIEW {"verdict":"maybe"}'), null);
  assert.equal(parseReview('검토함'), null);
  assert.equal(parseReview('AGENT_HQ_REVIEW {"verdict":"issues","needs_decision":"GPL 코드를 써도 될까요?"}').needsDecision, 'GPL 코드를 써도 될까요?');
});

test('QA findings are trimmed and bounded', () => {
  const f = qaFindings({ feedback: 'x'.repeat(3000), improvements: ['다크 모드', '', 'CSV 내보내기', 7, 'a', 'b', 'c', 'd'] });
  assert.equal(f.feedback.length, 1500);
  assert.deepEqual(f.improvements, ['다크 모드', 'CSV 내보내기', 'a', 'b', 'c']);
  assert.deepEqual(qaFindings(null), { feedback: '', improvements: [] });
});
