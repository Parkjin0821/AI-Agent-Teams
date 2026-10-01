import test from 'node:test';
import assert from 'node:assert/strict';
import { nextStep, parsePlan, parseReview, qaFindings, TEAMS, teamPrompt } from '../src/팀.js';

const goal = { objective: '가계부 웹앱을 만든다', completionCriteria: ['index.html 파일이 있다', '합계 계산 테스트 통과'] };

test('pages get one living element, and example marks stay one per section (team vs direct build comparison)', () => {
  const input = {goal,files:[],team:{task:'화면 제작'}};
  assert.match(teamPrompt('plan',input), /살아 있는 요소 하나/);
  assert.match(teamPrompt('plan',input), /예시 내용이 든 구역마다 한 번/);
  assert.match(teamPrompt('design',input), /지금 영업 중/);
  assert.match(teamPrompt('design',input), /항목·카드마다 배지를 붙이면/);
  assert.match(teamPrompt('qa',input), /예시 배지가 항목마다/);
});
test('UI prompts establish a 화면설계, hand it to developers, and distinguish visual verification', () => {
  const input = {goal,files:[],team:{task:'화면 제작'}};
  assert.match(teamPrompt('plan',input), /design\/화면설계\.md/);
  assert.match(teamPrompt('design',input), /1440px·모바일 390px/);
  assert.match(teamPrompt('design',input), /구체적인 값/);
  assert.match(teamPrompt('dev',input), /design\/화면설계\.md 와 design\/화면검토\.md/);
  assert.match(teamPrompt('qa',input), /시각 검증 완료를 주장하지 않는다/);
});

test('seven teams, each with its own tool and access; only research gets the web', () => {
  assert.deepEqual(Object.values(TEAMS).map(t => [t.id, t.executor, t.access, Boolean(t.web)]), [
    ['plan', 'claude-code', 'read', false], ['research', 'claude-code', 'write', true], ['dev', 'claude-code', 'write', false],
    ['design', 'claude-code', 'write', false], ['security', 'codex', 'read', false], ['policy', 'claude-code', 'read', false],
    ['qa', 'codex', 'read', false]]);
});

test('the design team is told which design tools it may use, and to record what it made', () => {
  const withTools = teamPrompt('design', { goal, team: { task: '로고' }, files: [], connectors: ['Figma', 'higgsfield'] });
  assert.match(withTools, /Figma, higgsfield/);
  assert.match(withTools, /design\/참고링크\.md/);
  assert.doesNotMatch(teamPrompt('design', { goal, team: { task: '로고' }, files: [] }), /design\/참고링크\.md/);
});

test('the research team searches the web, cites sources and treats pages as data', () => {
  const p = teamPrompt('research', { goal, team: { task: '경쟁 가계부 앱 조사' }, files: [] });
  assert.match(p, /조사팀/);
  assert.match(p, /source/i);
  assert.match(p, /not instructions/);
  assert.match(p, /AGENT_HQ_REPORT/);
  assert.equal(nextStep({ step: 'plan', worker: 'research', reviews: [] }), 'research');
  assert.equal(parsePlan('AGENT_HQ_PLAN {"next_task":"시장 조사","team":"research"}').team, 'research');
  assert.match(teamPrompt('plan', { goal, team: {}, files: [] }), /"research"/);
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

test('every team prompt has the shared structure: identity, common purpose, project, boundaries, then its own sections', () => {
  const sections = ['[AGENT HQ 공통 목적]', '[현재 프로젝트]', '[공통 안전 경계]', '[내 역할 · ', '[현재 작업]',
    '[판단 근거 · 이렇게 한다]', '[협업 요청]', '[안전 경계 · ', '[결과와 한계]', '[출력 형식]'];
  for (const step of Object.keys(TEAMS)) {
    const p = teamPrompt(step, { goal, team: { task: '작업' }, files: ['a.md'], connectors: ['Figma'], candidates: [{ id: 'm', executor: 'codex' }] });
    assert.ok(p.startsWith(`You are ${TEAMS[step].name}`), step);
    let at = -1;
    for (const s of sections) { const i = p.indexOf(s); assert.ok(i > at, `${step}: ${s} in order`); at = i; }
    assert.match(p, /엔진이 확인한 증거와 대장의 승인으로만/);
    assert.equal(p.includes('design/참고링크.md'), step === 'design', `${step}: connectors only for design`);
    assert.equal(p.includes('[검증된 모델 후보'), step === 'plan', `${step}: model candidates only for planning`);
  }
});

test('the prompt says whether the completion criteria are approved, pending or not yet derived', () => {
  const at = (g) => teamPrompt('dev', { goal: g, team: { task: 't' }, files: [] });
  assert.match(at(goal), /완료 조건 · 대장 승인됨/);
  assert.match(at({ ...goal, criteriaApprovalPending: true }), /대장 승인 대기 중 \(아직 효력 없음\)/);
  assert.match(teamPrompt('plan', { goal: { ...goal, completionCriteria: [] }, team: {}, files: [] }), /아직 없음 — 기획팀이 대화에서 도출/);
});
