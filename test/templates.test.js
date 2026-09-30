import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { FRESH_CRITERION } from '../src/routines.js';

async function start() {
  const root = mkdtempSync(path.join(tmpdir(), 'hq-tpl-'));
  const app = createApp({ root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects') });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
  return { app, call };
}

test('템플릿: a finished project\'s recipe (objective, criteria, team model picks) starts a new project with new input', async () => {
  const { app, call } = await start();
  try {
    const g = app.scheduler.addGoal({ projectId: 'p-price', kind: 'team', title: '노트북 가격 조사', objective: '노트북 3종의 가격을 조사한다\n\n[반복 실행 2회차 · 2026. 9. 28. 09:00] …',
      completionCriteria: ['research.md에 3종 가격이 있다', FRESH_CRITERION] });
    app.scheduler.update(app.store.getGoal(g.id), { status: 'verified' });
    app.registry.setPolicy('project:p-price', { teamModels: { research: { executor: 'claude-code', model: 'claude-opus-5-5', effort: 'high' } } }, { by: '대장', reason: 'test' });
    const saved = await call('POST', '/api/templates', { projectId: 'p-price', name: '가격 조사' });
    assert.equal(saved.status, 201);
    assert.deepEqual([saved.body.objective, saved.body.completionCriteria], ['노트북 3종의 가격을 조사한다', ['research.md에 3종 가격이 있다']], 'routine notes are not part of the recipe');
    assert.deepEqual((await call('GET', '/api/templates')).body.items.map(t => t.name), ['가격 조사']);

    const made = await call('POST', '/api/projects', { templateId: saved.body.id, objective: '모니터 3종의 가격을 조사한다', completionCriteria: ['research.md에 모니터 3종 가격이 있다'] });
    assert.equal(made.status, 201);
    const goal = app.store.getGoal(made.body.id);
    assert.deepEqual([goal.title, goal.objective, goal.completionCriteria, goal.criteriaApprovalPending ?? false],
      ['가격 조사', '모니터 3종의 가격을 조사한다', ['research.md에 모니터 3종 가격이 있다'], false], '대장\'s edits win; criteria need no second approval');
    assert.equal(app.registry.getPolicy(`project:${goal.projectId}`).teamModels.research.model, 'claude-opus-5-5', 'team model picks come along');
    assert.match(goal.messages.at(-1).text, /템플릿으로 시작 · 가격 조사/);
    assert.equal(app.templates.get(saved.body.id).used, 1);

    const plain = await call('POST', '/api/projects', { templateId: saved.body.id });
    assert.deepEqual(app.store.getGoal(plain.body.id).completionCriteria, ['research.md에 3종 가격이 있다'], 'without edits the recipe is used as is');
    assert.match((await call('POST', '/api/projects', { templateId: '00000000-0000-4000-8000-000000000000' })).body.error, /template not found/);
    assert.equal((await call('DELETE', `/api/templates/${saved.body.id}`)).status, 200);
    assert.deepEqual((await call('GET', '/api/templates')).body.items, []);
  } finally { await app.close(); }
});

test('a project without approved criteria cannot become a template', async () => {
  const { app, call } = await start();
  try {
    app.scheduler.addGoal({ projectId: 'p-new', kind: 'team', objective: '아직 대화 중', conversation: true, completionCriteria: [] });
    assert.match((await call('POST', '/api/templates', { projectId: 'p-new' })).body.error, /completion criteria/);
    assert.equal((await call('POST', '/api/templates', { projectId: 'nope' })).status >= 400, true);
  } finally { await app.close(); }
});
