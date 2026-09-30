import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { lastDue } from '../src/digest.js';

const local = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

test('scheduled times: daily at HH:MM, weekly on the chosen weekday (local time)', () => {
  // 2026-09-29 is a Tuesday
  assert.equal(lastDue('daily', { time: '09:00' }, local(2026, 9, 29, 10)), local(2026, 9, 29, 9));
  assert.equal(lastDue('daily', { time: '09:00' }, local(2026, 9, 29, 8)), local(2026, 9, 28, 9), 'before 9 the due one is yesterday');
  assert.equal(lastDue('weekly', { time: '09:00', weekday: 'mon' }, local(2026, 9, 29, 10)), local(2026, 9, 28, 9));
  assert.equal(lastDue('weekly', { time: '09:00', weekday: 'tue' }, local(2026, 9, 29, 8)), local(2026, 9, 22, 9));
  assert.equal(lastDue('weekly', { time: '09:00', weekday: 'off' }, local(2026, 9, 29, 10)), null);
});

test('the engine writes summaries from its own records, once per scheduled time, without calling a model', async () => {
  let now = local(2026, 9, 29, 8, 0);
  const clock = { now: () => now };
  const calls = [];
  const adapter = { enabled: true, run: async (provider, prompt) => {
    calls.push(prompt.slice(0, 20));
    return { outcome: 'completed', answer: /^You are 기획팀/.test(prompt)
      ? 'AGENT_HQ_PLAN {"next_task":"구현","team":"dev","reviews":[]}' : 'AGENT_HQ_REPORT {"criteria":[]}' };
  } };
  const app = createApp({ root: path.resolve('.'), dataDir: mkdtempSync(path.join(tmpdir(), 'hq-digest-')), projectsDir: mkdtempSync(path.join(tmpdir(), 'hq-digest-p-')), adapter, clock });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  const call = async (method, url, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    app.store.setSetting('permissions.mode', 'careful');
    app.store.setSetting('trust.required', 1);
    const g = (await call('POST', '/api/projects', { title: '가계부', objective: '가계부 앱', completionCriteria: ['c'] })).body;
    await app.scheduler.runGoal(g.id); await app.scheduler.runGoal(g.id); // plan, dev → waits for a result check
    const before = calls.length;

    // 08:00: yesterday's 09:00 was missed while nothing had been written yet → one daily now; Monday's weekly too
    assert.deepEqual(app.digests.tick().map(d => d.kind), ['daily', 'weekly']);
    assert.deepEqual(app.digests.tick(), [], 'nothing twice for the same scheduled time');
    now = local(2026, 9, 29, 9, 1);
    const [daily] = app.digests.tick();
    assert.equal(daily.kind, 'daily');
    assert.match(daily.lines[0], /지난 24시간 동안 실제 단계 2번 \(완료 2 · 문제 0\) · 기획팀 1 · 개발팀 1/);
    assert.match(daily.lines.at(-1), /대장 결정 대기: 프로젝트 1개/);
    assert.deepEqual(daily.projects.map(p => [p.title, p.statusL, p.steps]), [['가계부', '결과 확인 필요 (신뢰 쌓기)', 2]]);
    assert.equal(calls.length, before, 'writing a summary never calls a model');

    // 대장 deletes it: it is gone, and the engine does not write the same scheduled summary again
    assert.equal((await call('DELETE', `/api/digests/${daily.id}`)).status, 200);
    assert.ok(!app.digests.list().some(d => d.id === daily.id));
    now = local(2026, 9, 29, 9, 5);
    assert.deepEqual(app.digests.tick(), [], 'a deleted scheduled summary is not recreated');
    assert.match((await call('DELETE', `/api/digests/${daily.id}`)).body.error, /digest not found/);

    app.store.setSetting('digest.daily', false);
    now = local(2026, 9, 30, 9, 30);
    assert.deepEqual(app.digests.tick(), [], 'daily summaries can be switched off');

    const made = await call('POST', '/api/digests', { kind: 'weekly' });
    assert.equal(made.status, 201);
    assert.match(made.body.lines[0], /^지난 7일 동안/);
    assert.match((await call('POST', '/api/digests', { kind: 'monthly' })).body.error, /unknown digest kind/);
    const list = (await call('GET', '/api/digests')).body;
    assert.equal(list.items[0].id, made.body.id);
    assert.deepEqual(list.schedule, { time: '09:00', daily: false, weekly: 'mon' });
    assert.match((await call('POST', '/api/digests/clear', {})).body.error, /confirm/);
    assert.equal((await call('POST', '/api/digests/clear', { confirm: true })).body.removed, list.items.length);
    assert.deepEqual((await call('GET', '/api/digests')).body.items, []);
  } finally { await app.close(); }
});
