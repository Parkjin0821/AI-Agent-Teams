import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';

const T0 = Date.parse('2026-09-28T00:00:00Z');

async function start(options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'hq-app-'));
  const clock = { t: T0, now() { return this.t; } };
  const app = createApp({ root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects'), clock, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body, headers = { 'content-type': 'application/json' }) => {
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { app, clock, call };
}
const goalInput = { projectId: 'research-hub', title: '리서치 허브', kind: 'research', objective: '자료 요약 웹앱', completionCriteria: ['E2E 통과', '요약 적합률 90%'] };

test('writes require a JSON content type (blocks simple cross-site posts)', async () => {
  const { app, call } = await start();
  const res = await call('POST', '/api/goals', goalInput, { 'content-type': 'text/plain' });
  assert.equal(res.status, 415);
  await app.close();
});

test('a goal created through the API shows up in the engine view', async () => {
  const { app, call } = await start();
  const created = await call('POST', '/api/goals', goalInput);
  assert.equal(created.status, 201);
  const view = (await call('GET', '/api/engine')).body;
  assert.equal(view.mode, 'simulation');
  const project = view.projects.find(p => p.id === 'research-hub');
  assert.equal(project.policy.version, 0);
  assert.equal(project.goals[0].title, '리서치 허브');
  assert.deepEqual(project.goals[0].completionCriteria, ['E2E 통과', '요약 적합률 90%']);
  assert.equal(project.goals[0].model.requested, null);
  assert.equal((await call('POST', '/api/goals', { ...goalInput, completionCriteria: [] })).status, 400);
  await app.close();
});

test('a tick runs a simulated round that is recorded as simulated and verifies nothing', async () => {
  const { app, call } = await start();
  const { body: goal } = await call('POST', '/api/goals', goalInput);
  const { body: view } = await call('POST', '/api/engine/tick', {});
  const g = view.projects[0].goals.find(x => x.id === goal.id);
  assert.equal(g.runs.length, 1);
  assert.equal(g.runs[0].simulated, true);
  assert.equal(g.runs[0].actualModel, null);
  assert.equal(g.status, 'scheduled');
  assert.deepEqual(g.evidence, []);
  assert.ok(view.events.some(e => e.type === 'goal.run_started' && e.goalId === goal.id));
  await app.close();
});

test('model policy changes are versioned and an unavailable pinned model makes the goal wait', async () => {
  const { app, clock, call } = await start();
  await call('POST', '/api/goals', goalInput);
  const put = await call('PUT', '/api/projects/research-hub/model-policy', { mode: 'pinned', model: 'unverified-model', allowFallback: false });
  assert.equal(put.status, 200);
  assert.equal(put.body.version, 1);
  assert.equal((await call('PUT', '/api/projects/research-hub/model-policy', { mode: 'best' })).status, 400);
  clock.t += 60_000;
  const { body: view } = await call('POST', '/api/engine/tick', {});
  const g = view.projects[0].goals[0];
  assert.equal(g.status, 'model_wait');
  assert.equal(g.reason, 'pinned_model_unavailable');
  assert.equal(view.projects[0].policy.mode, 'pinned');
  await app.close();
});

// Never a real CLI in tests: a fake adapter that reports as "enabled" stands in for real execution.
function fakeExecAdapter(calls) {
  return { enabled: true, run: async (provider) => { calls.push(provider); return { outcome: 'completed', model: 'fake-model' }; } };
}

test('with real execution on, nothing runs automatically; only an explicit single-goal run', async (t) => {
  const calls = [];
  const { app, call } = await start({ adapter: fakeExecAdapter(calls), tickMs: 20 });
  t.after(() => app.close());
  const { body: a } = await call('POST', '/api/goals', goalInput);
  const { body: b } = await call('POST', '/api/goals', { ...goalInput, projectId: 'other' });
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(calls.length, 0, 'no automatic tick while real execution is on');
  let view = (await call('GET', '/api/engine')).body;
  assert.equal(view.mode, 'execution');
  assert.equal(view.autoScope, 'started', 'with real execution only projects 대장 started run by themselves');
  assert.equal((await call('POST', '/api/engine/tick', {})).status, 400, 'no bulk run while real execution is on');
  assert.equal(calls.length, 0);
  const res = await call('POST', `/api/goals/${a.id}/run`, {});
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ['claude']);
  view = res.body;
  const ga = view.projects.find(p => p.id === 'research-hub').goals[0];
  assert.equal(ga.runs.length, 1);
  assert.equal(ga.runs[0].simulated, false);
  assert.equal(ga.activeModel, 'fake-model');
  assert.equal(view.projects.find(p => p.id === 'other').goals[0].runs.length, 0);
  assert.equal((await call('POST', `/api/goals/${b.id}/pause`, {})).status, 200);
  assert.equal((await call('POST', `/api/goals/${b.id}/run`, {})).status, 400);
});

test('a one-off task stops for 대장 after one round and can be confirmed as done', async (t) => {
  const calls = [];
  const { app, call } = await start({ adapter: fakeExecAdapter(calls) });
  t.after(() => app.close());
  const { body: goal } = await call('POST', '/api/goals', { ...goalInput, kind: 'task', completionCriteria: ['결과를 보여준다'] });
  const view = (await call('POST', `/api/goals/${goal.id}/run`, {})).body;
  const g = view.projects[0].goals[0];
  assert.deepEqual([g.status, g.reason, g.nextRunAt], ['review_required', 'awaiting_review', null]);
  assert.equal((await call('POST', `/api/goals/${goal.id}/confirm`, { criterion: '없는 조건' })).status, 400);
  const done = await call('POST', `/api/goals/${goal.id}/confirm`, { criterion: '결과를 보여준다', note: '화면에서 확인' });
  assert.equal(done.body.status, 'verified');
  assert.equal(calls.length, 1);
});

test('deleting a project removes its goals, runs, logs and policy; files stay unless asked', async (t) => {
  const { app, call } = await start();
  t.after(() => app.close());
  const { body: goal } = await call('POST', '/api/goals', goalInput);
  await call('POST', '/api/goals', { ...goalInput, projectId: 'keep-me' });
  await call('POST', '/api/engine/tick', {});
  await call('PUT', '/api/projects/research-hub/model-policy', { mode: 'pinned', model: 'x' });
  const folder = path.join(app.workspaces.root, 'research-hub');
  writeFileSync(path.join(folder, 'result.md'), 'made by AI');
  assert.equal((await call('DELETE', '/api/projects/research-hub', {}, { 'content-type': 'text/plain' })).status, 415);
  const res = await call('DELETE', '/api/projects/research-hub', {});
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.goals, res.body.runs, res.body.filesDeleted], [1, 1, false]);
  const view = (await call('GET', '/api/engine')).body;
  assert.deepEqual(view.projects.map(p => p.id), ['keep-me']);
  assert.ok(!view.events.some(e => e.goalId === goal.id));
  assert.equal(app.registry.history('project:research-hub').length, 0);
  assert.ok(existsSync(path.join(folder, 'result.md')), 'files are kept by default');
  assert.equal((await call('DELETE', '/api/projects/research-hub', {})).status, 400, 'already gone');
});

test('deleting with deleteFiles also removes the workspace folder; a running project cannot be deleted', async (t) => {
  let release;
  const adapter = { enabled: true, run: () => new Promise(resolve => { release = () => resolve({ outcome: 'completed' }); }) };
  const { app, call } = await start({ adapter });
  t.after(() => app.close());
  const { body: goal } = await call('POST', '/api/goals', { ...goalInput, kind: 'task' });
  const running = call('POST', `/api/goals/${goal.id}/run`, {});
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await call('DELETE', '/api/projects/research-hub', { deleteFiles: true })).status, 400);
  release(); await running;
  const folder = path.join(app.workspaces.root, 'research-hub');
  writeFileSync(path.join(folder, 'a.txt'), 'x');
  const res = await call('DELETE', '/api/projects/research-hub', { deleteFiles: true });
  assert.equal(res.body.filesDeleted, true);
  assert.equal(existsSync(folder), false);
});

test('a new project needs no ID: the engine makes one and the team starts only when told', async (t) => {
  const calls = [];
  const adapter = { enabled: true, run: async (provider) => { calls.push(provider);
    return { outcome: 'completed', answer: 'AGENT_HQ_PLAN {"next_task":"README 작성","needs_decision":null,"all_done":false}' }; } };
  const { app, call } = await start({ adapter, tickMs: 20 });
  t.after(() => app.close());
  const created = await call('POST', '/api/projects', { title: '가계부', objective: '가계부 앱', completionCriteria: ['index.html 파일이 있다'] });
  assert.equal(created.status, 201);
  assert.match(created.body.projectId, /^p-[a-z0-9]+$/);
  assert.deepEqual([created.body.kind, created.body.autoRun], ['team', false]);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(calls.length, 0, 'not started, nothing runs');
  assert.equal((await call('POST', `/api/goals/${created.body.id}/start`, {})).status, 200);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok(calls.length >= 1, 'a started team project runs on its own');
  assert.equal(calls[0], 'claude', 'planning team first');
  await call('POST', `/api/goals/${created.body.id}/stop`, {});
  await new Promise(resolve => setTimeout(resolve, 100));
  const stoppedAt = calls.length;
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(calls.length, stoppedAt, 'stopped means no new rounds');
  assert.equal((await call('POST', `/api/goals/${created.body.id}/answer`, { text: 'x' })).status, 400);
  assert.equal((await call('POST', `/api/goals/${created.body.id}/proposal/accept`, {})).status, 400);
});

test('in simulation mode the automatic tick stays on', async (t) => {
  const { app, call } = await start({ tickMs: 20 });
  t.after(() => app.close());
  await call('POST', '/api/goals', goalInput);
  await new Promise(resolve => setTimeout(resolve, 150));
  const view = (await call('GET', '/api/engine')).body;
  assert.equal(view.autoTick, true);
  assert.equal(view.projects[0].goals[0].runs.length, 1);
  assert.equal(view.projects[0].goals[0].runs[0].simulated, true);
});

test('pause and resume through the API', async () => {
  const { app, call } = await start();
  const { body: goal } = await call('POST', '/api/goals', goalInput);
  assert.equal((await call('POST', `/api/goals/${goal.id}/pause`, {})).body.status, 'paused');
  const { body: view } = await call('POST', '/api/engine/tick', {});
  assert.equal(view.projects[0].goals[0].runs.length, 0);
  assert.equal((await call('POST', `/api/goals/${goal.id}/resume`, {})).body.status, 'scheduled');
  assert.equal((await call('POST', '/api/goals/nope/pause', {})).status, 400);
  await app.close();
});
