import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/앱.js';
import { BLANK_MARK, SECRETARY_TEMPLATES } from '../src/비서템플릿.js';
import { WEEKDAYS } from '../src/반복작업.js';

async function start() {
  const root = mkdtempSync(path.join(tmpdir(), 'hq-sec-'));
  const app = createApp({ root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects') });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
  return { app, call };
}

test('비서 템플릿: each starter is well formed and stays inside AGENT HQ\'s boundaries', () => {
  assert.equal(new Set(SECRETARY_TEMPLATES.map(t => t.id)).size, SECRETARY_TEMPLATES.length);
  for (const t of SECRETARY_TEMPLATES) {
    assert.ok(t.name && t.summary && t.needs && t.guide && t.objective.length > 40, t.id);
    const r = t.routine;
    assert.ok(['daily', 'weekly', 'files'].includes(r.kind), t.id);
    if (r.kind !== 'files') assert.match(r.time, /^([01]\d|2[0-3]):[0-5]\d$/, t.id);
    if (r.kind === 'weekly') assert.ok(WEEKDAYS.includes(r.weekday), t.id);
    // nothing that sends, posts or buys on 대장's behalf
    assert.doesNotMatch(t.objective, /메일을 보내|보낸다|게시한다|구매한다|결제/, t.id);
  }
});

test('비서 템플릿: starts a conversation project with the name and objective only; the routine waits for 대장', async () => {
  const { app, call } = await start();
  try {
    const listed = (await call('GET', '/api/templates')).body;
    assert.deepEqual(listed.presets.map(t => t.id), SECRETARY_TEMPLATES.map(t => t.id));
    assert.deepEqual(listed.items, [], 'built-in starters are not saved templates');

    const made = await call('POST', '/api/projects', { presetId: 'sec-minutes', conversation: true });
    assert.equal(made.status, 201);
    const g = app.store.getGoal(made.body.id);
    assert.equal(g.title, '회의록 정리');
    assert.match(g.objective, /회의록\.hwpx/);
    assert.deepEqual(g.completionCriteria ?? [], [], 'criteria come from the conversation');
    assert.deepEqual(g.preset, { id: 'sec-minutes', name: '회의록 정리', routine: { kind: 'files' } });
    assert.ok(g.messages.some(m => /비서 템플릿으로 시작 · 회의록 정리/.test(m.text)));
    assert.equal(app.routines.get(g.projectId), null, 'no routine is switched on by the template');

    // a blank left as it is is refused; filled in, it is accepted and 대장's edited objective wins
    assert.match((await call('POST', '/api/projects', { presetId: 'sec-prices', conversation: true })).body.error, /fill in the template blanks/);
    const filled = SECRETARY_TEMPLATES.find(t => t.id === 'sec-prices').objective.replace(/- \(여기에 [^)]*\)/, '- https://example.com/item/1');
    assert.ok(!filled.includes(BLANK_MARK));
    const ok = await call('POST', '/api/projects', { presetId: 'sec-prices', objective: filled, title: '모니터 가격', conversation: true });
    assert.equal(ok.status, 201);
    assert.equal(app.store.getGoal(ok.body.id).title, '모니터 가격');
    assert.match((await call('POST', '/api/projects', { presetId: 'nope' })).body.error, /template not found/);
  } finally { app.server.close(); }
});
