import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGoalRunner } from '../src/goal-runner.js';
import { ProjectWorkspaces } from '../src/workspaces.js';

const goal = { id: 'g1', projectId: 'hello', objective: 'README를 쓴다', completionCriteria: ['README.md 파일이 있다', '팀 회의를 한다'] };
const store = { emit: async () => {} };

function runnerWith(adapterRun) {
  const workspaces = new ProjectWorkspaces(mkdtempSync(path.join(tmpdir(), 'hq-gr-')));
  let prompt = '';
  const adapter = { enabled: true, run: async (provider, p, onEvent, opts) => { prompt = p; return adapterRun(opts.cwd); } };
  return { runner: createGoalRunner({ adapter, workspaces, store }), getPrompt: () => prompt };
}

test('the prompt asks for a checkable report on every criterion', async () => {
  const { runner, getPrompt } = runnerWith(() => ({ outcome: 'completed', answer: '' }));
  await runner.run(goal, { executor: 'claude-code', model: null });
  assert.match(getPrompt(), /README를 쓴다/);
  assert.match(getPrompt(), /1\. README\.md 파일이 있다/);
  assert.match(getPrompt(), /AGENT_HQ_REPORT/);
});

test('after a real run the engine checks the report itself and returns evidence, claims, answer and a diff hash', async () => {
  const { runner } = runnerWith((cwd) => {
    writeFileSync(path.join(cwd, 'README.md'), 'hello');
    return { outcome: 'completed', model: 'm', answer: 'README를 만들었습니다.\nAGENT_HQ_REPORT\n{"criteria":[{"index":1,"done":true,"check":{"type":"file_exists","path":"README.md"}},{"index":2,"done":false,"check":null,"note":"사람이 해야 함"}]}' };
  });
  const result = await runner.run(goal, { executor: 'claude-code', model: null });
  assert.deepEqual(result.evidence.map(e => e.criterion), ['README.md 파일이 있다']);
  assert.deepEqual(result.claims.map(c => c.check), ['pass', 'none']);
  assert.match(result.answer, /README를 만들었습니다/);
  assert.equal(result.model, 'm');
  assert.equal(typeof result.diffHash, 'string');
});

test('a claim of "done" with a check that fails is not evidence', async () => {
  const { runner } = runnerWith(() => ({ outcome: 'completed', answer: 'AGENT_HQ_REPORT {"criteria":[{"index":1,"done":true,"check":{"type":"file_exists","path":"README.md"}}]}' }));
  const result = await runner.run(goal, { executor: 'claude-code', model: null });
  assert.equal(result.evidence.length, 0);
  assert.equal(result.claims[0].check, 'fail');
  assert.equal(result.diffHash, null, 'empty workspace has no fingerprint');
});

const teamGoal = { ...goal, kind: 'team', team: { step: 'plan', task: '', feedback: '', cycle: 1 } };

test('team rounds use the team prompt and access, and return the parsed plan', async () => {
  let seen;
  const workspaces = new ProjectWorkspaces(mkdtempSync(path.join(tmpdir(), 'hq-gr-')));
  writeFileSync(path.join(workspaces.resolve('hello'), 'notes.md'), 'x');
  const adapter = { enabled: true, run: async (provider, prompt, onEvent, opts) => {
    seen = { provider, prompt, access: opts.access };
    return { outcome: 'completed', answer: '계획\nAGENT_HQ_PLAN\n{"next_task":"README 작성","needs_decision":null,"all_done":false}' };
  } };
  const result = await createGoalRunner({ adapter, workspaces, store }).run(teamGoal, { executor: 'claude-code', team: 'plan', access: 'read', model: null });
  assert.deepEqual([seen.provider, seen.access], ['claude', 'read']);
  assert.match(seen.prompt, /기획팀/);
  assert.match(seen.prompt, /notes\.md/);
  assert.deepEqual(result.plan, { nextTask: 'README 작성', team: 'dev', reviews: [], needsDecision: null, allDone: false });
  assert.equal(result.evidence.length, 0);
});

test('review teams run read-only and return the parsed review, never evidence', async () => {
  let seen;
  const workspaces = new ProjectWorkspaces(mkdtempSync(path.join(tmpdir(), 'hq-gr-')));
  const adapter = { enabled: true, run: async (provider, prompt, onEvent, opts) => {
    seen = { provider, prompt, access: opts.access };
    return { outcome: 'completed', answer: '검토했습니다.\nAGENT_HQ_REVIEW {"verdict":"issues","issues":["비밀번호 평문 저장"],"blocking":true,"needs_decision":null}' };
  } };
  const g = { ...teamGoal, team: { ...teamGoal.team, step: 'security', task: '로그인' } };
  const result = await createGoalRunner({ adapter, workspaces, store }).run(g, { executor: 'codex', team: 'security', access: 'read', model: null });
  assert.deepEqual([seen.provider, seen.access], ['codex', 'read']);
  assert.match(seen.prompt, /보안팀/);
  assert.deepEqual(result.review, { verdict: 'issues', issues: ['비밀번호 평문 저장'], blocking: true, needsDecision: null });
  assert.equal(result.evidence.length, 0);
});

test('the verification team returns engine-checked evidence plus feedback and improvements', async () => {
  const { runner } = runnerWith((cwd) => {
    writeFileSync(path.join(cwd, 'README.md'), 'hello');
    return { outcome: 'completed', answer: 'AGENT_HQ_REPORT\n{"criteria":[{"index":1,"done":true,"check":{"type":"file_exists","path":"README.md"}}],"feedback":"회의 조건 미충족","improvements":["목차 추가"]}' };
  });
  const result = await runner.run({ ...teamGoal, team: { ...teamGoal.team, step: 'qa' } }, { executor: 'codex', team: 'qa', access: 'write', model: null });
  assert.deepEqual(result.evidence.map(e => e.criterion), ['README.md 파일이 있다']);
  assert.deepEqual(result.findings, { feedback: '회의 조건 미충족', improvements: ['목차 추가'] });
});

test('simulation still produces no evidence', async () => {
  const { runner } = runnerWith(() => ({ outcome: 'simulated' }));
  const result = await runner.run(goal, { executor: 'codex', model: null });
  assert.deepEqual([result.outcome, result.simulated, result.evidence.length], ['completed', true, 0]);
});
