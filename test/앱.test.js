import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/앱.js';
import { request } from 'node:http';

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
test('storage recovery requires confirmation and never resumes goals', async () => {
  const { app, call } = await start();
  try {
    app.store.setSetting('safety.limitStorageFailed', true);
    assert.equal((await call('POST', '/api/safety/limit-storage/recover', {})).status, 400);
    assert.equal(app.store.getSettings()['safety.limitStorageFailed'], true);
    const recovered = await call('POST', '/api/safety/limit-storage/recover', { confirm: true });
    assert.equal(recovered.body.resumed, false);
    assert.equal(app.store.getSettings()['safety.limitStorageFailed'], false);
  } finally { await app.close(); }
});
test('derived criteria require exact explicit approval and cannot be bypassed with resume', async () => {
  const { app, call } = await start();
  try {
    app.scheduler.runner = { run: async () => ({ outcome: 'completed', plan: { completionCriteria: ['README exists'], nextTask: 'implement', team: 'dev' } }) };
    const g = (await call('POST', '/api/goals', { projectId: 'approval', kind: 'team', objective: 'build', conversation: true, completionCriteria: [] })).body;
    await call('POST', `/api/goals/${g.id}/run`, {});
    assert.equal(app.store.getGoal(g.id).reason, 'criteria_approval_required');
    assert.equal((await call('POST', `/api/goals/${g.id}/resume`, {})).status, 400);
    assert.equal((await call('POST', `/api/goals/${g.id}/criteria/approve`, { confirm: true, criteria: ['different'] })).status, 400);
    assert.equal((await call('POST', `/api/goals/${g.id}/criteria/approve`, { confirm: true, criteria: ['README exists'] })).status, 200);
    assert.equal(app.store.getGoal(g.id).criteriaApprovalPending, false);
  } finally { await app.close(); }
});
test('foreign Host, Origin and browser cross-site writes are rejected before mutation', async () => {
  const { app, call } = await start();
  try {
    for (const headers of [
      { host: 'attacker.example', 'content-type': 'application/json' },
      { origin: 'https://attacker.example', 'content-type': 'application/json' },
      { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
    ]) {
      const status = await new Promise((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port: app.server.address().port, path: '/api/goals', method: 'POST', headers }, res => {
          res.resume(); resolve(res.statusCode);
        });
        req.on('error', reject); req.end(JSON.stringify(goalInput));
      });
      assert.equal(status, 403);
    }
    assert.equal(app.store.listGoals().length, 0);
  } finally { await app.close(); }
});
test('API execution safety can be exercised with a fake adapter and blocks unsafe quota/auth', async () => {
  let calls = 0;
  let safe = false;
  const monitor = { snapshot: {}, refreshAuthentication: async () => {
    monitor.snapshot = { claude: { subscription: safe, checkedAt: new Date().toISOString() } };
  } };
  const { app, call } = await start({ enforceSafety: true, monitor,
    usageReader: async () => ({ items: [{ provider: 'claude', stale: false,
      windows: ['five_hour','weekly'].map(period => ({ period, blocked: false, resetAt: new Date(Date.now() + 3600000).toISOString() })) }] }),
    adapter: { enabled: true, run: async () => { calls++; return { outcome: 'completed', model: null, answer: '' }; } } });
  try {
    const g = (await call('POST', '/api/goals', goalInput)).body;
    await call('POST', `/api/goals/${g.id}/run`, {});
    assert.equal(calls, 0, 'unconfirmed subscription must stop before fake adapter dispatch');
    assert.equal(app.store.getGoal(g.id).status, 'model_wait');
    safe = true;
    await call('POST', `/api/goals/${g.id}/run`, {});
    assert.equal(calls, 1, 'fresh confirmed subscription and quota allow dispatch');
  } finally { await app.close(); }
});
test('model registration is pending, explicit official-account attestation enables it and edits revoke it', async () => {
  const { app, call } = await start();
  try {
    const profile = { executor: 'codex', id: 'test-model', label: 'Test', tier: 1, efforts: ['medium'], capabilities: ['text','code'],
      usable: true, accountCheckedAt: 'fake', supportEvidence: { url: 'fake', checkedAt: 'fake' } };
    assert.equal((await call('POST', '/api/models', profile)).status, 201);
    assert.equal((await call('GET', '/api/models')).body.items[0].usable, false);
    const attestation = { executor: 'codex', id: profile.id, confirm: true, source: 'manual_official_ui',
      supportUrl: 'https://learn.chatgpt.com/docs/models', note: 'Account model selector confirmed manually' };
    assert.equal((await call('POST', '/api/models/attest', { ...attestation, supportUrl: 'https://example.org/fake' })).status, 400);
    assert.equal((await call('POST', '/api/models/attest', { ...attestation, confirm: false })).status, 400);
    assert.equal((await call('POST', '/api/models/attest', attestation)).body.usable, true);
    await call('POST', '/api/models', profile);
    assert.equal((await call('GET', '/api/models')).body.items[0].usable, false);
  } finally { await app.close(); }
});
test('record drafts and opt-in autonomy are exposed without making external writes', async () => {
  const { app, call } = await start();
  try {
    const { body: g } = await call('POST', '/api/projects', { objective: 'PRIVATE REQUIREMENT', conversation: true });
    const record = await call('GET', `/api/projects/${g.projectId}/records`);
    assert.equal(record.status, 200);
    assert.equal(record.body.externalSync, 'not_connected');
    assert.doesNotMatch(JSON.stringify({ markdown: record.body.markdown, github: record.body.github, snapshot: record.body.snapshot }), /PRIVATE REQUIREMENT/);
    assert.match(record.body.notionMarkdown, /PRIVATE REQUIREMENT/);
    assert.equal((await call('PUT', `/api/goals/${g.id}/autonomy`, { enabled: true, remaining: 2 })).body.autonomy.remaining, 2);
    assert.equal((await call('PUT', `/api/goals/${g.id}/autonomy`, { enabled: true, remaining: 10 })).status, 400);
  } finally { await app.close(); }
});

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
  const folder = app.workspaces.resolve('research-hub');
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
  const folder = app.workspaces.resolve('research-hub');
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
  assert.equal(path.basename(app.workspaces.resolve(created.body.projectId)), '가계부');
  const view = (await call('GET', '/api/engine')).body;
  assert.equal(view.projects.find(p => p.id === created.body.projectId).workspacePath, 'projects/가계부');
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

test('environments show connection status; design connectors turn on only by a valid setting and reach the design team only', async (t) => {
  const seen = [];
  const adapter = { enabled: true, run: async (provider, prompt, onEvent, opts) => {
    seen.push({ who: /^You are (\S+)/.exec(prompt)?.[1], connectors: opts.connectors, known: opts.knownConnectors });
    return { outcome: 'completed', answer: 'AGENT_HQ_PLAN {"next_task":"로고 시안","team":"design","reviews":[]}' };
  } };
  const monitor = { snapshot: { checkedAt: 'x', claude: { installed: true, loggedIn: true }, codex: { installed: true, loggedIn: true },
    connectors: [{ name: 'Figma', status: 'connected' }, { name: 'Gmail', status: 'connected' }], apiKeys: {} }, refresh: async () => monitor.snapshot };
  const { app, call } = await start({ adapter, monitor });
  t.after(() => app.close());
  const env = (await call('GET', '/api/environments')).body;
  assert.equal(env.items.find(i => i.id === 'figma').statusL, '연결됨 · 꺼짐');
  assert.equal((await call('PUT', '/api/settings', { key: 'design.figma', value: 'yes' })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { key: 'admin.all', value: true })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { key: 'design.figma', value: true })).status, 200);
  assert.equal((await call('GET', '/api/environments')).body.items.find(i => i.id === 'figma').statusL, '연결됨 · 디자인팀 사용');
  const { body: g } = await call('POST', '/api/projects', { objective: '로고', completionCriteria: ['logo.svg 파일이 있다'] });
  await call('POST', `/api/goals/${g.id}/run`, {});   // planning team
  await call('POST', `/api/goals/${g.id}/run`, {});   // design team
  assert.deepEqual(seen.map(s => [s.who, s.connectors]), [['기획팀', []], ['디자인팀', ['Figma']]]);
  assert.deepEqual(seen[1].known, ['Figma', 'Gmail'], 'the rest of the connectors are passed so they can be denied');
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

test('each team picks a named model and reasoning level from the official list; unpicked teams run the named default', async () => {
  const { ModelChoices } = await import('../src/모델선택.js');
  const codexList = [{ id: 'gpt-6-astra', label: 'GPT-6-Astra', isDefault: true, efforts: ['low', 'medium', 'high', 'ultra'], defaultEffort: 'low' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', isDefault: false, efforts: ['low', 'medium'], defaultEffort: 'low' },
    { id: 'gpt-5.5', label: 'GPT-5.5', isDefault: false, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }];
  const modelChoices = new ModelChoices({ readCodex: async () => codexList });
  const { app, call } = await start({ modelChoices });
  try {
    const choices = (await call('GET', '/api/model-choices')).body;
    assert.deepEqual(choices['claude-code'].models.map(m => m.label), ['Fable 5.1', 'Opus 5.5', 'Sonnet 5.5']);
    assert.deepEqual(choices['claude-code'].models.map(m => m.id), ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5']);
    assert.equal(choices['claude-code'].defaultModel, 'claude-opus-5-5');
    assert.deepEqual(choices.codex.models.map(m => m.id), ['gpt-6-astra', 'gpt-5.5'], 'the GPT-5.6 family is not offered');
    assert.equal(choices.codex.defaultModel, 'gpt-6-astra');
    const g = (await call('POST', '/api/projects', { objective: '가계부', completionCriteria: ['a.md 있음'] })).body;
    const put = teamModel => call('PUT', `/api/projects/${g.projectId}/model-policy`, { teamModel });
    assert.equal((await put({ team: 'plan', model: 'claude-fable-5-1', effort: 'max' })).status, 200);
    assert.equal((await put({ team: 'qa', model: 'gpt-5.5', effort: 'medium' })).status, 200);
    assert.match((await put({ team: 'qa', model: 'gpt-5.5', effort: 'ultra' })).body.error, /not offered/, 'ultra is not offered for GPT-5.5');
    assert.match((await put({ team: 'qa', model: 'gpt-5.6-sol' })).body.error, /not offered/, 'hidden models cannot be picked');
    assert.match((await put({ team: 'plan', model: 'gpt-5.5' })).body.error, /not offered by claude-code/, 'a Codex model cannot go to a Claude team');
    assert.match((await put({ team: 'dev', model: 'opus' })).body.error, /not offered/, 'aliases are not accepted, only exact models');
    assert.match((await put({ team: 'marketing', model: 'claude-opus-5-5' })).body.error, /unknown team/);
    const status = () => app.scheduler.modelStatus(g.id);
    assert.deepEqual([status().next, status().nextEffort, status().reason], ['claude-fable-5-1', 'max', 'team_choice'], 'planning uses its pick');
    app.scheduler.update(app.store.getGoal(g.id), { team: { ...app.store.getGoal(g.id).team, step: 'dev' } });
    assert.deepEqual([status().nextState, status().next, status().nextEffort, status().reason], ['ready', 'claude-sonnet-5-5', 'xhigh', 'auto_level'],
      '제어팀: an unpicked team gets a model sized to the work, by its full ID');
    app.store.setSetting('models.auto', false);
    assert.deepEqual([status().nextState, status().next, status().nextEffort], ['ready', 'claude-opus-5-5', null],
      'with automatic levels off, an unpicked Claude team runs Opus 5.5 by its full ID, never an unnamed CLI default');
    app.store.setSetting('models.auto', true);
    assert.equal((await put({ team: 'dev', model: '', effort: 'high' })).status, 200, 'a reasoning level alone applies to the default model');
    assert.deepEqual([status().next, status().nextEffort], ['claude-opus-5-5', 'high']);
    assert.equal((await put({ team: 'plan', model: '', effort: '' })).status, 200);
    assert.equal(app.registry.getPolicy(`project:${g.projectId}`).teamModels.plan, undefined, 'clearing returns the team to the named default');
    const conv = (await call('POST', '/api/projects', { objective: '대화로 시작', conversation: true })).body;
    assert.equal(app.registry.getPolicy(`project:${conv.projectId}`).strategy, undefined, 'new projects are not put in a wait-for-profile mode');
  } finally { await app.close(); }
});

test('the daily step limit is a setting (default 10); raising it lets waiting projects continue today', async () => {
  const { app, call } = await start();
  try {
    assert.equal((await call('GET', '/api/engine')).body.limits.maxRoundsPerDay, 10, 'default stays 10');
    const g = (await call('POST', '/api/goals', { ...goalInput, kind: 'team' })).body;
    app.scheduler.update(app.store.getGoal(g.id), { reason: 'daily_cap', nextRunAt: new Date(Date.now() + 8 * 3600000).toISOString() });
    assert.equal((await call('PUT', '/api/settings', { key: 'limits.maxRoundsPerDay', value: 0 })).status, 400);
    assert.equal((await call('PUT', '/api/settings', { key: 'limits.maxRoundsPerDay', value: 20 })).status, 200);
    assert.equal((await call('GET', '/api/engine')).body.limits.maxRoundsPerDay, 20);
    assert.equal(app.scheduler.dailyLimit(), 20);
    const after = app.store.getGoal(g.id);
    assert.equal(after.reason, null);
    assert.ok(Date.parse(after.nextRunAt) <= Date.now(), 'held projects are re-checked right away');
  } finally { await app.close(); }
});
test('the limit-storage safety stop lifts itself once the record checks out and no step runs, but not twice in 10 minutes', async () => {
  const { app, clock } = await start();
  try {
    const s = () => app.store.getSettings();
    app.store.setSetting('safety.limitStorageFailed', true);
    app.store.setSetting('safety.limitStorageFailedAt', new Date(clock.now()).toISOString());
    await app.autoRecoverLimitStorage();
    assert.equal(s()['safety.limitStorageFailed'], false);
    assert.ok(s()['safety.limitAutoRecoveredAt']);
    // fails again 3 minutes later: a real fault, 대장 recovers it
    clock.t += 3 * 60_000;
    app.store.setSetting('safety.limitStorageFailed', true);
    app.store.setSetting('safety.limitStorageFailedAt', new Date(clock.now()).toISOString());
    await app.autoRecoverLimitStorage();
    assert.equal(s()['safety.limitStorageFailed'], true);
    // (that stays for 대장 however long it waits) — from a clean state, a step still running also keeps it
    clock.t += 60 * 60_000;
    app.store.deleteSetting('safety.limitAutoRecoveredAt');
    const g = app.scheduler.addGoal({ projectId: 'run', kind: 'team', objective: 'x', completionCriteria: ['a'] });
    app.scheduler.update(g, { status: 'running' });
    await app.autoRecoverLimitStorage();
    assert.equal(s()['safety.limitStorageFailed'], true);
    app.scheduler.update(app.store.getGoal(g.id), { status: 'scheduled' });
    await app.autoRecoverLimitStorage();
    assert.equal(s()['safety.limitStorageFailed'], false);
  } finally { await app.close(); }
});
